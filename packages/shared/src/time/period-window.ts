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

/** 0 = Sunday .. 6 = Saturday (towers_week_reset_day_range). */
function assertWeekResetDay(value: number | null): asserts value is number {
  if (value === null || !Number.isInteger(value) || value < 0 || value > 6) {
    throw new InvalidLocalDateInputError('weekResetDay', value);
  }
}

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
    assertWeekResetDay(weekResetDay);
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
 *   nudgeAt     deadlineAt - nudgeLeadMinutes
 *
 * Both leads are floored at periodStart 00:00 local (itself resolved 'forward':
 * Santiago's midnight can be a gap), so nothing fires in the previous period.
 * And the nudge never follows the wobble (towers_nudge_before_wobble: the
 * private nudge precedes the broadcast), so the invariant is
 *
 *   nudgeAt <= wobbleAt <= deadlineAt <= evaluateAt
 *
 * When an early deadline floors both, they coincide at local midnight: the
 * closest to "nudge first" that stays inside the period. The clamp to wobbleAt
 * is a no-op for any config the db accepts; it holds the order by construction.
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
  const grace = nonNegativeMinutes('graceMinutes', tower.graceWindowMinutes);
  const wobble = nonNegativeMinutes('wobbleLeadMinutes', tower.wobbleLeadMinutes);
  const nudge = nonNegativeMinutes('nudgeLeadMinutes', tower.nudgeLeadMinutes);

  let periodEnd = addDays(periodStart, 0); // validates periodStart
  if (tower.periodUnit === 'week') {
    assertWeekResetDay(tower.weekResetDay);
    // Days to the NEXT reset day, strictly after periodStart: a start on the
    // reset day itself spans the full week, so 0 becomes 7.
    const toNextReset =
      (tower.weekResetDay - dayOfWeek(periodStart) + DAYS_PER_WEEK) % DAYS_PER_WEEK ||
      DAYS_PER_WEEK;
    periodEnd = addDays(periodStart, toNextReset - 1);
  }

  const deadline = resolveWallClock(
    periodEnd,
    tower.deadlineTime,
    tower.timezone,
    'forward'
  ).instant.getTime();
  const floor = resolveWallClock(periodStart, '00:00', tower.timezone, 'forward').instant.getTime();

  const wobbleAt = Math.max(deadline - wobble * MS_PER_MINUTE, floor);
  const nudgeAt = Math.min(Math.max(deadline - nudge * MS_PER_MINUTE, floor), wobbleAt);

  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    periodStart,
    periodEnd,
    nudgeAt: iso(nudgeAt),
    wobbleAt: iso(wobbleAt),
    deadlineAt: iso(deadline),
    evaluateAt: iso(deadline + grace * MS_PER_MINUTE),
  };
}

function nonNegativeMinutes(
  field: 'graceMinutes' | 'wobbleLeadMinutes' | 'nudgeLeadMinutes',
  value: number
): number {
  if (!Number.isInteger(value) || value < 0) throw new InvalidLocalDateInputError(field, value);
  return value;
}
