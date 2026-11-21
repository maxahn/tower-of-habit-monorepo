import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db, useTestOwner } from '../../test-utils.js';
import { towers } from '../../towers/schema.js';
import { createHabit } from '../habits.js';
import { EntryShapeError, listEntriesForDate, recordEntry } from './entries.js';
import { entries } from './schema.js';

/*
 * 2.16: recordEntry writes an entry for an EXPLICIT local date decided by the
 * API (DECISIONS P7/P8): credited when it qualifies and the day has no credit
 * yet, supplemental otherwise. A race on one_qualifying_entry_per_day returns
 * the existing credited row; a replayed clientEntryId returns the original.
 */

const owner = useTestOwner();
afterEach(async () => {
  await db.delete(towers).where(eq(towers.hostId, owner()));
});

const NOW = new Date('2026-11-17T02:00:00Z');

function habit(type: 'binary' | 'numeric' = 'binary') {
  return createHabit(db, {
    ownerId: owner(),
    name: 'Run',
    type,
    ...(type === 'numeric' ? { unit: 'minutes' } : {}),
  });
}

describe('recordEntry', () => {
  it('credits the day when the entry qualifies and the day has no credit', async () => {
    const h = await habit();
    const r = await recordEntry(db, {
      habitId: h.id,
      localDate: '2026-11-16',
      loggedAt: NOW,
      qualifies: true,
    });
    expect(r.created).toBe(true);
    expect(r.entry).toMatchObject({
      localDate: '2026-11-16',
      countsTowardQuota: true,
      loggedAt: NOW,
    });
  });

  it('stores a non-qualifying entry as supplemental', async () => {
    const h = await habit('numeric');
    const r = await recordEntry(db, {
      habitId: h.id,
      localDate: '2026-11-16',
      loggedAt: NOW,
      qualifies: false,
      numericValue: 5,
    });
    expect(r.created).toBe(true);
    expect(r.entry.countsTowardQuota).toBe(false);
  });

  it('stores a second qualifying entry on a credited day as supplemental (roll-ups keep working)', async () => {
    const h = await habit('numeric');
    await recordEntry(db, {
      habitId: h.id,
      localDate: '2026-11-16',
      loggedAt: NOW,
      qualifies: true,
      numericValue: 30,
    });
    const r = await recordEntry(db, {
      habitId: h.id,
      localDate: '2026-11-16',
      loggedAt: NOW,
      qualifies: true,
      numericValue: 40,
    });
    expect(r.created).toBe(true);
    expect(r.entry.countsTowardQuota).toBe(false);
    expect(await listEntriesForDate(db, h.id, '2026-11-16')).toHaveLength(2);
  });

  it('returns the original row for a replayed clientEntryId, creating nothing', async () => {
    const h = await habit();
    const key = crypto.randomUUID();
    const first = await recordEntry(db, {
      habitId: h.id,
      localDate: '2026-11-16',
      loggedAt: NOW,
      qualifies: true,
      clientEntryId: key,
    });
    const again = await recordEntry(db, {
      habitId: h.id,
      localDate: '2026-11-16',
      loggedAt: new Date(NOW.getTime() + 60_000),
      qualifies: true,
      clientEntryId: key,
    });
    expect(again.created).toBe(false);
    expect(again.entry).toEqual(first.entry);
    expect(await db.select().from(entries).where(eq(entries.habitId, h.id))).toHaveLength(1);
  });

  it('returns the existing credited row when the partial index wins a race', async () => {
    const h = await habit();
    const first = await recordEntry(db, {
      habitId: h.id,
      localDate: '2026-11-16',
      loggedAt: NOW,
      qualifies: true,
    });
    // Simulate the race: the probe said "free", but the row exists by insert time.
    const r = await recordEntry(
      db,
      { habitId: h.id, localDate: '2026-11-16', loggedAt: NOW, qualifies: true },
      { assumeDayFree: true }
    );
    expect(r.created).toBe(false);
    expect(r.entry.id).toBe(first.entry.id);
  });

  it('applies the habit-type shape rules', async () => {
    const h = await habit();
    await expect(
      recordEntry(db, {
        habitId: h.id,
        localDate: '2026-11-16',
        loggedAt: NOW,
        qualifies: true,
        numericValue: 3,
      })
    ).rejects.toBeInstanceOf(EntryShapeError);
  });
});
