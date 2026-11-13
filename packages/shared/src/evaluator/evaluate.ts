import type { DormancyReason, MembershipState } from '../schemas/index.js';
import { addDays, civilInZone, daysBetween, type LocalDate } from '../time/local-date.js';
import type { PeriodSchedule, PeriodScheduleConfig } from '../time/period-window.js';
import { MIN_BLOCK_DAYS } from './recompute.js';

/**
 * 2.4: decide a period's outcome from the tower, its window and every member's
 * state within it.
 *
 * Status, for fixed member state, as `now` advances:
 *   - every counted member meets quota          -> survived, whatever `now` is;
 *   - otherwise, now <  wobbleAt                -> open;
 *   - otherwise, now <  evaluateAt              -> wobbling (short members named);
 *   - otherwise                                 -> collapsed, unless the §6 ladder
 *     turns every remaining shortfall into a dormancy (see below).
 *
 * Counted members are live (active or at_risk) and not excused. Excused members
 * (declared voluntary absence) never cause wobbling or collapse; dormant and
 * removed members are excluded from the quota check entirely. A tower with no
 * counted members survives with no transitions: hibernation is the caller's
 * concern.
 *
 * §6 ladder, applied only at a terminal outcome (survived/collapsed):
 *   - miss #1 (consecutiveMisses 0, short): -> at_risk, and the tower collapses;
 *   - miss #2 (consecutiveMisses >= 1, short): -> dormant (consecutive_miss)
 *     INSTEAD of collapsing;
 *   - an at_risk member who meets quota: -> active.
 *
 * Monotonic in `now`: with members fixed, the status never steps backwards
 * along open < wobbling < {survived | collapsed}, a terminal status never
 * changes as `now` advances, and every `now` >= evaluateAt yields the same
 * decision. An early survived (everyone met) holds at every `now`; a survived
 * can also first appear at evaluateAt, when the ladder turns every miss into a
 * dormancy. That a decided period is never re-evaluated with an earlier `now`
 * is the database's guarantee (evaluate_at), not this function's.
 *
 * Slack is daysRemaining - daysNeeded even for daily towers, where it is
 * always zero for a short member, so the v2 weekly path is a config change.
 *
 * Pure: `now` is injected; no clock, no randomness, no module state.
 */

/** The tower's schedule columns plus the quota and the current run so far. */
export type TowerConfig = PeriodScheduleConfig & {
  /** Qualifying days each member needs in a period. Daily towers: 1. */
  quota: number;
  /** Survived periods in the current run, BEFORE this period. */
  height: number;
  /** First period of the current run; null when height is 0. */
  runStartDate: LocalDate | null;
};

/** The 2.2 spec's PeriodWindow (ISO-string instants). */
export type EvaluationWindow = PeriodSchedule;

export type MemberPeriodState = {
  membershipId: string;
  /** 'removed' members are ignored, the same as dormant ones. */
  state: MembershipState;
  qualifyingDays: number;
  /** Declared voluntary absence for this period. */
  excused: boolean;
  /** consecutive_missed_periods BEFORE this period. */
  consecutiveMisses: number;
};

/** excluded: dormant or removed, so outside the quota check. */
export type MemberStanding = 'met' | 'short' | 'excused' | 'excluded';

export type MemberOutcome = {
  membershipId: string;
  standing: MemberStanding;
  /** max(0, quota - qualifyingDays). */
  daysNeeded: number;
  daysRemaining: number;
  /** daysRemaining - daysNeeded. */
  slack: number;
};

export type MembershipTransition =
  | { membershipId: string; from: MembershipState; to: 'dormant'; reason: DormancyReason }
  | { membershipId: string; from: MembershipState; to: 'active' | 'at_risk' };

/** A base block's boundaries. The roster is 2.6's concern. */
export type BaseBlockDraft = {
  runStartDate: LocalDate;
  runEndDate: LocalDate;
  blockHeight: number;
};

export type EvaluationStatus = 'open' | 'wobbling' | 'survived' | 'collapsed';

export interface EvaluationInput {
  /** ISO instant. Injected, never read from a clock. */
  now: string;
  tower: TowerConfig;
  window: EvaluationWindow;
  members: MemberPeriodState[];
}

