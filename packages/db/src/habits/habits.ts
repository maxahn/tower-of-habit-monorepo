import { and, eq } from 'drizzle-orm';
import type { db as appDb } from '../client.js';
import { BASE_TIER_INDEX, TierInvariantError, type NewHabitTier } from './tiers/tiers.js';
import { habits, type HabitLifecycle } from './schema.js';
import { habitTiers } from './tiers/schema.js';

type Db = typeof appDb;
export type Habit = typeof habits.$inferSelect;
type HabitFields = Omit<
  typeof habits.$inferInsert,
  'id' | 'type' | 'lifecycle' | 'startedAt' | 'archivedAt' | 'createdAt' | 'updatedAt'
>;
// A tiered habit is created together with its tiers (which must include
// tier 0); other types take none.
export type NewHabit =
  | (HabitFields & { type: 'binary' | 'numeric'; tiers?: never })
  | (HabitFields & { type: 'tiered'; tiers: readonly NewHabitTier[] });
// Lifecycle and its timestamps change only through transitionHabit. Ownership
// and type are immutable (a type change would break the tier invariant).
export type HabitPatch = Partial<Omit<HabitFields, 'ownerId'>>;

export const ALLOWED_TRANSITIONS: Record<HabitLifecycle, readonly HabitLifecycle[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: HabitLifecycle,
    readonly to: HabitLifecycle
  ) {
    super(`Illegal habit lifecycle transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export class HabitNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Habit not found: ${id}`);
    this.name = 'HabitNotFoundError';
  }
}

export async function createHabit(db: Db, input: NewHabit): Promise<Habit> {
  const { tiers, ...fields } = input;
  if (input.type === 'tiered') {
    if (!tiers?.some((t) => t.tierIndex === BASE_TIER_INDEX)) {
      throw new TierInvariantError('missing_base_tier');
    }
  } else if (tiers?.length) {
    throw new TierInvariantError('not_tiered');
  }
  if (!tiers?.length) {
    const [row] = await db.insert(habits).values(fields).returning();
    return row!;
  }
  // One transaction, so a failed tier insert leaves no tierless tiered habit.
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(habits).values(fields).returning();
    await tx.insert(habitTiers).values(tiers.map((t) => ({ ...t, habitId: row!.id })));
    return row!;
  });
}

export async function getHabit(db: Db, id: string): Promise<Habit | undefined> {
  const [row] = await db.select().from(habits).where(eq(habits.id, id));
  return row;
}

export async function updateHabit(db: Db, id: string, patch: HabitPatch): Promise<Habit> {
  // Runtime guard: the type forbids these keys, but callers may pass untyped data.
  const {
    type,
    lifecycle,
    startedAt,
    archivedAt,
    ownerId,
    id: _id,
    ...safe
  } = patch as Record<string, unknown>;
  void [type, lifecycle, startedAt, archivedAt, ownerId, _id];
  const [row] = await db.update(habits).set(safe).where(eq(habits.id, id)).returning();
  if (!row) throw new HabitNotFoundError(id);
  return row;
}

export async function deleteHabit(db: Db, id: string): Promise<void> {
  await db.delete(habits).where(eq(habits.id, id));
}

export async function transitionHabit(db: Db, id: string, to: HabitLifecycle): Promise<Habit> {
  const current = await getHabit(db, id);
  if (!current) throw new HabitNotFoundError(id);
  const from = current.lifecycle;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) throw new IllegalTransitionError(from, to);

  const now = new Date();
  // Conditioning on the observed `from` makes a concurrent transition lose
  // cleanly (zero rows) instead of overwriting.
  const [row] = await db
    .update(habits)
    .set({
      lifecycle: to,
      ...(to === 'active' && current.startedAt === null ? { startedAt: now } : {}),
      ...(to === 'archived' ? { archivedAt: now } : {}),
    })
    .where(and(eq(habits.id, id), eq(habits.lifecycle, from)))
    .returning();
  if (!row) {
    const latest = await getHabit(db, id);
    if (!latest) throw new HabitNotFoundError(id);
    throw new IllegalTransitionError(latest.lifecycle, to);
  }
  return row;
}
