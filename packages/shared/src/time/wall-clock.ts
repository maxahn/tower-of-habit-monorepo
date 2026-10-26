/**
 * Civil wall clock -> UTC instant (DR-001). The mirror of local-date.ts.
 *
 * local-date.ts never converts: it reads wall clocks out of Intl.DateTimeFormat
 * and compares minutes, which is what keeps DST out of its arithmetic entirely.
 * Materialising a period needs the other direction: tower_periods.deadline_at
 * is a concrete timestamptz pinned at creation, so the scheduler's claim is an
 * indexed range scan rather than per-row timezone maths across every tower.
 *
 * This file is the ONE place that converts, and it converts by PROBING the zone
 * for its offset and then verifying the answer round-trips. It never derives an
 * offset by arithmetic on an instant.
 */
import {
  civilInZone,
  civilMs,
  MS_PER_DAY,
  parseDeadlineMinutes,
  type LocalDate,
} from './local-date.js';

/**
 * Which instant to pick when a wall clock is not exactly one instant.
 *
 * Both irregular cases reduce to picking the max or the min of the same two
 * candidates, so there is exactly one knob:
 *
 *   fall-back, 01:30 happens twice   'later'   -> the SECOND 01:30
 *                                    'earlier' -> the FIRST 01:30
 *   spring gap, 02:30 never happens  'later'   -> 03:30, one gap width on
 *                                    'earlier' -> 01:30, just before the jump
 *
 * 'later' is the default because it only ever GIVES a member time: a deadline
 * is a promise about the clock they are looking at, and delaying a collapse is
 * better than retracting one. It agrees with Temporal's 'compatible' on the gap
 * and differs from it only on ambiguity.
 */
export type WallClockPolicy = 'later' | 'earlier';

export type WallClockKind =
  | 'exact' // one instant
  | 'ambiguous' // fall-back: the clock reads this twice
  | 'gap'; // spring-forward: the clock never reads this

export type WallClockResolution = { instant: Date; kind: WallClockKind };

/** The zone's UTC offset in ms at an instant, read out of Intl. */
function offsetMsAt(epochMs: number, timeZone: string): number {
  const { date, minutesIntoDay } = civilInZone(new Date(epochMs), timeZone);
  return civilMs(date, minutesIntoDay) - epochMs;
}

/**
 * The instant a wall clock denotes, plus whether that wall clock was a single
 * instant at all.
 *
 * `timeOfDay` accepts everything parseDeadlineMinutes does, including the
 * Postgres read-back form '22:00:00' and SOLO_DEADLINE_TIME '24:00'. 1440
 * minutes needs no special case: it is the next day's midnight, and civilMs
 * rolls the date for free. That case is not hypothetical either:
 * America/Santiago springs forward AT midnight, so '24:00' there can be a gap.
 */
export function resolveWallClock(
  date: LocalDate,
  timeOfDay: string,
  timeZone: string,
  policy: WallClockPolicy = 'later'
): WallClockResolution {
  const target = civilMs(date, parseDeadlineMinutes(timeOfDay));

  // Probe the offset a day either side of the target, reading the target AS IF
  // it were UTC. Sound because no IANA offset exceeds 24h, so the answer lies
  // inside the probed window, and no zone has two transitions inside 48h.
  const a = target - offsetMsAt(target - MS_PER_DAY, timeZone);
  const b = target - offsetMsAt(target + MS_PER_DAY, timeZone);
  const earliest = Math.min(a, b);
  const latest = Math.max(a, b);

  // A candidate is real only if reading it back in the zone gives the wall
  // clock we asked for. That is the whole correctness argument, and it also
  // yields the CARDINALITY of the answer: 1 exact, 2 ambiguous, 0 gap. An
  // iterate-until-stable loop finds a fixed point but cannot tell you that.
  const hits = (earliest === latest ? [earliest] : [earliest, latest]).filter(
    (c) => offsetMsAt(c, timeZone) === target - c
  );

  const kind: WallClockKind = hits.length === 1 ? 'exact' : hits.length === 2 ? 'ambiguous' : 'gap';
  const chosen = kind === 'exact' ? hits[0]! : policy === 'later' ? latest : earliest;
  return { instant: new Date(chosen), kind };
}

/** resolveWallClock, for callers that don't care which of the three cases it was. */
export function wallClockToInstant(
  date: LocalDate,
  timeOfDay: string,
  timeZone: string,
  policy: WallClockPolicy = 'later'
): Date {
  return resolveWallClock(date, timeOfDay, timeZone, policy).instant;
}
