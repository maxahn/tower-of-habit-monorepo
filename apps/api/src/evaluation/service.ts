import {
  appendBaseBlock,
  closeTowerRun,
  ensurePeriod,
  extendTowerRun,
  getPeriod,
  listBaseBlocksForTower,
  listQualifyingDaysInRange,
  lockPeriodForEvaluation,
  lockTower,
  transitionMembership,
  transitionPeriod,
  updateMembership,
  type BaseBlock,
  type Db,
  type Membership,
  type PeriodOutcome,
  type Tower,
} from '@tower-of-habit/db';
import { civilInZone, type EvaluationResponse } from '@tower-of-habit/shared';
import {
  buildBaseBlockDraft,
  evaluatePeriod,
  MIN_BLOCK_DAYS,
  stepMembership,
  type EvaluationOutput,
  type MembershipTransition,
  type RunMember,
  type RunPeriod,
} from '@tower-of-habit/shared/evaluator';
import type { TxRunner } from '../context.js';
import { DomainError } from '../errors.js';
import type { Logger } from '../logger.js';
import { periodInsert, periodWindowFor } from '../towers/periods.js';
import { loadEvaluationInput, type LoadedEvaluation } from './input.js';

/**
 * 2.19: evaluate one period and persist everything the outcome implies, in
 * one transaction. The manual stand-in for the Phase 3 tick; Phase 3 should
 * import evaluateTowerPeriod, not re-derive it from the HTTP handler.
 *
 *   1. claim the period (FOR UPDATE SKIP LOCKED) and lock the tower;
 *   2. refuse a terminal period (period_already_evaluated) or one the
 *      evaluator still calls open/wobbling (period_not_due);
 *   3. evaluatePeriod — the same call the preview makes;
 *   4. persist: period outcome; height/streak; the base block on a collapse;
 *      membership counters and §6 transitions (plus the 14-day backstop and
 *      voluntary-return expiry, which only this tick can fire in Phase 2);
 *   5. materialise the next period.
 *
 * Outcome vocabulary: survived / collapsed from the evaluator; hibernated when
 * no live member was counted (the evaluator returns survived with no
 * transitions; hibernation is the caller's concern).
 *
 * Nothing here records who caused a collapse (§5).
 */

export type EvaluateFn = (
  towerId: string,
  periodId: string,
  now: Date
) => Promise<EvaluationResponse>;

export function createEvaluator(db: TxRunner, logger: Logger): EvaluateFn {
  return (towerId, periodId, now) =>
    db.transaction((tx) => evaluateTowerPeriod(tx, towerId, periodId, now, logger));
}

export async function evaluateTowerPeriod(
  tx: Db,
  towerId: string,
  periodId: string,
  now: Date,
  logger?: Logger
): Promise<EvaluationResponse> {
  const claimed = await lockPeriodForEvaluation(tx, periodId, towerId);
  if (!claimed) {
    const exists = await getPeriod(tx, periodId);
    if (exists && exists.towerId === towerId) {
      throw new DomainError(409, 'period_claimed', 'The period is being evaluated');
    }
    throw new DomainError(404, 'not_found', 'Period not found');
  }
  if (claimed.state === 'evaluated') {
    throw new DomainError(
      409,
      'period_already_evaluated',
      'The period has already been evaluated',
      { period: claimed }
    );
  }
  const tower = await lockTower(tx, towerId);
  if (!tower) throw new DomainError(404, 'not_found', 'Tower not found');

  const loaded = await loadEvaluationInput(tx, tower, claimed, now);
  const out = evaluatePeriod(loaded.input);
  if (out.periodStatus === 'open' || out.periodStatus === 'wobbling') {
    throw new DomainError(409, 'period_not_due', 'The period is not decided yet', {
      periodStatus: out.periodStatus,
      evaluateAt: loaded.window.evaluateAt,
    });
  }

  // Claim in the state machine too, so the schema's invariants hold.
  if (claimed.state === 'pending')
    await transitionPeriod(tx, claimed.id, { to: 'evaluating' }, now);

  const counted = out.perMember.some((m) => m.standing !== 'excluded');
  const outcome: PeriodOutcome = !counted
    ? 'hibernated'
    : out.periodStatus === 'collapsed'
      ? 'collapsed'
      : 'survived';

  let baseBlock: BaseBlock | null = null;
  let towerAfter = tower;
  if (outcome === 'survived') {
    towerAfter = await extendTowerRun(tx, tower.id);
  } else if (outcome === 'collapsed') {
    if (out.baseBlock) baseBlock = await writeBaseBlock(tx, tower, loaded, out);
    towerAfter = await closeTowerRun(tx, tower.id);
  }

  const transitions = await applyMemberships(tx, tower, loaded, out, now);

  const period = await transitionPeriod(tx, claimed.id, { to: 'evaluated', outcome }, now);
  const nextPeriod = out.nextPeriodStart
    ? await ensurePeriod(tx, periodInsert(tower.id, periodWindowFor(tower, out.nextPeriodStart)))
    : null;

  logger?.info(
    { towerId: tower.id, periodId: period.id, periodStart: period.periodStart, outcome },
    'period evaluated'
  );

  return {
    period: period as unknown as EvaluationResponse['period'],
    outcome,
    perMember: out.perMember.map((m) => ({
      membershipId: m.membershipId,
      standing: m.standing,
      consecutiveMisses: m.consecutiveMisses,
    })),
    transitions,
    baseBlock: baseBlock as unknown as EvaluationResponse['baseBlock'],
    nextPeriod: nextPeriod as unknown as EvaluationResponse['nextPeriod'],
    tower: { height: towerAfter.height, currentStreak: towerAfter.currentStreak },
  };
}

