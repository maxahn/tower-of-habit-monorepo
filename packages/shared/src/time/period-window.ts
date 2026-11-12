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

/**
 * A tower's schedule-relevant columns. Field names match TowerResponse
 * (schemas/api/towers.ts), so a tower row or response can be passed as-is.
 * The 2.2 spec calls periodUnit "cadence" and deadlineTime "deadlineLocalTime".
 */
export type PeriodScheduleConfig = {
  periodUnit: 'day' | 'week';
  timezone: string;
  /** 'HH:MM', or the Postgres read-back form 'HH:MM:SS'. */
  deadlineTime: string;
  graceWindowMinutes: number;
  wobbleLeadMinutes: number;
  nudgeLeadMinutes: number;
  /** 0 = Sunday .. 6 = Saturday. Non-null iff periodUnit is 'week'. */
  weekResetDay: number | null;
};

/**
 * The 2.2 spec's PeriodWindow, renamed so it doesn't collide with the
 * Date-based PeriodWindow above. Instants are ISO strings (toISOString).
 */
export type PeriodSchedule = {
  /** Tower-local civil date. */
  periodStart: LocalDate;
  /** Tower-local civil date, inclusive. */
  periodEnd: LocalDate;
  nudgeAt: string;
  wobbleAt: string;
  deadlineAt: string;
  evaluateAt: string;
};

/**
 * The period that starts on `periodStart`, and the four instants governing it.
 *
 *   periodEnd   daily: periodStart. Weekly [v2, unreachable until then]: the
 *               day before the next weekResetDay (a start ON the reset day
 *               spans the full 7 days).
 *   deadlineAt  periodEnd at deadlineTime in the TOWER's zone, resolved with
 *               the 'forward' policy (gap -> transition instant, ambiguous ->
 *               first occurrence), so a period never gets unexpectedly longer.
 *   evaluateAt  deadlineAt + graceWindowMinutes
 *   wobbleAt    deadlineAt - wobbleLeadMinutes
 *   nudgeAt     deadlineAt - nudgeLeadMinutes, floored at periodStart 00:00
 *               local (itself resolved 'forward': Santiago's midnight can be a
 *               gap). Not floored: wobbleAt, so an early deadline can put the
 *               nudge after the wobble. Spec as written; see the test.
 *
 * Every offset is a REAL interval on the resolved instant, never wall-clock
 * arithmetic: same reasoning as periodInstants.
 *
 * D3: the tower's zone owns "today". Members far from it get a deadline at an
 * odd local hour; the lobby UI surfaces that, the model doesn't solve it.
 *
 * Pure: reads no clock.
 */
export function computePeriodWindow(
  tower: PeriodScheduleConfig,
  periodStart: LocalDate
): PeriodSchedule {
  void tower;
  void periodStart;
  throw new Error('computePeriodWindow: not implemented (2.2)');
}
