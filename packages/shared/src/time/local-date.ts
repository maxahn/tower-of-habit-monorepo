/**
 * Derivation of an entry's local_date (DR-001).
 *
 * local_date is derived server-side, never client-supplied: a client date is
 * spoofable and wrong across timezone changes when someone travels. Everything
 * here is pure — no database reads, no system clock — because this is the most
 * bug-prone function in Phase 1 and it is shared by solo and tower logging.
 *
 * The design rule that makes DST correct by construction: every comparison is in
 * wall-clock minutes read out of Intl.DateTimeFormat. Nothing ever adds or
 * subtracts milliseconds from an instant.
 */

/** A civil date in a tower's (or a solo habit's) time zone: 'YYYY-MM-DD'. */
export type LocalDate = string;

export const MINUTES_PER_DAY = 1440;

const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 86_400_000;

/** DR-001 default. 0 reproduces the hard-cliff behaviour exactly. */
export const DEFAULT_GRACE_WINDOW_MINUTES = 120;

/**
 * Solo habits (DR-001 §6) have no tower deadline: the day boundary is the
 * owner's local midnight. Expressed as 24:00 (= 1440 minutes), NOT 00:00, and
 * that is load-bearing: with '00:00' the overflow would be 0 + grace - 1440 < 0,
 * clamping to 0, and every solo habit would silently get no grace at all.
 */
export const SOLO_DEADLINE_TIME = '24:00';

export class InvalidLocalDateInputError extends Error {
  constructor(
    readonly field:
      | 'loggedAt'
      | 'timeZone'
      | 'deadlineTime'
      | 'graceMinutes'
      | 'date'
      | 'periodLength'
      | 'weekResetDay',
    readonly value: unknown
  ) {
    super(`Invalid ${field} for local-date resolution: ${JSON.stringify(value)}`);
    this.name = 'InvalidLocalDateInputError';
  }
}

// Postgres `time` reads back as '22:00:00' and can render fractional seconds;
// DEFAULT_DEADLINE_TIME is '22:00'. All three forms must parse.
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Minutes from local midnight, 0..1440 inclusive: Postgres `time` accepts
 * '24:00:00' and SOLO_DEADLINE_TIME relies on 1440.
 *
 * Throws rather than returning a sentinel: a sentinel would propagate into a
 * wrong local_date, silently granting or denying a day's credit.
 */
export function parseDeadlineMinutes(deadlineTime: string): number {
  const m = TIME_RE.exec(deadlineTime);
  if (!m) throw new InvalidLocalDateInputError('deadlineTime', deadlineTime);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] === undefined ? 0 : Number(m[3]);
  if (mm > 59 || ss > 59) throw new InvalidLocalDateInputError('deadlineTime', deadlineTime);
  if (hh > 24 || (hh === 24 && (mm !== 0 || ss !== 0))) {
    throw new InvalidLocalDateInputError('deadlineTime', deadlineTime);
  }
  return hh * 60 + mm;
}

// Construction is the expensive part of Intl, and a single logged entry formats
// twice (gapFillCandidate, then resolveLocalDate). Cache per zone.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // Pinned, not inherited from the locale: a locale's default calendar and
      // numbering system silently produce garbage dates. Measured: ar-SA
      // resolves to islamic-umalqura with Arabic-Indic digits, th-TH to
      // buddhist (year 2569), fa-IR to persian. iso8601 also emits no era part.
      calendar: 'iso8601',
      numberingSystem: 'latn',
      // h23, and never alongside hour12: hour12:false and hourCycle:'h24' both
      // render midnight as hour '24', and hour12 takes precedence over
      // hourCycle, so passing both reintroduces the bug. Measured on ICU 74.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    throw new InvalidLocalDateInputError('timeZone', timeZone);
  }
  formatters.set(timeZone, formatter);
  return formatter;
}

/**
 * The wall-clock date and minutes-into-day an instant falls on in `timeZone`.
 *
 * Everything downstream compares the minutes this returns. Nothing adds or
 * subtracts milliseconds from an instant, which is what keeps DST out of the
 * arithmetic entirely.
 */
export function civilInZone(
  instant: Date,
  timeZone: string
): { date: LocalDate; minutesIntoDay: number } {
  if (Number.isNaN(instant.getTime())) {
    throw new InvalidLocalDateInputError('loggedAt', instant);
  }
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const { year, month, day, hour, minute } = parts;
  if (!year || !month || !day || !hour || !minute) {
    throw new InvalidLocalDateInputError('timeZone', timeZone);
  }
  const date = `${year.padStart(4, '0')}-${month}-${day}`;
  // Belt and braces: this package also runs under Hermes, whose Intl is a
  // partial reimplementation that may ignore calendar/numberingSystem. Fail
  // loudly rather than writing a Buddhist-era date into local_date.
  if (!ISO_DATE_RE.test(date)) throw new InvalidLocalDateInputError('timeZone', timeZone);
  return { date, minutesIntoDay: Number(hour) * 60 + Number(minute) };
}

/**
 * The epoch milliseconds a civil date-and-minute WOULD have if the wall clock
 * were UTC.
 *
 * A coordinate, not an instant. It is only ever differenced against another
 * civilMs, or corrected by a zone offset probed out of Intl (wall-clock.ts).
 * Never hand one to a caller as a timestamp.
 */
