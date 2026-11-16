import type { LocalDate } from '../time/local-date.js';
import type { PeriodSchedule, PeriodScheduleConfig } from '../time/period-window.js';

/*
 * 2.2's computePeriodWindow zone table, shared so 2.7 can run the same rows
 * through a full evaluation (src/evaluator/suite.dst.test.ts) and not just
 * window computation (src/time/period-window.test.ts). One table, so the two
 * suites can't drift.
 *
 * TODO(tzdata-2026c)[denver]: Edmonton has no 2027 transitions under tzdata >= 2026c. Swap
 * the Edmonton rows (and the weekly block) to America/Denver, which has these
 * exact instants, and add an Edmonton no-DST control row; see packages/shared/src/time/TZDATA.md.
 * Edmonton 2027: MST -> MDT at 2027-03-14T09:00Z (02:00-02:59 never happens);
 * MDT -> MST at 2027-11-07T08:00Z (01:00-01:59 happens twice).
 * Chatham 2027: +13:45 -> +12:45 at 2027-04-03T14:00Z (02:45-03:44 twice);
 * +12:45 -> +13:45 at 2027-09-25T14:00Z (02:45-03:44 never happens).
 */

/** The schedule every row is computed with; only the zone and deadline vary. */
export const ZONE_TABLE_TOWER: PeriodScheduleConfig = {
  periodUnit: 'day',
  timezone: 'UTC',
  deadlineTime: '22:00',
  graceWindowMinutes: 120,
  wobbleLeadMinutes: 120,
  nudgeLeadMinutes: 240,
  weekResetDay: null,
};

export type ZoneWindowRow = {
  name: string;
  tz: string;
  start: LocalDate;
  /** Deadline override; ZONE_TABLE_TOWER.deadlineTime otherwise. */
  time?: string;
  /** True for the rows that sit on a DST transition (gap or overlap). */
  dst: boolean;
  expected: Omit<PeriodSchedule, 'periodStart' | 'periodEnd'>;
};

