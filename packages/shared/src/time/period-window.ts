/**
 * Period boundaries and the two instants a materialised period carries.
 *
 * Two instants, not one (DR-001):
 *   deadline_at  the commitment, and the only instant a member ever sees:
 *                countdown (5.8), nudge anchor (3.6), wobble anchor (3.7).
 *   evaluate_at  when the outcome is decided, never displayed: scheduler
 *                claim (3.4), collapse decision (3.8).
 */
import {
  addDays,
  dayOfWeek,
  daysBetween,
  InvalidLocalDateInputError,
  type LocalDate,
} from './local-date.js';
import { resolveWallClock, type WallClockKind, type WallClockPolicy } from './wall-clock.js';

const MS_PER_MINUTE = 60_000;
const DAYS_PER_WEEK = 7;

/** A tower's scheduling shape: exactly the columns tower_periods needs. */
export type PeriodConfig = {
  periodUnit: 'day' | 'week';
  periodLength: number;
  /** 0 = Sunday .. 6 = Saturday. Non-null iff periodUnit is 'week'. */
  weekResetDay: number | null;
  /** The civil date the tower's first period is anchored on, in its zone. */
  anchorDate: LocalDate;
};

/** period_end is inclusive, matching the DATE columns. */
export type PeriodBounds = { periodStart: LocalDate; periodEnd: LocalDate };

export type PeriodInstants = {
  deadlineAt: Date;
  evaluateAt: Date;
  /** 'gap' or 'ambiguous': the deadline wall clock was irregular that day. */
  deadlineKind: WallClockKind;
};

export type PeriodWindow = PeriodBounds & PeriodInstants;

/**
 * The period containing `on`.
 *
 * Indexed off anchorDate rather than an epoch, so boundaries never move:
 * period N always starts origin + N * span days. Weekly towers first snap the
 * anchor BACK to the most recent weekResetDay, so every period_start is a reset
 * day and the tower is live the moment it activates, at the cost of a partly
 * elapsed first period.
 */
export function periodBoundsFor(config: PeriodConfig, on: LocalDate): PeriodBounds {
  const { periodUnit, periodLength, weekResetDay, anchorDate } = config;
  if (!Number.isInteger(periodLength) || periodLength < 1) {
    throw new InvalidLocalDateInputError('periodLength', periodLength);
  }
  let origin = anchorDate;
  let span = periodLength;
  if (periodUnit === 'week') {
    if (
      weekResetDay === null ||
      !Number.isInteger(weekResetDay) ||
      weekResetDay < 0 ||
      weekResetDay > 6
    ) {
      throw new InvalidLocalDateInputError('weekResetDay', weekResetDay);
    }
    const back = (dayOfWeek(anchorDate) - weekResetDay + DAYS_PER_WEEK) % DAYS_PER_WEEK;
    origin = addDays(anchorDate, -back);
    span = periodLength * DAYS_PER_WEEK;
  }
  // floor, not trunc: a date before the origin is in period -1, not period 0.
  const index = Math.floor(daysBetween(origin, on) / span);
  const periodStart = addDays(origin, index * span);
  return { periodStart, periodEnd: addDays(periodStart, span - 1) };
}

/**
 * deadline_at and evaluate_at for a period ending on `periodEnd`.
 *
 * evaluate_at is deadline_at plus a REAL interval, computed on the RESOLVED
 * instant. Not grace minutes added to a local wall-clock hour: on a
 * spring-forward night those differ by an hour, and the wall-clock version
 * evaluates 60 minutes early, collapsing a tower whose member logged inside
 * what they believed was the window.
 */
export function periodInstants(args: {
  periodEnd: LocalDate;
  deadlineTime: string;
  timeZone: string;
  graceMinutes: number;
  policy?: WallClockPolicy;
}): PeriodInstants {
  if (!Number.isInteger(args.graceMinutes) || args.graceMinutes < 0) {
    throw new InvalidLocalDateInputError('graceMinutes', args.graceMinutes);
  }
  const { instant: deadlineAt, kind: deadlineKind } = resolveWallClock(
    args.periodEnd,
    args.deadlineTime,
    args.timeZone,
    args.policy ?? 'later'
  );
  const evaluateAt = new Date(deadlineAt.getTime() + args.graceMinutes * MS_PER_MINUTE);
  return { deadlineAt, evaluateAt, deadlineKind };
}

/** Bounds plus instants: everything an insert into tower_periods needs. */
export function resolvePeriodWindow(
  args: PeriodConfig & {
    on: LocalDate;
    deadlineTime: string;
    timeZone: string;
    graceMinutes: number;
    policy?: WallClockPolicy;
  }
): PeriodWindow {
  const bounds = periodBoundsFor(args, args.on);
  return {
    ...bounds,
    ...periodInstants({
      periodEnd: bounds.periodEnd,
      deadlineTime: args.deadlineTime,
      timeZone: args.timeZone,
      graceMinutes: args.graceMinutes,
      ...(args.policy !== undefined ? { policy: args.policy } : {}),
    }),
  };
}
