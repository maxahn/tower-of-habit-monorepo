import type { BlockRosterMember } from '../schemas/index.js';
import type { LocalDate } from '../time/local-date.js';
import { MIN_BLOCK_DAYS } from '../evaluator/recompute.js';
import type { BlockRecord, MembershipRecord, ScenarioPlan } from './plan.js';

// Owned by the evaluator; re-exported so existing testing imports keep working.
export { MIN_BLOCK_DAYS };

/**
 * PROVISIONAL projection of the evaluator-owned state from a plan's inputs
 * (members, periods, entries), so a scenario can be persisted looking as if
 * the evaluator had run over it.
 *
 * NOT THE SOURCE OF TRUTH. The 3.x evaluator is, and the 1.12 recompute
 * (verifyTowerState in @tower-of-habit/shared/evaluator) is its oracle. Until
 * the evaluator lands this stays the fixture, and scenario tests assert that
 * recompute agrees with it. Keep the two INDEPENDENT: if this called recompute
 * for height and blocks, that agreement would hold by construction and test
 * nothing. Every rule below is the
 * reading of the schema comments as they stand, in one place, so a correction
 * is a one-file change:
 *
 *   - A period is evaluated iff its evaluate_at <= plan.now; later ones stay
 *     pending, untouched.
 *   - A live (non-dormant) member qualifies for a period iff it has a
 *     qualifying entry dated period_start. Daily towers only.
 *   - Qualifying resets consecutive_missed_periods and returns at_risk to active.
 *   - §6 ladder, per member: miss #1 -> at_risk, and the TOWER COLLAPSES;
 *     miss #2 -> dormant (consecutive_miss) INSTEAD of collapsing.
 *   - Outcome: collapsed if any member hit miss #1; otherwise hibernated if no
 *     live member remains; otherwise survived.
 *   - survived: height and current_streak + 1, and the period joins the run.
 *     collapsed: the run closes (a block if >= MIN_BLOCK_DAYS) and both reset
 *     to 0. hibernated: neither moves; the run is paused, not closed.
 *   - height == current_streak under v1 daily rules.
 *   - Dormant members stay dormant: returning is a user action, not a log.
 *
 * Mutates the plan's records in place and returns the plan.
 */
export function deriveTowerState(plan: ScenarioPlan): ScenarioPlan {
  const { tower } = plan;
  if (!tower) return plan;

  const qualifying = new Map<string, { tier: number }>();
  for (const e of plan.entries) {
    if (e.countsTowardQuota) qualifying.set(`${e.habitId}|${e.localDate}`, { tier: e.tierReached });
  }
  const displayName = new Map(plan.users.map((u) => [u.id, u.displayName]));

  type RunStats = { qualifyingDays: number; totalDays: number; highestTier: number };
  const runStats = new Map<MembershipRecord, RunStats>();
  const resetRun = () => {
    for (const m of plan.memberships) {
      runStats.set(m, { qualifyingDays: 0, totalDays: 0, highestTier: 0 });
    }
  };

  for (const m of plan.memberships) {
    m.state = 'active';
    m.consecutiveMissedPeriods = 0;
    m.lastQualifyingDate = null;
    m.dormantSince = null;
    m.dormancyReason = null;
  }
  resetRun();
  plan.blocks = [];

  let height = 0;
  // A holder rather than `let run = null`: TS narrows a let to null across the
  // closure below and loses the assignments inside it.
  const run: { start: LocalDate | null; end: LocalDate | null } = { start: null, end: null };

  const closeRun = () => {
    if (run.start && run.end && height >= MIN_BLOCK_DAYS) {
      const roster: BlockRosterMember[] = plan.memberships
        .filter((m) => runStats.get(m)!.totalDays > 0)
        .map((m) => {
          const s = runStats.get(m)!;
          return {
            user_id: m.userId,
            display_name: displayName.get(m.userId) ?? 'Member',
            qualifying_days: s.qualifyingDays,
            total_days: s.totalDays,
            highest_tier: s.highestTier,
            was_dormant: m.state === 'dormant',
          };
        });
      const block: BlockRecord = {
        towerId: tower.id,
        runStartDate: run.start,
        runEndDate: run.end,
        blockHeight: height,
        roster,
      };
      plan.blocks.push(block);
    }
    run.start = null;
    run.end = null;
    height = 0;
    resetRun();
  };

  const periods = [...plan.periods].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  for (const p of periods) {
    if (p.evaluateAt.getTime() > plan.now.getTime()) {
      p.state = 'pending';
      p.outcome = null;
      p.evaluatedAt = null;
      p.claimedAt = null;
      p.attempts = 0;
      continue;
    }

    let collapsed = false;
    const contributions: { m: MembershipRecord; qualified: boolean; tier: number }[] = [];
    for (const m of plan.memberships) {
      if (m.state === 'dormant' || m.state === 'removed') continue;
      const hit = qualifying.get(`${m.habitId}|${p.periodStart}`);
      contributions.push({ m, qualified: hit !== undefined, tier: hit?.tier ?? 0 });
      if (hit) {
        m.consecutiveMissedPeriods = 0;
        m.lastQualifyingDate = p.periodStart;
        if (m.state === 'at_risk') m.state = 'active';
        continue;
      }
      m.consecutiveMissedPeriods += 1;
      if (m.consecutiveMissedPeriods === 1) {
        m.state = 'at_risk';
        collapsed = true;
      } else {
        m.state = 'dormant';
        m.dormantSince = p.evaluateAt;
        m.dormancyReason = 'consecutive_miss';
      }
    }

    const anyLive = plan.memberships.some((m) => m.state === 'active' || m.state === 'at_risk');
    const outcome = collapsed ? 'collapsed' : anyLive ? 'survived' : 'hibernated';
    // As if one worker claimed it the moment the grace window closed.
    p.state = 'evaluated';
    p.outcome = outcome;
    p.evaluatedAt = p.evaluateAt;
    p.claimedAt = p.evaluateAt;
    p.attempts = 1;

    if (outcome === 'collapsed') {
      closeRun();
    } else if (outcome === 'survived') {
      height += 1;
      run.start ??= p.periodStart;
      run.end = p.periodEnd;
      for (const c of contributions) {
        const s = runStats.get(c.m)!;
        s.totalDays += 1;
        if (c.qualified) {
          s.qualifyingDays += 1;
          s.highestTier = Math.max(s.highestTier, c.tier);
        }
      }
    }
  }

  tower.height = height;
  tower.currentStreak = height;
  return plan;
}
