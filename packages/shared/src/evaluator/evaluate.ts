import type { DormancyReason, MembershipState } from '../schemas/index.js';
import type { LocalDate } from '../time/local-date.js';
import type { PeriodSchedule, PeriodScheduleConfig } from '../time/period-window.js';

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

// STUB: implementation lands in the feat commit for 2.4.
export function evaluatePeriod(input: EvaluationInput): EvaluationOutput {
  void input;
  throw new Error('evaluatePeriod: not implemented');
}