/** 2.6: the block for the run that just closed, with every member's roster entry. */
async function writeBaseBlock(
  tx: Db,
  tower: Tower,
  loaded: LoadedEvaluation,
  out: EvaluationOutput
): Promise<BaseBlock | null> {
  const bounds = out.baseBlock!;
  const runPeriods: RunPeriod[] = loaded.periods
    .filter(
      (p) =>
        p.state === 'evaluated' &&
        p.outcome !== null &&
        p.outcome !== 'collapsed' &&
        p.periodStart >= bounds.runStartDate &&
        p.periodEnd <= bounds.runEndDate
    )
    .map((p) => ({
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      outcome: p.outcome as RunPeriod['outcome'],
    }));
  const members: RunMember[] = [];
  for (const m of loaded.memberships) {
    members.push({
      userId: m.userId,
      displayName: loaded.names.get(m.id) ?? 'Member',
      joinedOn: civilInZone(m.joinedAt, tower.timezone).date,
      leftOn: null,
      dormantSpans:
        m.state === 'dormant' && m.dormantSince
          ? [{ from: civilInZone(m.dormantSince, tower.timezone).date, to: null }]
          : [],
      qualifyingDays: await listQualifyingDaysInRange(
        tx,
        m.habitId,
        bounds.runStartDate,
        bounds.runEndDate
      ),
    });
  }
  const existing = await listBaseBlocksForTower(tx, tower.id);
  const draft = buildBaseBlockDraft({
    ordinal: existing.length + 1,
    minBlockDays: MIN_BLOCK_DAYS,
    runPeriods,
    members,
  });
  if (!draft) return null;
  return appendBaseBlock(tx, {
    towerId: tower.id,
    runStartDate: draft.runStartDate,
    runEndDate: draft.runEndDate,
    blockHeight: draft.heightDays,
    roster: draft.roster,
  });
}

/**
 * 2.5: persist the new miss counters and apply the period's transitions, then
 * the day-elapsed triggers (14-day backstop, voluntary return) that nothing
 * else fires in Phase 2.
 */
async function applyMemberships(
  tx: Db,
  tower: Tower,
  loaded: LoadedEvaluation,
  out: EvaluationOutput,
  now: Date
): Promise<MembershipTransition[]> {
  const applied: MembershipTransition[] = [];
  const byId = new Map(loaded.memberships.map((m) => [m.id, m]));
  const periodTransitions = new Map(out.transitions.map((t) => [t.membershipId, t]));

  for (const o of out.perMember) {
    const m = byId.get(o.membershipId);
    if (!m) continue;
    if (o.consecutiveMisses !== m.consecutiveMissedPeriods) {
      await updateMembership(tx, m.id, { consecutiveMissedPeriods: o.consecutiveMisses });
    }
    let current: Membership = { ...m, consecutiveMissedPeriods: o.consecutiveMisses };
    const t = periodTransitions.get(m.id);
    if (t) {
      current = await apply(tx, t, now);
      applied.push(t);
    }
    // Backstop / voluntary expiry, as of the day that just ended.
    const step = stepMembership(
      {
        membershipId: current.id,
        state: current.state,
        dormancyReason: current.dormancyReason,
        consecutiveMisses: current.consecutiveMissedPeriods,
        lastQualifyingDate: current.lastQualifyingDate,
        joinedOn: civilInZone(current.joinedAt, tower.timezone).date,
        voluntaryReturnDate: current.voluntaryReturnDate,
      },
      {
        kind: 'day_elapsed',
        asOf: loaded.window.periodEnd,
        openPeriodStart: out.nextPeriodStart ?? loaded.window.periodEnd,
      }
    );
    if (step.transition) {
      await apply(tx, step.transition, now);
      applied.push(step.transition);
    }
  }
  return applied;
}

function apply(tx: Db, t: MembershipTransition, now: Date): Promise<Membership> {
  return transitionMembership(
    tx,
    t.membershipId,
    t.to === 'dormant'
      ? { to: 'dormant', reason: t.dormancyReason ?? 'consecutive_miss' }
      : { to: t.to as 'active' | 'at_risk' },
    now
  );
}
