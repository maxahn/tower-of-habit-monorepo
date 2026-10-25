import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addTier,
  deleteTier,
  findTieredHabitsMissingBaseTier,
  HabitTierNotFoundError,
  listTiers,
  TierInvariantError,
  updateTier,
  type NewHabitTier,
} from './tiers.js';
import { createHabit, deleteHabit, updateHabit } from '../habits.js';
import { habits } from '../schema.js';
import { habitTiers } from './schema.js';
import { db, pgError, useTestOwner } from '../../test-utils.js';

const owner = useTestOwner();

// Assert the invariant after every test, whatever it did.
afterEach(async () => {
  expect(await findTieredHabitsMissingBaseTier(db)).toEqual([]);
});

const BASE: NewHabitTier = { tierIndex: 0, label: 'Base' };

function tieredHabit(tiers: readonly NewHabitTier[] = [BASE]) {
  return createHabit(db, { ownerId: owner(), name: 'Laps', type: 'tiered', tiers });
}

async function invariantReason(p: Promise<unknown>) {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err
  );
  expect(e).toBeInstanceOf(TierInvariantError);
  return (e as TierInvariantError).reason;
}

describe('habit tiers CRUD', () => {
  it('creates a tiered habit with its tiers', async () => {
    const h = await tieredHabit([BASE, { tierIndex: 1, label: 'Stretch', thresholdValue: 5 }]);
    const tiers = await listTiers(db, h.id);
    expect(tiers.map((t) => [t.tierIndex, t.label, t.thresholdValue])).toEqual([
      [0, 'Base', null],
      [1, 'Stretch', 5],
    ]);
  });

  it('adds and lists tiers ordered by tierIndex', async () => {
    const h = await tieredHabit();
    await addTier(db, h.id, { tierIndex: 2, label: 'Gold' });
    await addTier(db, h.id, { tierIndex: 1, label: 'Silver' });
    expect((await listTiers(db, h.id)).map((t) => t.tierIndex)).toEqual([0, 1, 2]);
  });

  it('round-trips a fractional threshold as a number', async () => {
    const h = await tieredHabit();
    const t = await addTier(db, h.id, { tierIndex: 1, label: 'x', thresholdValue: 2.5 });
    expect(t.thresholdValue).toBe(2.5);
    expect((await listTiers(db, h.id))[1]!.thresholdValue).toBe(2.5);
  });

  it('updates label and threshold, including on tier 0', async () => {
    const h = await tieredHabit();
    const [base] = await listTiers(db, h.id);
    const u = await updateTier(db, base!.id, { label: 'Minimum', thresholdValue: 1 });
    expect(u).toMatchObject({ tierIndex: 0, label: 'Minimum', thresholdValue: 1 });
  });

  it('re-indexes a non-base tier', async () => {
    const h = await tieredHabit();
    const t = await addTier(db, h.id, { tierIndex: 1, label: 'x' });
    expect((await updateTier(db, t.id, { tierIndex: 5 })).tierIndex).toBe(5);
  });

  it('ignores habitId in a tier patch', async () => {
    const a = await tieredHabit();
    const b = await tieredHabit();
    const t = await addTier(db, a.id, { tierIndex: 1, label: 'x' });
    const u = await updateTier(db, t.id, { habitId: b.id } as never);
    expect(u.habitId).toBe(a.id);
  });

  it('deletes a non-base tier', async () => {
    const h = await tieredHabit();
    const t = await addTier(db, h.id, { tierIndex: 1, label: 'x' });
    await deleteTier(db, t.id);
    expect((await listTiers(db, h.id)).map((x) => x.tierIndex)).toEqual([0]);
  });

  it('updating a missing tier throws; deleting one is a no-op', async () => {
    await expect(updateTier(db, crypto.randomUUID(), { label: 'x' })).rejects.toBeInstanceOf(
      HabitTierNotFoundError
    );
    await expect(deleteTier(db, crypto.randomUUID())).resolves.toBeUndefined();
  });
});

