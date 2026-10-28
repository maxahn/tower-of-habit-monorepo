import { describe, expect, it } from 'vitest';
import { addDays, civilInZone, InvalidLocalDateInputError } from './local-date.js';
import { resolveWallClock, wallClockToInstant } from './wall-clock.js';

const EDM = 'America/Edmonton';
// Edmonton 2026: MST -> MDT at 2026-03-08T09:00Z (local 02:00 -> 03:00, so
// 02:00-02:59 never happens); MDT -> MST at 2026-11-01T08:00Z (local
// 02:00 -> 01:00, so 01:00-01:59 happens twice).

describe('resolveWallClock', () => {
  it.each([
    { tz: EDM, date: '2026-03-07', time: '22:00', utc: '2026-03-08T05:00:00.000Z' },
    { tz: EDM, date: '2026-03-08', time: '01:00', utc: '2026-03-08T08:00:00.000Z' },
    { tz: EDM, date: '2026-03-08', time: '22:00', utc: '2026-03-09T04:00:00.000Z' },
    { tz: EDM, date: '2026-11-01', time: '00:30', utc: '2026-11-01T06:30:00.000Z' },
    { tz: EDM, date: '2026-11-01', time: '22:00', utc: '2026-11-02T05:00:00.000Z' },
    // Postgres `time` read-back form.
    { tz: EDM, date: '2026-03-07', time: '22:00:00', utc: '2026-03-08T05:00:00.000Z' },
    { tz: 'Asia/Kolkata', date: '2026-06-15', time: '22:00', utc: '2026-06-15T16:30:00.000Z' },
    {
      tz: 'Pacific/Kiritimati',
      date: '2026-06-15',
      time: '22:00',
      utc: '2026-06-15T08:00:00.000Z',
    },
    { tz: 'UTC', date: '2026-03-08', time: '02:30', utc: '2026-03-08T02:30:00.000Z' },
  ])('$tz $date $time is exactly $utc', ({ tz, date, time, utc }) => {
    const r = resolveWallClock(date, time, tz);
    expect(r).toEqual({ instant: new Date(utc), kind: 'exact' });
  });

  it.each([
    // Spring-forward: 02:30 never happens. 'later' keeps real elapsed time
    // since midnight (03:30 MDT); 'earlier' lands just before the jump.
    {
      tz: EDM,
      date: '2026-03-08',
      time: '02:30',
      kind: 'gap',
      later: '2026-03-08T09:30:00.000Z',
      earlier: '2026-03-08T08:30:00.000Z',
    },
    // Fall-back: 01:30 happens twice, MDT then MST.
    {
      tz: EDM,
      date: '2026-11-01',
      time: '01:30',
      kind: 'ambiguous',
      later: '2026-11-01T08:30:00.000Z',
      earlier: '2026-11-01T07:30:00.000Z',
    },
    // Chile springs forward AT midnight, so SOLO_DEADLINE_TIME is a gap there.
    {
      tz: 'America/Santiago',
      date: '2026-09-05',
      time: '24:00',
      kind: 'gap',
      later: '2026-09-06T04:00:00.000Z',
      earlier: '2026-09-06T03:00:00.000Z',
    },
    // Lord Howe shifts by 30 minutes: nothing may assume whole-hour offsets.
    {
      tz: 'Australia/Lord_Howe',
      date: '2026-04-05',
      time: '01:30',
      kind: 'ambiguous',
      later: '2026-04-04T15:00:00.000Z',
      earlier: '2026-04-04T14:30:00.000Z',
    },
  ] as const)('$tz $date $time is a $kind', ({ tz, date, time, kind, later, earlier }) => {
    expect(resolveWallClock(date, time, tz, 'later')).toEqual({ instant: new Date(later), kind });
    expect(resolveWallClock(date, time, tz, 'earlier')).toEqual({
      instant: new Date(earlier),
      kind,
    });
  });

  it("defaults to 'later'", () => {
    expect(wallClockToInstant('2026-11-01', '01:30', EDM).toISOString()).toBe(
      '2026-11-01T08:30:00.000Z'
    );
  });

  it("treats '24:00' as the next day's midnight", () => {
    expect(wallClockToInstant('2026-03-07', '24:00', EDM)).toEqual(
      wallClockToInstant('2026-03-08', '00:00', EDM)
    );
  });

  it('rejects a bad zone, time or date', () => {
    expect(() => resolveWallClock('2026-03-07', '22:00', 'Not/AZone')).toThrow(
      InvalidLocalDateInputError
    );
    expect(() => resolveWallClock('2026-03-07', '25:00', EDM)).toThrow(InvalidLocalDateInputError);
    expect(() => resolveWallClock('2026-3-7', '22:00', EDM)).toThrow(InvalidLocalDateInputError);
  });

  // Every exact answer must read back as the wall clock asked for: the
  // probe-and-verify argument, checked over a year in zones with whole-hour,
  // half-hour (Lord Howe) and 45-minute (Chatham) offsets.
  it.each([EDM, 'Australia/Lord_Howe', 'Pacific/Chatham', 'Europe/London', 'America/Santiago'])(
    'round-trips every exact wall clock in %s',
    (tz) => {
      const seen = { exact: 0, ambiguous: 0, gap: 0 };
      for (let i = 0; i < 366; i++) {
        const date = addDays('2026-01-01', i);
        for (const minutes of [0, 30, 90, 150, 1320]) {
          const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
          const r = resolveWallClock(date, time, tz);
          seen[r.kind]++;
          if (r.kind === 'gap') continue;
          expect(civilInZone(r.instant, tz)).toEqual({ date, minutesIntoDay: minutes });
        }
      }
      expect(seen.exact).toBeGreaterThan(1800);
    }
  );
});
