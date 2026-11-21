import type { LocalDate } from '../time/local-date.js';
import type { EvaluationOutput, EvaluationWindow } from './evaluate.js';

/**
 * Structured fields for the APPLICATION LOG when a period collapses, so support
 * can see whose miss collapsed a tower.
 *
 * LOG ONLY (§5). Never persist these fields, never return them from the API,
 * never attach them to a base block or its roster. A tower's history records
 * what the group built, not who broke it: the 2.6 ticket and the header of
 * towers/blocks/schema.ts (@tower-of-habit/db) rule out a stored missedBy,
 * because "for debugging" is exactly how a permanent blame record arrives.
 * test/log-only.test.ts fails if db or api source mentions this.
 *
 * The evaluation job is the intended caller:
 *   const fields = collapseLogFields(window, out);
 *   if (fields) log.info({ towerId, ...fields });
 *
 * missedBy holds membership ids, not user ids or display names, to keep
 * personal data out of logs; support can join to the user when it needs to.
 *
 * Pure: derived from evaluatePeriod's output alone; no clock, no I/O.
 */
export type CollapseLogFields = {
  event: 'period_collapsed';
  periodStart: LocalDate;
  periodEnd: LocalDate;
  /**
   * Membership ids whose miss collapsed the tower, sorted. Only first misses
   * (at_risk): a second consecutive miss goes dormant instead of collapsing.
   */
  missedBy: string[];
};

export function collapseLogFields(
  window: EvaluationWindow,
  out: EvaluationOutput
): CollapseLogFields | null {
  if (out.periodStatus !== 'collapsed') return null;
  const missedBy = out.transitions
    .filter((t) => t.type === 'at_risk' && t.reason === 'missed_period')
    .map((t) => t.membershipId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    event: 'period_collapsed',
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    missedBy,
  };
}
