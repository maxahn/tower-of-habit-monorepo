import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfWeek,
  daysBetween,
  InvalidLocalDateInputError,
  previousDay,
} from './local-date.js';
import {
  periodBoundsFor,
  periodInstants,
  resolvePeriodWindow,
  type PeriodConfig,
} from './period-window.js';

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
