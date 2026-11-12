import { describe, expect, it } from 'vitest';
import { civilInZone, civilMs } from './local-date.js';

/**
 * TODO(tzdata-2026c): this test is MEANT to fail. Alberta went permanent UTC-6
 * from 2026-11-01 (tzdata 2026c, zone still America/Edmonton). The runtime here
 * still ships older tzdata, and a lot of tests hard-code Edmonton's old DST.
 * When this goes red, the runtime has caught up: follow src/time/TZDATA.md,
 * migrate the tagged tests, then delete this file.
 */
describe('tzdata canary', () => {
  it('runtime tzdata predates 2026c (Alberta permanent UTC-6): see src/time/TZDATA.md', () => {
    const instant = new Date('2027-01-15T12:00:00Z');
    const { date, minutesIntoDay } = civilInZone(instant, 'America/Edmonton');
    const offsetMinutes = (civilMs(date, minutesIntoDay) - instant.getTime()) / 60_000;
    expect(
      offsetMinutes,
      'America/Edmonton is now UTC-6 in January: the runtime has tzdata >= 2026c. ' +
        'Follow packages/shared/src/time/TZDATA.md, then delete this canary.'
    ).toBe(-7 * 60);
  });
});
