import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memberships } from '../towers/memberships/schema.js';
import type { Membership } from '../towers/memberships/memberships.js';
import { towers } from '../towers/schema.js';
import type { Tower } from '../towers/towers.js';
import { BASE_TIER_INDEX, TierInvariantError, type NewHabitTier } from './tiers/tiers.js';
import { habits, type HabitLifecycle } from './schema.js';
import { habitTiers } from './tiers/schema.js';

export type Habit = typeof habits.$inferSelect;
type HabitFields = Omit<
  typeof habits.$inferInsert,
  'id' | 'type' | 'lifecycle' | 'startedAt' | 'archivedAt' | 'createdAt' | 'updatedAt'
>;
// A tiered habit is created together with its tiers (which must include
// tier 0). A numeric habit may carry a ladder too (2.12 / DECISIONS P9: tier
// 0's threshold is what qualifies() checks); a binary habit takes none.
export type NewHabit =
  | (HabitFields & { type: 'binary'; tiers?: never })
  | (HabitFields & { type: 'numeric'; tiers?: readonly NewHabitTier[] })
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
  if (input.type === 'tiered' || (input.type === 'numeric' && tiers?.length)) {
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

/** The owner's habits, oldest first (GET /habits). */
export async function listHabitsForOwner(db: Db, ownerId: string): Promise<Habit[]> {
  return db
    .select()
    .from(habits)
    .where(eq(habits.ownerId, ownerId))
    .orderBy(asc(habits.createdAt), asc(habits.id));
}

export type HabitTower = { membership: Membership; tower: Tower };

/**
 * The tower a habit is bound into, via its live (non-removed) membership.
 * one_active_tower_per_habit guarantees at most one. Tower lifecycle is not
 * filtered: a draft (lobby) or paused tower still binds the habit.
 */
export async function findHabitTower(db: Db, habitId: string): Promise<HabitTower | undefined> {
  const [row] = await db
    .select({ membership: memberships, tower: towers })
    .from(memberships)
    .innerJoin(towers, eq(towers.id, memberships.towerId))
    .where(and(eq(memberships.habitId, habitId), ne(memberships.state, 'removed')));
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

/** `now` stamps startedAt / archivedAt. Passed in, never read from the system clock. */
export async function transitionHabit(
  db: Db,
  id: string,
  to: HabitLifecycle,
  now: Date
): Promise<Habit> {
  const current = await getHabit(db, id);
  if (!current) throw new HabitNotFoundError(id);
  const from = current.lifecycle;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) throw new IllegalTransitionError(from, to);

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
