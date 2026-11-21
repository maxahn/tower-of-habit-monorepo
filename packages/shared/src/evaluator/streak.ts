import { addDays, type LocalDate } from '../time/local-date.js';

/**
 * 2.12: a habit's current streak: consecutive qualifying days ending on
 * `today` or the day before it (today may simply not be logged yet). Zero if
 * the most recent qualifying day is older than yesterday. Dates may arrive in
 * any order, with duplicates; days after `today` are ignored.
 *
 * Pure: `today` is injected, in the zone the dates were written in.
 */
export function currentStreak(qualifyingDates: readonly LocalDate[], today: LocalDate): number {
  const days = new Set(qualifyingDates.filter((d) => d <= today));
  let cursor = days.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}
