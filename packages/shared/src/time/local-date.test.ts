import { describe, expect, it } from 'vitest';
import {
  civilInZone,
  DEFAULT_GRACE_WINDOW_MINUTES,
  gapFillCandidate,
  graceOverflowMinutes,
  InvalidLocalDateInputError,
  parseDeadlineMinutes,
  previousDay,
  resolveLocalDate,
  resolveSupplementalLocalDate,
  SOLO_DEADLINE_TIME,
} from './local-date.js';

const EDM = 'America/Edmonton';

/** Edmonton is MDT (-06:00) in October, so 06:30Z is 00:30 local the same day. */
function edmonton(utc: string) {
  return new Date(utc);
}

describe('parseDeadlineMinutes', () => {
  it.each([
    ['22:00', 1320], // DEFAULT_DEADLINE_TIME, as the client sends it
    ['22:00:00', 1320], // as Postgres `time` reads back
    ['22:00:00.000', 1320], // as Postgres can render it
    ['24:00', 1440], // SOLO_DEADLINE_TIME
    ['00:00', 0],
    ['23:59', 1439],
  ])('parses %s as %i minutes', (input, expected) => {
    expect(parseDeadlineMinutes(input)).toBe(expected);
  });

  it.each(['', '2:00', '24:01', '24:00:01', '25:00', '22:60', '22:00:60', '22', 'abc', '22:0'])(
    'rejects %j',
    (input) => {
      expect(() => parseDeadlineMinutes(input)).toThrow(InvalidLocalDateInputError);
    }
  );
});

