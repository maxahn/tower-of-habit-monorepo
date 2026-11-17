import { describe, expect, it } from 'vitest';
import { db, useTestOwner } from '../../test-utils.js';
import { createHabit } from '../habits.js';
import { countQualifyingDays } from './entries.js';
import { entries } from './schema.js';

/*
 * 2.17/2.19: qualifying days per habit inside a period's [start, end].
 */

const owner = useTestOwner();

describe('countQualifyingDays', () => {
  it('counts credited rows inside the inclusive range only', async () => {
    const h = await createHabit(db, { ownerId: owner(), name: 'x', type: 'binary' });
    const at = new Date('2026-11-17T02:00:00Z');
    await db.insert(entries).values([
      { habitId: h.id, localDate: '2026-11-13', loggedAt: at, countsTowardQuota: true },
      { habitId: h.id, localDate: '2026-11-14', loggedAt: at, countsTowardQuota: true },
      { habitId: h.id, localDate: '2026-11-14', loggedAt: at, countsTowardQuota: false },
      { habitId: h.id, localDate: '2026-11-15', loggedAt: at, countsTowardQuota: false },
      { habitId: h.id, localDate: '2026-11-16', loggedAt: at, countsTowardQuota: true },
    ]);
    expect(await countQualifyingDays(db, h.id, '2026-11-14', '2026-11-16')).toBe(2);
    expect(await countQualifyingDays(db, h.id, '2026-11-15', '2026-11-15')).toBe(0);
    expect(await countQualifyingDays(db, h.id, '2026-11-13', '2026-11-16')).toBe(3);
  });
});
