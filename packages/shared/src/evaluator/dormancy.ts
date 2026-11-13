import type { DormancyReason, MembershipState } from '../schemas/index.js';
import { addDays, daysBetween, type LocalDate } from '../time/local-date.js';
import type { MemberStanding } from './evaluate.js';

/**
 * 2.5: the membership transitions a trigger implies.
 *
 * The spec's dormant_auto / dormant_voluntary are not states in the schema:
 * they are state 'dormant' with dormancy_reason consecutive_miss|backstop
 * (auto) or voluntary.
 *
 *   From               Trigger                          To / type            Collapse
 *   active, misses 0   period short                     at_risk / at_risk    yes
 *   at_risk            period short                     dormant / dormant    no
 *   at_risk            period met                       active / recovered   no
 *   active | at_risk   14 days with no qualifying entry dormant / dormant    no
 *   dormant_auto       a qualifying entry               active / returned    no
 *   dormant_voluntary  return date reached              active / returned    no
 *
 * At most one collapse per absent member per absence: the second consecutive
 * miss goes dormant instead. Voluntary dormancy is never escalated; it ends
 * only on its own date. A return lands effective from the open period's
 * start, so that period's existing entries count.
 *
 * consecutive_misses is an input and the new value an output: the counter is
 * denormalised onto memberships so this needs no history, and the caller
 * persists it.
 *
 * Pure: dates are injected; no clock, no randomness, no module state.
 */

/** Days without a qualifying entry before a live member goes dormant. */
export const BACKSTOP_DAYS = 14;

export type MembershipSnapshot = {
  membershipId: string;
  state: MembershipState;
  /** Set iff state is 'dormant'. */
  dormancyReason: DormancyReason | null;
  /** consecutive_missed_periods BEFORE this step. */
  consecutiveMisses: number;
  /** The habit's most recent qualifying entry (tower-local), if any. */
  lastQualifyingDate: LocalDate | null;
  /** Backstop anchor when there is no qualifying entry yet. */
  joinedOn: LocalDate;
  /** Set for voluntary dormancy: the first day back. */
  voluntaryReturnDate: LocalDate | null;
};

export type DormancyTrigger =
  /** A period reached a terminal status; standing is this member's in it. */
  | {
      kind: 'period_evaluated';
      periodStart: LocalDate;
      periodEnd: LocalDate;
      standing: MemberStanding;
    }
  /** The member logged a qualifying entry dated localDate. */
  | { kind: 'qualifying_entry'; localDate: LocalDate; openPeriodStart: LocalDate }
  /** asOf, the last fully elapsed tower-local day, has ended. Backstop and voluntary expiry. */
  | { kind: 'day_elapsed'; asOf: LocalDate; openPeriodStart: LocalDate };

export type MembershipTransitionType = 'at_risk' | 'recovered' | 'dormant' | 'returned';

export type TransitionReason =
  | 'missed_period'
  | 'met_quota'
  | 'consecutive_miss'
  | 'backstop'
  | 'logged'
  | 'return_date_reached';

/** One membership_events row. */
export type MembershipTransition = {
  membershipId: string;
  type: MembershipTransitionType;
  from: MembershipState;
  to: MembershipState;
  /** Present iff to === 'dormant'. */
  dormancyReason?: DormancyReason;
  reason: TransitionReason;
  /** First tower-local day the new state applies. */
  effectiveFrom: LocalDate;
};

export type DormancyStep = {
  transition: MembershipTransition | null;
  /** The new consecutive_missed_periods, for the caller to persist. */
  consecutiveMisses: number;
  /** This member's miss collapses the tower. */
  collapses: boolean;
};

export function stepMembership(m: MembershipSnapshot, t: DormancyTrigger): DormancyStep {
  const keep = noChange(m);
  switch (t.kind) {
    case 'period_evaluated': {
      if (!isLive(m)) return keep;
      const effectiveFrom = addDays(t.periodEnd, 1);
      if (t.standing === 'met') {
        if (m.state !== 'at_risk') return { ...keep, consecutiveMisses: 0 };
        return step(transition(m, 'recovered', 'active', 'met_quota', effectiveFrom), 0);
      }
      if (t.standing !== 'short') return keep; // excused, or excluded
      const misses = m.consecutiveMisses + 1;
      // §6. at_risk already means one miss, whatever the counter says.
      if (m.state === 'active' && m.consecutiveMisses === 0) {
        return step(
          transition(m, 'at_risk', 'at_risk', 'missed_period', effectiveFrom),
          misses,
          true
        );
      }
      return step(dormancy(m, 'consecutive_miss', effectiveFrom), misses);
    }
    case 'qualifying_entry': {
      // Only automatic dormancy ends on a log; voluntary waits for its date.
      if (m.state !== 'dormant' || m.dormancyReason === 'voluntary') return keep;
      return step(transition(m, 'returned', 'active', 'logged', t.openPeriodStart), 0);
    }
    case 'day_elapsed': {
      if (m.state === 'dormant') {
        const back = m.voluntaryReturnDate;
        // asOf has ended, so the next day is the first one the member could be back.
        if (m.dormancyReason !== 'voluntary' || back === null || addDays(t.asOf, 1) < back) {
          return keep;
        }
        return step(
          transition(m, 'returned', 'active', 'return_date_reached', t.openPeriodStart),
          0
        );
      }
      if (!backstopDue(m, t.asOf)) return keep;
      return step(dormancy(m, 'backstop', addDays(t.asOf, 1)), m.consecutiveMisses);
    }
  }
}

/** Whether a live member has gone BACKSTOP_DAYS full days without a qualifying entry by asOf. */
export function backstopDue(m: MembershipSnapshot, asOf: LocalDate): boolean {
  if (!isLive(m)) return false;
  return daysBetween(m.lastQualifyingDate ?? m.joinedOn, asOf) >= BACKSTOP_DAYS;
}

const isLive = (m: MembershipSnapshot) => m.state === 'active' || m.state === 'at_risk';

const noChange = (m: MembershipSnapshot): DormancyStep => ({
  transition: null,
  consecutiveMisses: m.consecutiveMisses,
  collapses: false,
});

const step = (
  transition: MembershipTransition,
  consecutiveMisses: number,
  collapses = false
): DormancyStep => ({ transition, consecutiveMisses, collapses });

function transition(
  m: MembershipSnapshot,
  type: Exclude<MembershipTransitionType, 'dormant'>,
  to: 'active' | 'at_risk',
  reason: TransitionReason,
  effectiveFrom: LocalDate
): MembershipTransition {
  return { membershipId: m.membershipId, type, from: m.state, to, reason, effectiveFrom };
}

function dormancy(
  m: MembershipSnapshot,
  reason: 'consecutive_miss' | 'backstop',
  effectiveFrom: LocalDate
): MembershipTransition {
  return {
    membershipId: m.membershipId,
    type: 'dormant',
    from: m.state,
    to: 'dormant',
    dormancyReason: reason,
    reason,
    effectiveFrom,
  };
}