describe('graceOverflowMinutes', () => {
  it.each([
    ['23:00', 120, 60], // the ticket's example: window closes at 01:00
    ['22:00', 120, 0], // DEFAULT_DEADLINE_TIME: closes exactly at midnight
    ['22:00', 360, 240], // the towers_grace_window_range maximum
    ['23:00', 0, 0], // hard cliff
    ['24:00', 0, 0],
    [SOLO_DEADLINE_TIME, DEFAULT_GRACE_WINDOW_MINUTES, 120], // solo habits
    // The trap. '00:00' looks like "midnight boundary" but means minute 0, so
    // the overflow clamps to 0 and solo habits silently get no grace at all.
    // SOLO_DEADLINE_TIME is '24:00' precisely to avoid this.
    ['00:00', 120, 0],
  ])('%s + %i grace spills %i minutes past midnight', (deadline, grace, expected) => {
    expect(graceOverflowMinutes(deadline, grace)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN])('rejects a grace of %j', (grace) => {
    expect(() => graceOverflowMinutes('23:00', grace)).toThrow(InvalidLocalDateInputError);
  });
});

describe('previousDay', () => {
  it.each([
    ['2026-10-25', '2026-10-24'],
    ['2026-03-01', '2026-02-28'], // non-leap February
    ['2028-03-01', '2028-02-29'], // leap February
    ['2027-01-01', '2026-12-31'], // year rollover
    ['2026-11-01', '2026-10-31'], // month rollover
  ])('%s -> %s', (input, expected) => {
    expect(previousDay(input)).toBe(expected);
  });

  it.each(['', '2026-1-1', 'nope', '2026/10/25'])('rejects %j', (input) => {
    expect(() => previousDay(input)).toThrow(InvalidLocalDateInputError);
  });
});

describe('civilInZone', () => {
  // Regression test for hourCycle. hour12:false and hourCycle:'h24' both render
  // local midnight as hour '24', which would put minutesIntoDay at 1440 and
  // break every gap-fill comparison.
  it('reports local midnight as minute 0, not 1440', () => {
    expect(civilInZone(edmonton('2026-10-25T06:00:00Z'), EDM)).toEqual({
      date: '2026-10-25',
      minutesIntoDay: 0,
    });
  });

  it.each([
    ['Asia/Kolkata', '2026-10-24T19:00:00Z', '2026-10-25', 30], // +05:30
    ['Pacific/Chatham', '2026-10-24T11:00:00Z', '2026-10-25', 45], // +13:45 (DST)
    ['Pacific/Kiritimati', '2026-10-24T10:30:00Z', '2026-10-25', 30], // +14:00
    ['Pacific/Marquesas', '2026-10-25T10:00:00Z', '2026-10-25', 30], // -09:30
    ['UTC', '2026-10-25T00:30:00Z', '2026-10-25', 30],
  ])('handles the offset of %s', (zone, utc, date, minutesIntoDay) => {
    expect(civilInZone(new Date(utc), zone)).toEqual({ date, minutesIntoDay });
  });

  it('rejects an unknown zone and an invalid instant', () => {
    expect(() => civilInZone(new Date('2026-10-25T00:00:00Z'), 'Not/AZone')).toThrow(
      InvalidLocalDateInputError
    );
    expect(() => civilInZone(new Date('nope'), EDM)).toThrow(InvalidLocalDateInputError);
  });
});

describe('resolveLocalDate — DR-001 grace branches', () => {
  // The ticket's worked example: deadline 23:00, grace 120, so the window runs
  // 23:00 -> 01:00 and overflows 60 minutes past midnight.
  const ctx = { timeZone: EDM, deadlineTime: '23:00', graceMinutes: 120 };
  const at0030 = edmonton('2026-10-25T06:30:00Z');

  it('fills the gap: 00:30 with no qualifying entry yesterday resolves to yesterday', () => {
    expect(resolveLocalDate({ ...ctx, loggedAt: at0030, yesterdayIsFilled: false })).toBe(
      '2026-10-24'
    );
  });

  it('never overwrites: 00:30 when yesterday is already filled is a midnight run', () => {
    expect(resolveLocalDate({ ...ctx, loggedAt: at0030, yesterdayIsFilled: true })).toBe(
      '2026-10-25'
    );
  });

  it('closes the window exactly at 01:00', () => {
    // 00:59 is inside, 01:00 is out. Strict <, so the boundary minute is today.
    expect(
      resolveLocalDate({
        ...ctx,
        loggedAt: edmonton('2026-10-25T06:59:00Z'),
        yesterdayIsFilled: false,
      })
    ).toBe('2026-10-24');
    expect(
      resolveLocalDate({
        ...ctx,
        loggedAt: edmonton('2026-10-25T07:00:00Z'),
        yesterdayIsFilled: false,
      })
    ).toBe('2026-10-25');
  });

  it('leaves an ordinary daytime log on its own date', () => {
    // 20:00 local on the 24th. Nowhere near the window.
    expect(
      resolveLocalDate({
        ...ctx,
        loggedAt: edmonton('2026-10-25T02:00:00Z'),
        yesterdayIsFilled: false,
      })
    ).toBe('2026-10-24');
  });

  it('leaves a log between the deadline and midnight on its own date', () => {
    // 23:30 local on the 24th: after the deadline, still the same civil day.
    expect(
      resolveLocalDate({
        ...ctx,
        loggedAt: edmonton('2026-10-25T05:30:00Z'),
        yesterdayIsFilled: false,
      })
    ).toBe('2026-10-24');
  });
});

describe('resolveLocalDate — grace = 0 never gap-fills', () => {
  const ctx = { timeZone: EDM, deadlineTime: '23:00', graceMinutes: 0 };

  it('takes the gap-filling branch at no minute of the day', () => {
    // Exhaustive rather than sampled: the requirement is that the branch is
    // unreachable, which is a property of all 1440 minutes.
    const base = Date.UTC(2026, 9, 25, 6, 0); // 00:00 local
    const candidates = [];
    for (let m = 0; m < 1440; m += 1) {
      candidates.push(gapFillCandidate({ ...ctx, loggedAt: new Date(base + m * 60_000) }));
    }
    expect(candidates.every((c) => c === null)).toBe(true);
  });

  it('resolves a 00:30 log to today even with yesterday empty', () => {
    expect(
      resolveLocalDate({
        ...ctx,
        loggedAt: edmonton('2026-10-25T06:30:00Z'),
        yesterdayIsFilled: false,
      })
    ).toBe('2026-10-25');
  });
});

describe('resolveLocalDate — DST boundaries', () => {
  // Deadline 23:00 + 180 grace => overflow 120, so the window nominally closes
  // at 02:00 local, which is exactly where both transitions happen.
  const ctx = { timeZone: EDM, deadlineTime: '23:00', graceMinutes: 180 };
  const resolve = (utc: string) =>
    resolveLocalDate({ ...ctx, loggedAt: new Date(utc), yesterdayIsFilled: false });

  it('spring forward: the window shortens, and no instant falls in the hole', () => {
    // 2026-03-08, 02:00 MST jumps to 03:00 MDT. The window loses an hour.
    expect(resolve('2026-03-08T08:59:00Z')).toBe('2026-03-07'); // 01:59 MST, minute 119
    expect(resolve('2026-03-08T09:00:00Z')).toBe('2026-03-08'); // 03:00 MDT, minute 180
  });

  it('fall back: both passes through 01:30 resolve the same way', () => {
    // 2026-11-01, 02:00 MDT falls back to 01:00 MST, so 01:30 happens twice.
    // Both read as wall-clock minute 90, which is the point: a deadline is a
    // promise about the clock on the wall, so the window is simply longer today.
    expect(civilInZone(new Date('2026-11-01T07:30:00Z'), EDM).minutesIntoDay).toBe(90); // MDT
    expect(civilInZone(new Date('2026-11-01T08:30:00Z'), EDM).minutesIntoDay).toBe(90); // MST
    expect(resolve('2026-11-01T07:30:00Z')).toBe('2026-10-31');
    expect(resolve('2026-11-01T08:30:00Z')).toBe('2026-10-31');
    expect(resolve('2026-11-01T09:00:00Z')).toBe('2026-11-01'); // 02:00 MST, minute 120
  });

  it('derives the civil date correctly on both transition days', () => {
    expect(civilInZone(new Date('2026-03-08T09:00:00Z'), EDM).date).toBe('2026-03-08');
    expect(civilInZone(new Date('2026-11-01T08:30:00Z'), EDM).date).toBe('2026-11-01');
  });
});

describe('resolveLocalDate — standalone habit fallback (DR-001 §6)', () => {
  // No tower, so the day boundary is the owner's local midnight with the same
  // 120-minute default grace. Runs the identical code path.
  const solo = {
    deadlineTime: SOLO_DEADLINE_TIME,
    graceMinutes: DEFAULT_GRACE_WINDOW_MINUTES,
  };

  it.each([
    ['2026-10-24T18:30:00Z', '2026-10-24'], // 00:00 IST on the 25th
    ['2026-10-24T19:00:00Z', '2026-10-24'], // 00:30 IST
    ['2026-10-24T20:29:00Z', '2026-10-24'], // 01:59 IST
    ['2026-10-24T20:30:00Z', '2026-10-25'], // 02:00 IST: window closed
  ])('Asia/Kolkata log at %s resolves to %s', (utc, expected) => {
    expect(
      resolveLocalDate({
        ...solo,
        timeZone: 'Asia/Kolkata',
        loggedAt: new Date(utc),
        yesterdayIsFilled: false,
      })
    ).toBe(expected);
  });

  it('still never overwrites a filled yesterday', () => {
    expect(
      resolveLocalDate({
        ...solo,
        timeZone: 'UTC',
        loggedAt: new Date('2026-10-25T00:30:00Z'),
        yesterdayIsFilled: true,
      })
    ).toBe('2026-10-25');
  });
});

describe('resolveSupplementalLocalDate', () => {
  const ctx = { timeZone: EDM, deadlineTime: '23:00', graceMinutes: 120 };
  const at0030 = edmonton('2026-10-25T06:30:00Z');

  it('joins the credit: 00:30 attaches to yesterday when yesterday holds it', () => {
    expect(
      resolveSupplementalLocalDate({ ...ctx, loggedAt: at0030, yesterdayIsFilled: true })
    ).toBe('2026-10-24');
  });

  it('does not gap-fill: 00:30 with yesterday empty stays on today', () => {
    expect(
      resolveSupplementalLocalDate({ ...ctx, loggedAt: at0030, yesterdayIsFilled: false })
    ).toBe('2026-10-25');
  });

  // The regression test that matters: a credit logged before midnight and a
  // supplemental logged after it must land on ONE date, or SUM(numeric_value)
  // undercounts that date and the orphan inflates the next one.
  it('lands on the same date as a credit logged at 23:30', () => {
    const credited = resolveLocalDate({
      ...ctx,
      loggedAt: edmonton('2026-10-25T05:30:00Z'), // 23:30 local on the 24th
      yesterdayIsFilled: false,
    });
    const supplemental = resolveSupplementalLocalDate({
      ...ctx,
      loggedAt: at0030, // 00:30 local on the 25th
      yesterdayIsFilled: true, // the credit above filled it
    });
    expect(credited).toBe('2026-10-24');
    expect(supplemental).toBe(credited);
  });
});
