import type { NewTowerPeriod } from '@tower-of-habit/db';
import {
  addDays,
  civilInZone,
  computePeriodWindow,
  type LocalDate,
  type PeriodSchedule,
  type PeriodScheduleConfig,
} from '@tower-of-habit/shared';

/**
 * 2.15 / DECISIONS P13: every period the API materialises, previews or
 * evaluates goes through computePeriodWindow (2.2) for the period's start
 * date. One window, every caller, so start, preview and evaluation can never
 * disagree about when a period closes.
 */
export function periodWindowFor(
  tower: PeriodScheduleConfig,
  periodStart: LocalDate
): PeriodSchedule {
  return computePeriodWindow(tower, periodStart);
}

/**
 * Period 1 starts on the tower-local date of the start instant, unless that
 * instant has already reached the day's deadline, in which case it starts the
 * next day: a tower started at 23:00 with a 22:00 deadline must not collapse
 * twelve minutes later over a period nobody could have kept.
 */
export function firstPeriodStart(tower: PeriodScheduleConfig, now: Date): LocalDate {
  const today = civilInZone(now, tower.timezone).date;
  const window = periodWindowFor(tower, today);
  return now.getTime() >= Date.parse(window.deadlineAt) ? addDays(today, 1) : today;
}

/** The tower_periods row for a window, with the instants as Dates. */
export function periodInsert(towerId: string, window: PeriodSchedule): NewTowerPeriod {
  return {
    towerId,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    deadlineAt: new Date(window.deadlineAt),
    evaluateAt: new Date(window.evaluateAt),
  };
}
