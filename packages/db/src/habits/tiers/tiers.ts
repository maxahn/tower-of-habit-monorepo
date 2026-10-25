import { and, asc, eq, ne, notExists } from 'drizzle-orm';
import type { db as appDb } from '../../client.js';
import { habits } from '../schema.js';
import { habitTiers } from './schema.js';

type Db = typeof appDb;
export type HabitTier = typeof habitTiers.$inferSelect;
export type NewHabitTier = Omit<typeof habitTiers.$inferInsert, 'id' | 'habitId'>;
export type HabitTierPatch = Partial<NewHabitTier>;

export const BASE_TIER_INDEX = 0;

export type TierInvariantReason =
  | 'not_tiered' // tiers on a binary/numeric habit
  | 'missing_base_tier' // tiered habit created without tier 0
  | 'base_tier_required'; // attempt to delete or re-index tier 0

export class TierInvariantError extends Error {
  constructor(
    readonly reason: TierInvariantReason,
    readonly habitId?: string
  ) {
    super(`Habit tier invariant violated: ${reason}${habitId ? ` (habit ${habitId})` : ''}`);
    this.name = 'TierInvariantError';
  }
}

export class HabitTierNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Habit tier not found: ${id}`);
    this.name = 'HabitTierNotFoundError';
  }
}

export async function listTiers(db: Db, habitId: string): Promise<HabitTier[]> {
  return db
    .select()
    .from(habitTiers)
    .where(eq(habitTiers.habitId, habitId))
    .orderBy(asc(habitTiers.tierIndex));
}

export async function getTier(db: Db, id: string): Promise<HabitTier | undefined> {
  const [row] = await db.select().from(habitTiers).where(eq(habitTiers.id, id));
  return row;
}

export async function addTier(db: Db, habitId: string, input: NewHabitTier): Promise<HabitTier> {
  const [habit] = await db.select({ type: habits.type }).from(habits).where(eq(habits.id, habitId));
  // Missing habit falls through to the FK violation, same as other inserts.
  if (habit && habit.type !== 'tiered') throw new TierInvariantError('not_tiered', habitId);
  const [row] = await db
    .insert(habitTiers)
    .values({ ...input, habitId })
    .returning();
  return row!;
}

export async function updateTier(db: Db, id: string, patch: HabitTierPatch): Promise<HabitTier> {
  // Runtime guard: the type forbids these keys, but callers may pass untyped data.
  const { id: _id, habitId, ...safe } = patch as Record<string, unknown>;
  void [_id, habitId];
  if (Object.keys(safe).length === 0) {
    const existing = await getTier(db, id);
    if (!existing) throw new HabitTierNotFoundError(id);
    return existing;
  }

  const moving = safe.tierIndex !== undefined && safe.tierIndex !== BASE_TIER_INDEX;
  // Moving a tier off index 0 would leave the habit without a base tier. The
  // condition sits in the WHERE so a concurrent re-index can't slip past it.
  const [row] = await db
    .update(habitTiers)
    .set(safe)
    .where(
      moving
        ? and(eq(habitTiers.id, id), ne(habitTiers.tierIndex, BASE_TIER_INDEX))
        : eq(habitTiers.id, id)
    )
    .returning();
  if (row) return row;
  const existing = await getTier(db, id);
  if (!existing) throw new HabitTierNotFoundError(id);
  throw new TierInvariantError('base_tier_required', existing.habitId);
}

export async function deleteTier(db: Db, id: string): Promise<void> {
  const deleted = await db
    .delete(habitTiers)
    .where(and(eq(habitTiers.id, id), ne(habitTiers.tierIndex, BASE_TIER_INDEX)))
    .returning({ id: habitTiers.id });
  if (deleted.length) return;
  const existing = await getTier(db, id);
  // Deleting something already gone is a no-op, matching deleteHabit.
  if (existing) throw new TierInvariantError('base_tier_required', existing.habitId);
}

/** Tiered habits with no tier-0 row. Should always be empty; used to assert the invariant. */
export async function findTieredHabitsMissingBaseTier(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: habits.id })
    .from(habits)
    .where(
      and(
        eq(habits.type, 'tiered'),
        notExists(
          db
            .select({ one: habitTiers.id })
            .from(habitTiers)
            .where(
              and(eq(habitTiers.habitId, habits.id), eq(habitTiers.tierIndex, BASE_TIER_INDEX))
            )
        )
      )
    );
  return rows.map((r) => r.id);
}