describe('habit tiers constraints', () => {
  it('rejects a duplicate (habit_id, tier_index)', async () => {
    const h = await tieredHabit();
    const e = await pgError(addTier(db, h.id, { tierIndex: 0, label: 'dup' }));
    expect(e).toMatchObject({
      code: '23505',
      constraint_name: 'habit_tiers_habit_id_tier_index_unique',
    });
  });

  it('allows the same tier_index on different habits', async () => {
    const a = await tieredHabit([BASE, { tierIndex: 1, label: 'x' }]);
    const b = await tieredHabit([BASE, { tierIndex: 1, label: 'x' }]);
    expect(await listTiers(db, a.id)).toHaveLength(2);
    expect(await listTiers(db, b.id)).toHaveLength(2);
  });

  it('rejects a negative tier_index', async () => {
    const h = await tieredHabit();
    const e = await pgError(addTier(db, h.id, { tierIndex: -1, label: 'x' }));
    expect(e).toMatchObject({
      code: '23514',
      constraint_name: 'habit_tiers_tier_index_nonnegative',
    });
  });

  it('rejects a null label', async () => {
    const h = await tieredHabit();
    const e = await pgError(addTier(db, h.id, { tierIndex: 1, label: null } as never));
    expect(e).toMatchObject({ code: '23502', column_name: 'label' });
  });

  it('rejects a tier for a nonexistent habit', async () => {
    const e = await pgError(addTier(db, crypto.randomUUID(), { tierIndex: 0, label: 'x' }));
    expect(e).toMatchObject({ code: '23503' });
  });

  it('cascades on habit delete', async () => {
    const h = await tieredHabit([BASE, { tierIndex: 1, label: 'x' }]);
    await deleteHabit(db, h.id);
    expect(await db.select().from(habitTiers).where(eq(habitTiers.habitId, h.id))).toEqual([]);
  });
});

describe('tier 0 invariant', () => {
  it.each([[[]], [[{ tierIndex: 1, label: 'x' }]]])(
    'rejects creating a tiered habit without tier 0 (tiers=%j)',
    async (tiers) => {
      expect(await invariantReason(tieredHabit(tiers))).toBe('missing_base_tier');
      expect(await db.select().from(habits).where(eq(habits.ownerId, owner()))).toEqual([]);
    }
  );

  it('rolls back the habit when a tier insert fails', async () => {
    const e = await pgError(tieredHabit([BASE, { tierIndex: -1, label: 'bad' }]));
    expect(e).toMatchObject({ constraint_name: 'habit_tiers_tier_index_nonnegative' });
    expect(await db.select().from(habits).where(eq(habits.ownerId, owner()))).toEqual([]);
  });

  it('rejects tiers passed for a non-tiered habit at create', async () => {
    const p = createHabit(db, {
      ownerId: owner(),
      name: 'x',
      type: 'binary',
      tiers: [BASE],
    } as never);
    expect(await invariantReason(p)).toBe('not_tiered');
  });

  it.each([{ type: 'binary' as const }, { type: 'numeric' as const, unit: 'km' }])(
    'rejects adding a tier to a $type habit',
    async (kind) => {
      const h = await createHabit(db, { ownerId: owner(), name: 'x', ...kind });
      expect(await invariantReason(addTier(db, h.id, BASE))).toBe('not_tiered');
      expect(await listTiers(db, h.id)).toEqual([]);
    }
  );

  it('rejects deleting tier 0', async () => {
    const h = await tieredHabit();
    const [base] = await listTiers(db, h.id);
    expect(await invariantReason(deleteTier(db, base!.id))).toBe('base_tier_required');
    expect(await listTiers(db, h.id)).toHaveLength(1);
  });

  it('rejects re-indexing tier 0', async () => {
    const h = await tieredHabit();
    const [base] = await listTiers(db, h.id);
    expect(await invariantReason(updateTier(db, base!.id, { tierIndex: 1 }))).toBe(
      'base_tier_required'
    );
    expect((await listTiers(db, h.id))[0]!.tierIndex).toBe(0);
  });

  it('ignores a type change on the habit', async () => {
    const h = await tieredHabit();
    const u = await updateHabit(db, h.id, { type: 'binary', name: 'Renamed' } as never);
    expect(u).toMatchObject({ type: 'tiered', name: 'Renamed' });
  });
});

describe('tier index gaps', () => {
  it('allows 0, 1, 3 and keeps indexes stable after deleting 1', async () => {
    const h = await tieredHabit([
      BASE,
      { tierIndex: 1, label: 'Silver' },
      { tierIndex: 3, label: 'Gold' },
    ]);
    const tiers = await listTiers(db, h.id);
    expect(tiers.map((t) => t.tierIndex)).toEqual([0, 1, 3]);
    await deleteTier(db, tiers[1]!.id);
    expect((await listTiers(db, h.id)).map((t) => [t.tierIndex, t.label])).toEqual([
      [0, 'Base'],
      [3, 'Gold'],
    ]);
  });
});
