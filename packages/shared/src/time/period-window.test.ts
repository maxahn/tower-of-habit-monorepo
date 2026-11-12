import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  civilInZone,
  dayOfWeek,
  daysBetween,
  InvalidLocalDateInputError,
  previousDay,
} from './local-date.js';
import {
  computePeriodWindow,
  periodBoundsFor,
  periodInstants,
  resolvePeriodWindow,
  type PeriodConfig,
  type PeriodSchedule,
  type PeriodScheduleConfig,
} from './period-window.js';
import { wallClockToInstant } from './wall-clock.js';

const EDM = 'America/Edmonton';
const daily: PeriodConfig = {
  periodUnit: 'day',
  periodLength: 1,
  weekResetDay: null,
  anchorDate: '2026-03-01',
};

describe('civil date arithmetic', () => {
  it.each([
    ['2026-03-07', 1, '2026-03-08'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2028-03-01', -1, '2028-02-29'],
    ['0099-01-01', -1, '0098-12-31'], // Date.UTC would have mapped this to 19xx
    ['2026-03-08', 0, '2026-03-08'],
  ])('addDays(%s, %i) = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it('daysBetween is signed and DST-blind', () => {
    expect(daysBetween('2026-03-01', '2026-03-15')).toBe(14);
    expect(daysBetween('2026-03-15', '2026-03-01')).toBe(-14);
    expect(daysBetween('2026-10-25', '2026-11-08')).toBe(14);
  });

  it.each([
    ['2026-03-08', 0], // Sunday
    ['2026-03-09', 1],
    ['2026-03-14', 6],
  ])('dayOfWeek(%s) = %i', (date, expected) => {
    expect(dayOfWeek(date)).toBe(expected);
  });

  it('previousDay still rolls months', () => {
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
  });
});

describe('periodBoundsFor', () => {
  it('gives daily periods of one day', () => {
    expect(periodBoundsFor(daily, '2026-03-08')).toEqual({
      periodStart: '2026-03-08',
      periodEnd: '2026-03-08',
    });
  });

  it('steps multi-day periods off the anchor', () => {
    const config = { ...daily, periodLength: 3 };
    expect(periodBoundsFor(config, '2026-03-01')).toEqual({
      periodStart: '2026-03-01',
      periodEnd: '2026-03-03',
    });
    expect(periodBoundsFor(config, '2026-03-05')).toEqual({
      periodStart: '2026-03-04',
      periodEnd: '2026-03-06',
    });
  });

  it('puts a date before the anchor in period -1, not 0', () => {
    expect(periodBoundsFor({ ...daily, periodLength: 3 }, '2026-02-28')).toEqual({
      periodStart: '2026-02-26',
      periodEnd: '2026-02-28',
    });
  });

  // Tower activated Thursday 2026-03-05, weeks reset on Monday (1).
  const weekly: PeriodConfig = {
    periodUnit: 'week',
    periodLength: 1,
    weekResetDay: 1,
    anchorDate: '2026-03-05',
  };

  it('snaps a weekly anchor back to the most recent reset day', () => {
    expect(periodBoundsFor(weekly, '2026-03-05')).toEqual({
      periodStart: '2026-03-02',
      periodEnd: '2026-03-08',
    });
  });

  it.each([
    ['2026-03-08', '2026-03-02'], // Sunday: last day of the first week
    ['2026-03-09', '2026-03-09'], // Monday: a new week
    ['2026-11-01', '2026-10-26'], // across fall-back, boundaries don't drift
  ])('weekly period for %s starts %s, always a reset day', (on, start) => {
    const b = periodBoundsFor(weekly, on);
    expect(b.periodStart).toBe(start);
    expect(dayOfWeek(b.periodStart)).toBe(1);
    expect(daysBetween(b.periodStart, b.periodEnd)).toBe(6);
  });

  it('keeps an anchor that already is the reset day', () => {
    expect(periodBoundsFor({ ...weekly, anchorDate: '2026-03-09' }, '2026-03-09').periodStart).toBe(
      '2026-03-09'
    );
  });

  it('handles fortnightly periods with a Sunday reset', () => {
    const config = { ...weekly, periodLength: 2, weekResetDay: 0 };
    expect(periodBoundsFor(config, '2026-03-20')).toEqual({
      periodStart: '2026-03-15',
      periodEnd: '2026-03-28',
    });
  });

  it.each([
    { ...daily, periodLength: 0 },
    { ...daily, periodLength: 1.5 },
    { ...weekly, weekResetDay: null },
    { ...weekly, weekResetDay: 7 },
    { ...weekly, weekResetDay: -1 },
  ])('rejects %j', (config) => {
    expect(() => periodBoundsFor(config, '2026-03-08')).toThrow(InvalidLocalDateInputError);
  });
});