export const ZONE_WINDOW_ROWS: readonly ZoneWindowRow[] = [
  {
    name: 'Regina, no DST (control) on the Edmonton spring-forward date',
    tz: 'America/Regina',
    start: '2027-03-14',
    dst: false,
    expected: {
      nudgeAt: '2027-03-15T00:00:00.000Z',
      wobbleAt: '2027-03-15T02:00:00.000Z',
      deadlineAt: '2027-03-15T04:00:00.000Z',
      evaluateAt: '2027-03-15T06:00:00.000Z',
    },
  },
  {
    name: 'Regina, no DST (control) on the Edmonton fall-back date: same UTC-6',
    tz: 'America/Regina',
    start: '2027-11-07',
    dst: false,
    expected: {
      nudgeAt: '2027-11-08T00:00:00.000Z',
      wobbleAt: '2027-11-08T02:00:00.000Z',
      deadlineAt: '2027-11-08T04:00:00.000Z',
      evaluateAt: '2027-11-08T06:00:00.000Z',
    },
  },
  {
    name: 'Edmonton spring-forward day, ordinary deadline (already MDT)',
    tz: 'America/Edmonton',
    start: '2027-03-14',
    dst: true,
    expected: {
      nudgeAt: '2027-03-15T00:00:00.000Z',
      wobbleAt: '2027-03-15T02:00:00.000Z',
      deadlineAt: '2027-03-15T04:00:00.000Z',
      evaluateAt: '2027-03-15T06:00:00.000Z',
    },
  },
  {
    // 02:30 never happens: resolves FORWARD to 03:00 MDT, the transition
    // instant. Not 03:30 ('later'), which would lengthen the period.
    // wobbleAt lands exactly on local midnight (07:00Z, still MST); nudgeAt
    // (05:00Z = 22:00 the day before) is floored to that midnight.
    name: 'Edmonton spring-forward gap: 02:30 -> 03:00 MDT',
    tz: 'America/Edmonton',
    start: '2027-03-14',
    time: '02:30',
    dst: true,
    expected: {
      nudgeAt: '2027-03-14T07:00:00.000Z',
      wobbleAt: '2027-03-14T07:00:00.000Z',
      deadlineAt: '2027-03-14T09:00:00.000Z',
      evaluateAt: '2027-03-14T11:00:00.000Z',
    },
  },
  {
    name: 'Edmonton fall-back day, ordinary deadline (MST)',
    tz: 'America/Edmonton',
    start: '2027-11-07',
    dst: true,
    expected: {
      nudgeAt: '2027-11-08T01:00:00.000Z',
      wobbleAt: '2027-11-08T03:00:00.000Z',
      deadlineAt: '2027-11-08T05:00:00.000Z',
      evaluateAt: '2027-11-08T07:00:00.000Z',
    },
  },
  {
    // 01:30 happens twice: the FIRST (MDT, 07:30Z), not the second (08:30Z).
    // evaluateAt is 09:30Z, not 10:30Z.
    //
    // Both leads would land the night before (wobble 05:30Z = 23:30, nudge
    // 03:30Z), so both are floored to local midnight (06:00Z, MDT) and
    // coincide: the nudge never comes after the wobble.
    name: 'Edmonton fall-back ambiguous: 01:30 -> first occurrence (MDT)',
    tz: 'America/Edmonton',
    start: '2027-11-07',
    time: '01:30',
    dst: true,
    expected: {
      nudgeAt: '2027-11-07T06:00:00.000Z',
      wobbleAt: '2027-11-07T06:00:00.000Z',
      deadlineAt: '2027-11-07T07:30:00.000Z',
      evaluateAt: '2027-11-07T09:30:00.000Z',
    },
  },
  {
    name: 'Kolkata, half-hour offset (+05:30)',
    tz: 'Asia/Kolkata',
    start: '2027-06-15',
    dst: false,
    expected: {
      nudgeAt: '2027-06-15T12:30:00.000Z',
      wobbleAt: '2027-06-15T14:30:00.000Z',
      deadlineAt: '2027-06-15T16:30:00.000Z',
      evaluateAt: '2027-06-15T18:30:00.000Z',
    },
  },
  {
    name: 'Chatham, 45-minute offset (+12:45)',
    tz: 'Pacific/Chatham',
    start: '2027-06-15',
    dst: false,
    expected: {
      nudgeAt: '2027-06-15T05:15:00.000Z',
      wobbleAt: '2027-06-15T07:15:00.000Z',
      deadlineAt: '2027-06-15T09:15:00.000Z',
      evaluateAt: '2027-06-15T11:15:00.000Z',
    },
  },
  {
    // 03:00 falls in the 02:45-03:44 hole: forward to 03:45 +13:45 = 14:00Z.
    // Midnight is 00:00 +12:45 = 11:15Z, so nudgeAt (10:00Z) is floored.
    name: 'Chatham spring-forward gap: 03:00 -> 03:45 (+13:45)',
    tz: 'Pacific/Chatham',
    start: '2027-09-26',
    time: '03:00',
    dst: true,
    expected: {
      nudgeAt: '2027-09-25T11:15:00.000Z',
      wobbleAt: '2027-09-25T12:00:00.000Z',
      deadlineAt: '2027-09-25T14:00:00.000Z',
      evaluateAt: '2027-09-25T16:00:00.000Z',
    },
  },
  {
    // 03:00 happens twice: first at +13:45 (13:15Z), not +12:45 (14:15Z).
    // Midnight is 00:00 +13:45 = 10:15Z, so nudgeAt (09:15Z) is floored.
    name: 'Chatham fall-back ambiguous: 03:00 -> first occurrence (+13:45)',
    tz: 'Pacific/Chatham',
    start: '2027-04-04',
    time: '03:00',
    dst: true,
    expected: {
      nudgeAt: '2027-04-03T10:15:00.000Z',
      wobbleAt: '2027-04-03T11:15:00.000Z',
      deadlineAt: '2027-04-03T13:15:00.000Z',
      evaluateAt: '2027-04-03T15:15:00.000Z',
    },
  },
  {
    name: 'UTC',
    tz: 'UTC',
    start: '2027-03-14',
    dst: false,
    expected: {
      nudgeAt: '2027-03-14T18:00:00.000Z',
      wobbleAt: '2027-03-14T20:00:00.000Z',
      deadlineAt: '2027-03-14T22:00:00.000Z',
      evaluateAt: '2027-03-15T00:00:00.000Z',
    },
  },
];

/** The row's tower schedule: ZONE_TABLE_TOWER with its zone and deadline. */
export const zoneRowSchedule = (row: ZoneWindowRow): PeriodScheduleConfig => ({
  ...ZONE_TABLE_TOWER,
  timezone: row.tz,
  deadlineTime: row.time ?? ZONE_TABLE_TOWER.deadlineTime,
});
