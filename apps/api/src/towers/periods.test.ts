import { computePeriodWindow } from '@tower-of-habit/shared';
import { describe, expect, it } from 'vitest';
import { firstPeriodStart, periodWindowFor } from './periods.js';

/*
 * 2.15: period 1 starts on the tower-local date of the start instant, unless
 * that instant is already past the day's deadline, in which case it starts
 * the next day. Pure, so it is unit-tested without Postgres.
 */

const tower = {
  periodUnit: 'day' as const,
  timezone: 'America/Regina', // no DST: a clean control
  deadlineTime: '22:00:00',
  graceWindowMinutes: 120,
  wobbleLeadMinutes: 120,
  nudgeLeadMinutes: 240,
  weekResetDay: null,
};

describe('firstPeriodStart', () => {
  it('is the tower-local date of the start instant before the deadline', () => {
    // 2026-11-16 20:00 Regina (UTC-6) = 02:00Z on the 17th.
    expect(firstPeriodStart(tower, new Date('2026-11-17T02:00:00Z'))).toBe('2026-11-16');
  });

  it('is the next day once the start instant has reached the deadline', () => {
    // 22:00 Regina exactly.
    expect(firstPeriodStart(tower, new Date('2026-11-17T04:00:00Z'))).toBe('2026-11-17');
    // 23:00 Regina.
    expect(firstPeriodStart(tower, new Date('2026-11-17T05:00:00Z'))).toBe('2026-11-17');
  });

  it('starts today while inside the grace window of yesterday’s deadline (today is a new day)', () => {
    // 00:30 Regina on the 17th: yesterday's grace window is open, but period 1
    // is about commitments going forward, so it starts on the 17th.
    expect(firstPeriodStart(tower, new Date('2026-11-17T06:30:00Z'))).toBe('2026-11-17');
  });

  it('respects the tower zone, not the acting member’s', () => {
    const tokyo = { ...tower, timezone: 'Asia/Tokyo' };
    // 2026-11-17T13:30Z is 22:30 in Tokyo: past the deadline there.
    expect(firstPeriodStart(tokyo, new Date('2026-11-17T13:30:00Z'))).toBe('2026-11-18');
  });
});

describe('periodWindowFor', () => {
  it('is computePeriodWindow for the period’s start date (one window, every caller)', () => {
    const w = periodWindowFor(tower, '2026-11-16');
    expect(w).toEqual(computePeriodWindow(tower, '2026-11-16'));
    expect(w.deadlineAt).toBe('2026-11-17T04:00:00.000Z');
    expect(w.evaluateAt).toBe('2026-11-17T06:00:00.000Z');
  });
});
