import type { LocalDate } from '../time/local-date.js';
import { wallClockToInstant } from '../time/wall-clock.js';

const MS_PER_MINUTE = 60_000;

/**
 * A movable `now` for tests. Domain code never reads the system clock; it is
 * handed an instant, and this is where tests keep theirs. Time travel (3.16) is
 * advancing it and passing the new value in. Nothing global is mocked.
 */
export type TestClock = {
  readonly now: Date;
  /** Real elapsed time. `days` is 24h, not a civil day: across DST use `toLocal`. */
  advance(by: { days?: number; hours?: number; minutes?: number }): Date;
  /** Jump to a wall-clock time on a civil date in `timeZone`. */
  toLocal(date: LocalDate, time: string, timeZone: string): Date;
  set(instant: Date): Date;
};

export function testClock(start: Date): TestClock {
  let current = new Date(start.getTime());
  return {
    get now() {
      // A copy, so a caller mutating it can't move the clock.
      return new Date(current.getTime());
    },
    advance({ days = 0, hours = 0, minutes = 0 }) {
      current = new Date(current.getTime() + ((days * 24 + hours) * 60 + minutes) * MS_PER_MINUTE);
      return this.now;
    },
    toLocal(date, time, timeZone) {
      current = wallClockToInstant(date, time, timeZone);
      return this.now;
    },
    set(instant) {
      current = new Date(instant.getTime());
      return this.now;
    },
  };
}