export function civilMs(date: LocalDate, minutesIntoDay = 0): number {
  const m = ISO_DATE_PARTS.exec(date);
  if (!m) throw new InvalidLocalDateInputError('date', date);
  const d = new Date(Date.UTC(2000, 0, 1));
  // setUTCFullYear rather than Date.UTC(y, ...): Date.UTC maps years 0..99 to
  // 19xx. Day 0 of month M is the last day of M-1, so overflow and underflow
  // roll months and leap years correctly (2028-03-01 - 1 -> 2028-02-29).
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getTime() + minutesIntoDay * MS_PER_MINUTE;
}

function formatCivil(ms: number): LocalDate {
  const d = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Pure civil arithmetic in UTC coordinates, where no day is ever 23 or 25 hours. */
export function addDays(date: LocalDate, days: number): LocalDate {
  return formatCivil(civilMs(date) + days * MS_PER_DAY);
}

/** Whole civil days from `from` to `to`; negative when `to` precedes `from`. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((civilMs(to) - civilMs(from)) / MS_PER_DAY);
}

/**
 * 0 = Sunday .. 6 = Saturday, matching Date#getUTCDay and the encoding
 * towers.week_reset_day uses (towers_week_reset_day_range).
 */
export function dayOfWeek(date: LocalDate): number {
  return new Date(civilMs(date)).getUTCDay();
}

/** Pure civil arithmetic. Never shifts an instant, so DST can't perturb it. */
export function previousDay(date: LocalDate): LocalDate {
  return addDays(date, -1);
}

/**
 * How many minutes the grace window spills PAST local midnight.
 *
 * Deadline 23:00 + 120 grace => 1380 + 120 - 1440 = 60: the window closes at
 * 01:00 the next morning.
 *
 * grace = 0 makes this <= 0 for every valid deadline, so it clamps to 0 and the
 * gap-filling branch below is unreachable. The hard-cliff requirement is
 * arithmetic, not a special case.
 */
export function graceOverflowMinutes(deadlineTime: string, graceMinutes: number): number {
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0) {
    throw new InvalidLocalDateInputError('graceMinutes', graceMinutes);
  }
  const overflow = parseDeadlineMinutes(deadlineTime) + graceMinutes - MINUTES_PER_DAY;
  // towers_grace_window_range caps grace at 360, so the real maximum is 360;
  // the upper clamp only stops a hypothetical window swallowing a whole day.
  return Math.min(Math.max(overflow, 0), MINUTES_PER_DAY);
}

export type LocalDateContext = {
  loggedAt: Date;
  timeZone: string;
  deadlineTime: string;
  graceMinutes: number;
};

/**
 * The previous civil day, if this instant falls inside the part of the grace
 * window that spilled past local midnight; otherwise null.
 *
 * Exported because the caller must know WHICH date to probe for fill state
 * before it can answer `yesterdayIsFilled`. Cheap: the formatter is cached.
 */
export function gapFillCandidate(ctx: LocalDateContext): LocalDate | null {
  const { date, minutesIntoDay } = civilInZone(ctx.loggedAt, ctx.timeZone);
  // Strict <: a log at exactly the closing minute is outside the window.
  //
  // This is a WALL-CLOCK comparison, deliberately. On fall-back day a
  // 00:00-02:00 window covers three real hours (01:30 happens twice and both
  // map to minute 90); on spring-forward day it covers one, because 02:00 never
  // happens. A deadline is a promise about the clock the user is looking at, and
  // a grace window is a kindness, so erring long on the longer day is right.
  return minutesIntoDay < graceOverflowMinutes(ctx.deadlineTime, ctx.graceMinutes)
    ? previousDay(date)
    : null;
}

/**
 * DR-001: the grace window FILLS GAPS, it never overwrites.
 *
 * Deadline 23:00, grace 120, log at 00:30. Yesterday has no qualifying entry:
 * this is a late log and it saves the tower -> yesterday. Yesterday already has
 * one: this is a midnight run -> today. The naive "always attach to yesterday"
 * rule would trip one_qualifying_entry_per_day for someone who logged at 20:00
 * and again at 00:30, rejecting a log for a day they weren't trying to log. The
 * branch is explicit so the index stays a backstop, not the decision-maker.
 */
export function resolveLocalDate(
  args: LocalDateContext & { yesterdayIsFilled: boolean }
): LocalDate {
  const { date } = civilInZone(args.loggedAt, args.timeZone);
  const candidate = gapFillCandidate(args);
  return candidate !== null && !args.yesterdayIsFilled ? candidate : date;
}

/**
 * Mirror image of resolveLocalDate, for counts_toward_quota = false rows.
 *
 * A credited log FILLS the gap; a supplemental log JOINS the credit. A
 * supplemental at 00:30 must land on the date that already holds the qualifying
 * entry, or SUM(numeric_value) for that date undercounts and the orphan row
 * inflates the next day's roll-up instead. The inverted test on
 * yesterdayIsFilled is intentional, not a typo.
 */
export function resolveSupplementalLocalDate(
  args: LocalDateContext & { yesterdayIsFilled: boolean }
): LocalDate {
  const { date } = civilInZone(args.loggedAt, args.timeZone);
  const candidate = gapFillCandidate(args);
  return candidate !== null && args.yesterdayIsFilled ? candidate : date;
}
