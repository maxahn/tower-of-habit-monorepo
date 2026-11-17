import { describe, expect, it } from 'vitest';
import { currentStreak } from './streak.js';

/*
 * 2.12: GET /habits/:id includes the current streak: consecutive qualifying
 * days ending today or yesterday (today may not be logged yet). Pure: the
 * dates and "today" are injected.
 */

describe('currentStreak', () => {
  it('counts consecutive days ending today', () => {
    expect(currentStreak(['2026-11-16', '2026-11-15', '2026-11-14'], '2026-11-16')).toBe(3);
  });

  it('counts a run ending yesterday (today not logged yet)', () => {
    expect(currentStreak(['2026-11-15', '2026-11-14'], '2026-11-16')).toBe(2);
  });

  it('is zero when the latest qualifying day is before yesterday', () => {
    expect(currentStreak(['2026-11-14', '2026-11-13'], '2026-11-16')).toBe(0);
  });

  it('stops at the first gap', () => {
    expect(currentStreak(['2026-11-16', '2026-11-15', '2026-11-12'], '2026-11-16')).toBe(2);
  });

  it('is zero with no qualifying days', () => {
    expect(currentStreak([], '2026-11-16')).toBe(0);
  });

  it('accepts dates in any order and ignores duplicates and future dates', () => {
    expect(
      currentStreak(['2026-11-15', '2026-11-16', '2026-11-16', '2026-11-17'], '2026-11-16')
    ).toBe(2);
  });

  it('crosses a month boundary', () => {
    expect(currentStreak(['2026-11-01', '2026-10-31', '2026-10-30'], '2026-11-01')).toBe(3);
  });
});