describe('periodInstants', () => {
  // THE case the ticket calls out. 01:00 MST is 08:00Z; two REAL hours later is
  // 10:00Z, which the wall clock reads as 04:00 because an hour vanished in
  // between. Adding two hours to the wall clock would say 03:00 = 09:00Z: sixty
  // minutes early, collapsing a tower whose member logged at 03:30.
  it('never evaluates early on a spring-forward night', () => {
    const i = periodInstants({
      periodEnd: '2026-03-08',
      deadlineTime: '01:00',
      timeZone: EDM,
      graceMinutes: 120,
    });
    expect(i.deadlineAt.toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(i.evaluateAt.toISOString()).toBe('2026-03-08T10:00:00.000Z');
    expect(i.evaluateAt.getTime() - i.deadlineAt.getTime()).toBe(120 * 60_000);
  });

  it('never evaluates late on a fall-back night', () => {
    const i = periodInstants({
      periodEnd: '2026-11-01',
      deadlineTime: '00:30',
      timeZone: EDM,
      graceMinutes: 120,
    });
    expect(i.evaluateAt.toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });

  it('reports an irregular deadline', () => {
    expect(
      periodInstants({
        periodEnd: '2026-03-08',
        deadlineTime: '02:30',
        timeZone: EDM,
        graceMinutes: 0,
      })
    ).toMatchObject({ deadlineKind: 'gap', deadlineAt: new Date('2026-03-08T09:30:00.000Z') });
  });

  it('collapses to one instant at grace 0', () => {
    const i = periodInstants({
      periodEnd: '2026-03-07',
      deadlineTime: '22:00',
      timeZone: EDM,
      graceMinutes: 0,
    });
    expect(i.evaluateAt).toEqual(i.deadlineAt);
  });

  it.each([-1, 1.5])('rejects grace %s', (graceMinutes) => {
    expect(() =>
      periodInstants({
        periodEnd: '2026-03-07',
        deadlineTime: '22:00',
        timeZone: EDM,
        graceMinutes,
      })
    ).toThrow(InvalidLocalDateInputError);
  });
});

describe('resolvePeriodWindow', () => {
  it('resolves a weekly deadline on the LAST day of the period', () => {
    const w = resolvePeriodWindow({
      periodUnit: 'week',
      periodLength: 1,
      weekResetDay: 1,
      anchorDate: '2026-03-05',
      on: '2026-03-05',
      deadlineTime: '22:00',
      timeZone: EDM,
      graceMinutes: 120,
    });
    expect(w).toEqual({
      periodStart: '2026-03-02',
      periodEnd: '2026-03-08',
      // Sunday 22:00 MDT, the shift happened that morning.
      deadlineAt: new Date('2026-03-09T04:00:00.000Z'),
      evaluateAt: new Date('2026-03-09T06:00:00.000Z'),
      deadlineKind: 'exact',
    });
  });

  it('passes the policy through', () => {
    const w = resolvePeriodWindow({
      ...daily,
      on: '2026-11-01',
      deadlineTime: '01:30',
      timeZone: EDM,
      graceMinutes: 0,
      policy: 'earlier',
    });
    expect(w.deadlineAt.toISOString()).toBe('2026-11-01T07:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// 2.2 computePeriodWindow
//
// Edmonton 2027: MST -> MDT at 2027-03-14T09:00Z (02:00-02:59 never happens);
// MDT -> MST at 2027-11-07T08:00Z (01:00-01:59 happens twice).
// Chatham 2027: +13:45 -> +12:45 at 2027-04-03T14:00Z (02:45-03:44 twice);
// +12:45 -> +13:45 at 2027-09-25T14:00Z (02:45-03:44 never happens).
// ---------------------------------------------------------------------------

const MIN = 60_000;

const tower: PeriodScheduleConfig = {
  periodUnit: 'day',
  timezone: 'UTC',
  deadlineTime: '22:00',
  graceWindowMinutes: 120,
  wobbleLeadMinutes: 120,
  nudgeLeadMinutes: 240,
  weekResetDay: null,
};

const ms = (iso: string) => new Date(iso).getTime();

describe('computePeriodWindow — zone table (daily)', () => {
  const rows: {
    name: string;
    tz: string;
    start: string;
    time?: string;
    expected: Omit<PeriodSchedule, 'periodStart' | 'periodEnd'>;
  }[] = [
    {
      name: 'Regina, no DST (control) on the Edmonton spring-forward date',
      tz: 'America/Regina',
      start: '2027-03-14',
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
      // Spec edge: wobbleAt (05:30Z = 23:30 the day before) is NOT floored, but
      // nudgeAt is floored to local midnight (06:00Z), so here the nudge comes
      // AFTER the wobble. Asserted as the spec is written; revisit if the
      // nudge-before-wobble rule (towers_nudge_before_wobble) must hold here too.
      name: 'Edmonton fall-back ambiguous: 01:30 -> first occurrence (MDT)',
      tz: 'America/Edmonton',
      start: '2027-11-07',
      time: '01:30',
      expected: {
        nudgeAt: '2027-11-07T06:00:00.000Z',
        wobbleAt: '2027-11-07T05:30:00.000Z',
        deadlineAt: '2027-11-07T07:30:00.000Z',
        evaluateAt: '2027-11-07T09:30:00.000Z',
      },
    },
    {
      name: 'Kolkata, half-hour offset (+05:30)',
      tz: 'Asia/Kolkata',
      start: '2027-06-15',
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
      expected: {
        nudgeAt: '2027-03-14T18:00:00.000Z',
        wobbleAt: '2027-03-14T20:00:00.000Z',
        deadlineAt: '2027-03-14T22:00:00.000Z',
        evaluateAt: '2027-03-15T00:00:00.000Z',
      },
    },
  ];

  it.each(rows)('$name', ({ tz, start, time, expected }) => {
    const w = computePeriodWindow(
      { ...tower, timezone: tz, deadlineTime: time ?? tower.deadlineTime },
      start
    );
    // Daily cadence: periodEnd === periodStart.
    expect(w).toEqual({ periodStart: start, periodEnd: start, ...expected });
  });

  // The acceptance criteria as properties, so a wrong row above can't hide a
  // wrong formula.
  it.each(rows)('$name: offsets are real intervals off deadlineAt', ({ tz, start, time }) => {
    const w = computePeriodWindow(
      { ...tower, timezone: tz, deadlineTime: time ?? tower.deadlineTime },
      start
    );
    const deadline = ms(w.deadlineAt);
    expect(ms(w.evaluateAt) - deadline).toBe(tower.graceWindowMinutes * MIN);
    expect(deadline - ms(w.wobbleAt)).toBe(tower.wobbleLeadMinutes * MIN);
    const floor = wallClockToInstant(start, '00:00', tz, 'forward').getTime();
    expect(ms(w.nudgeAt)).toBe(Math.max(deadline - tower.nudgeLeadMinutes * MIN, floor));
  });
});

describe('computePeriodWindow — weekly cadence [v2]', () => {
  // Weeks reset on Monday. 2027-03-08 is a Monday; 2027-03-14 is the
  // Edmonton spring-forward Sunday.
  const weekly: PeriodScheduleConfig = {
    ...tower,
    periodUnit: 'week',
    weekResetDay: 1,
    timezone: 'America/Edmonton',
  };

  it('ends the day before the next reset day, deadline on that last day', () => {
    expect(dayOfWeek('2027-03-08')).toBe(1);
    expect(computePeriodWindow(weekly, '2027-03-08')).toEqual({
      periodStart: '2027-03-08',
      periodEnd: '2027-03-14',
      // Sunday 22:00 MDT: the shift happened that morning.
      nudgeAt: '2027-03-15T00:00:00.000Z',
      wobbleAt: '2027-03-15T02:00:00.000Z',
      deadlineAt: '2027-03-15T04:00:00.000Z',
      evaluateAt: '2027-03-15T06:00:00.000Z',
    });
  });

  it('a start ON the reset day spans the full seven days', () => {
    const w = computePeriodWindow(weekly, '2027-03-08');
    expect(daysBetween(w.periodStart, w.periodEnd)).toBe(6);
  });

  it('a mid-week start runs to the day before the next reset day', () => {
    // Wednesday 2027-03-10 -> Sunday 2027-03-14.
    expect(computePeriodWindow(weekly, '2027-03-10').periodEnd).toBe('2027-03-14');
    // The day before the reset day -> that same day.
    expect(computePeriodWindow(weekly, '2027-03-14').periodEnd).toBe('2027-03-14');
  });

  it('honours a Sunday reset day', () => {
    // Sunday reset -> periods end on Saturday.
    const w = computePeriodWindow({ ...weekly, weekResetDay: 0 }, '2027-03-10');
    expect(w.periodEnd).toBe('2027-03-13');
    expect(dayOfWeek(w.periodEnd)).toBe(6);
  });

  it.each([null, 7, -1, 1.5])('rejects weekResetDay %j', (weekResetDay) => {
    expect(() => computePeriodWindow({ ...weekly, weekResetDay }, '2027-03-08')).toThrow(
      InvalidLocalDateInputError
    );
  });
});

describe('computePeriodWindow — nudge floor', () => {
  it('floors nudgeAt at periodStart 00:00 local for an early deadline', () => {
    // 03:00 MDT = 09:00Z; minus 240 is 05:00Z = 23:00 the day before.
    const w = computePeriodWindow(
      { ...tower, timezone: 'America/Edmonton', deadlineTime: '03:00' },
      '2027-06-15'
    );
    expect(w.deadlineAt).toBe('2027-06-15T09:00:00.000Z');
    expect(w.nudgeAt).toBe('2027-06-15T06:00:00.000Z'); // 00:00 MDT
  });

  it('resolves the floor forward when local midnight itself is a gap', () => {
    // Santiago springs forward AT midnight on 2026-09-06: 00:00 -04 jumps to
    // 01:00 -03 (04:00Z). The floor is that transition instant.
    const w = computePeriodWindow(
      { ...tower, timezone: 'America/Santiago', deadlineTime: '03:00' },
      '2026-09-06'
    );
    expect(w).toEqual({
      periodStart: '2026-09-06',
      periodEnd: '2026-09-06',
      nudgeAt: '2026-09-06T04:00:00.000Z',
      wobbleAt: '2026-09-06T04:00:00.000Z',
      deadlineAt: '2026-09-06T06:00:00.000Z',
      evaluateAt: '2026-09-06T08:00:00.000Z',
    });
  });

  it('leaves nudgeAt alone when it is already after local midnight', () => {
    const w = computePeriodWindow(tower, '2027-03-14');
    expect(ms(w.deadlineAt) - ms(w.nudgeAt)).toBe(tower.nudgeLeadMinutes * MIN);
  });

  it('uses nudgeLeadMinutes, not a multiple of wobbleLeadMinutes', () => {
    const w = computePeriodWindow(
      { ...tower, wobbleLeadMinutes: 30, nudgeLeadMinutes: 90 },
      '2027-03-14'
    );
    expect(w.wobbleAt).toBe('2027-03-14T21:30:00.000Z');
    expect(w.nudgeAt).toBe('2027-03-14T20:30:00.000Z');
  });
});

describe('computePeriodWindow — tower zone owns "today" (D3)', () => {
  const regina: PeriodScheduleConfig = { ...tower, timezone: 'America/Regina' };

  it('ignores the acting member and the host process zone', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Kolkata';
      const fromKolkata = computePeriodWindow(regina, '2027-03-14');
      process.env.TZ = 'Pacific/Honolulu';
      const fromHonolulu = computePeriodWindow(regina, '2027-03-14');
      expect(fromKolkata).toEqual(fromHonolulu);
      expect(fromKolkata.deadlineAt).toBe('2027-03-15T04:00:00.000Z');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("puts a far-away member's deadline at an odd local hour, on a different date", () => {
    // 22:00 in Regina is 09:30 the NEXT morning in Kolkata. The lobby UI has
    // to surface this; the model deliberately doesn't adjust for it.
    const w = computePeriodWindow(regina, '2027-03-14');
    expect(civilInZone(new Date(w.deadlineAt), 'Asia/Kolkata')).toEqual({
      date: '2027-03-15',
      minutesIntoDay: 9 * 60 + 30,
    });
    // periodStart/periodEnd stay tower-local regardless.
    expect(w.periodEnd).toBe('2027-03-14');
  });
});

describe('computePeriodWindow — purity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the same answer whatever the system clock says', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('1999-12-31T23:59:59Z'));
    const a = computePeriodWindow(tower, '2027-03-14');
    vi.setSystemTime(new Date('2099-06-15T12:00:00Z'));
    const b = computePeriodWindow(tower, '2027-03-14');
    expect(a).toEqual(b);
  });

  // The static half of this check (no clock reads in the module graph) lives
  // in test/time-purity.test.ts: node:fs is banned under src/ (Hermes).
});

describe('computePeriodWindow — inputs', () => {
  it("accepts the Postgres read-back form '22:00:00'", () => {
    expect(computePeriodWindow({ ...tower, deadlineTime: '22:00:00' }, '2027-03-14')).toEqual(
      computePeriodWindow(tower, '2027-03-14')
    );
  });

  it('collapses evaluateAt onto deadlineAt at grace 0', () => {
    const w = computePeriodWindow({ ...tower, graceWindowMinutes: 0 }, '2027-03-14');
    expect(w.evaluateAt).toBe(w.deadlineAt);
  });

  it('returns ISO instants, not Dates', () => {
    const w = computePeriodWindow(tower, '2027-03-14');
    for (const k of ['nudgeAt', 'wobbleAt', 'deadlineAt', 'evaluateAt'] as const) {
      expect(typeof w[k]).toBe('string');
      expect(new Date(w[k]).toISOString()).toBe(w[k]);
    }
  });

  it.each([
    ['a malformed periodStart', {}, '2027-3-14'],
    ['an unknown zone', { timezone: 'Not/AZone' }, '2027-03-14'],
    ['a bad deadline', { deadlineTime: '25:00' }, '2027-03-14'],
    ['a negative grace', { graceWindowMinutes: -1 }, '2027-03-14'],
    ['a fractional grace', { graceWindowMinutes: 1.5 }, '2027-03-14'],
    ['a negative wobble lead', { wobbleLeadMinutes: -1 }, '2027-03-14'],
    ['a fractional nudge lead', { nudgeLeadMinutes: 1.5 }, '2027-03-14'],
  ] as const)('rejects %s', (_label, patch, start) => {
    expect(() => computePeriodWindow({ ...tower, ...patch }, start)).toThrow(
      InvalidLocalDateInputError
    );
  });
});