export interface EvaluationOutput {
  periodStatus: EvaluationStatus;
  /** One per input member, in input order. */
  perMember: MemberOutcome[];
  /** Empty unless the status is terminal (survived/collapsed). */
  transitions: MembershipTransition[];
  /** Only on collapsed, and only when tower.height >= MIN_BLOCK_DAYS. */
  baseBlock?: BaseBlockDraft;
  /** The day after periodEnd, on terminal statuses only. */
  nextPeriodStart?: string;
}

export class EvaluationInputError extends Error {
  constructor(
    readonly field: string,
    readonly value: unknown
  ) {
    super(`Invalid evaluation input: ${field} = ${JSON.stringify(value)}`);
    this.name = 'EvaluationInputError';
  }
}

/** Parse an ISO instant to epoch ms, rejecting anything Date.parse can't read. */
function instantMs(field: string, iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new EvaluationInputError(field, iso);
  return ms;
}

/** Live members are inside the quota check; dormant and removed are not. */
const isLive = (m: MemberPeriodState) => m.state === 'active' || m.state === 'at_risk';

export function evaluatePeriod(input: EvaluationInput): EvaluationOutput {
  const { tower, window: w, members } = input;
  if (!Number.isInteger(tower.quota) || tower.quota < 1) {
    throw new EvaluationInputError('tower.quota', tower.quota);
  }
  const now = instantMs('now', input.now);
  const wobbleAt = instantMs('window.wobbleAt', w.wobbleAt);
  const evaluateAt = instantMs('window.evaluateAt', w.evaluateAt);
  const decided = now >= evaluateAt;

  const daysRemaining = remainingDays(now, decided, tower.timezone, w);
  const perMember = members.map((m): MemberOutcome => {
    const daysNeeded = Math.max(0, tower.quota - m.qualifyingDays);
    return {
      membershipId: m.membershipId,
      standing: standingOf(m, daysNeeded),
      daysNeeded,
      daysRemaining,
      slack: daysRemaining - daysNeeded,
    };
  });

  const anyShort = perMember.some((o) => o.standing === 'short');
  if (anyShort && !decided) {
    return { periodStatus: now >= wobbleAt ? 'wobbling' : 'open', perMember, transitions: [] };
  }

  // Terminal: everyone counted met quota (at any now), or the period is decided.
  const transitions: MembershipTransition[] = [];
  let collapsed = false;
  members.forEach((m, i) => {
    const { standing } = perMember[i]!;
    const { membershipId, state: from } = m;
    if (standing === 'met') {
      if (from === 'at_risk') transitions.push({ membershipId, from, to: 'active' });
    } else if (standing === 'short') {
      // §6 ladder. at_risk already means one miss, whatever the counter says.
      const firstMiss = from === 'active' && m.consecutiveMisses === 0;
      if (firstMiss) {
        collapsed = true;
        transitions.push({ membershipId, from, to: 'at_risk' });
      } else {
        transitions.push({ membershipId, from, to: 'dormant', reason: 'consecutive_miss' });
      }
    }
  });

  const out: EvaluationOutput = {
    periodStatus: collapsed ? 'collapsed' : 'survived',
    perMember,
    transitions,
    nextPeriodStart: addDays(w.periodEnd, 1),
  };
  // A collapse closes the run of survived periods before this one.
  if (collapsed && tower.height >= MIN_BLOCK_DAYS && tower.runStartDate !== null) {
    out.baseBlock = {
      runStartDate: tower.runStartDate,
      runEndDate: addDays(w.periodStart, -1),
      blockHeight: tower.height,
    };
  }
  return out;
}

function standingOf(m: MemberPeriodState, daysNeeded: number): MemberStanding {
  if (!isLive(m)) return 'excluded';
  if (m.excused) return 'excused';
  return daysNeeded === 0 ? 'met' : 'short';
}

/**
 * Days in which a qualifying entry can still land: from the tower-local "today"
 * through periodEnd, inclusive. Today is clamped into the period, so a now
 * before it counts the whole period, and the grace window (which may run past
 * local midnight, where late logs still date to periodEnd) still counts
 * periodEnd. Zero once the period is decided. Daily: 1 until evaluateAt.
 */
function remainingDays(
  now: number,
  decided: boolean,
  timeZone: string,
  w: EvaluationWindow
): number {
  if (decided) return 0;
  const today = civilInZone(new Date(now), timeZone).date;
  const from = today < w.periodStart ? w.periodStart : today > w.periodEnd ? w.periodEnd : today;
  return daysBetween(from, w.periodEnd) + 1;
}
