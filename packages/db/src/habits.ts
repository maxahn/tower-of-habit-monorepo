import { and, eq } from 'drizzle-orm';
import type { db as appDb } from './client.js';
import { habits, type HabitLifecycle } from './schema.js';

type Db = typeof appDb;
export type Habit = typeof habits.$inferSelect;
export type NewHabit = Omit<
  typeof habits.$inferInsert,
  'id' | 'lifecycle' | 'startedAt' | 'archivedAt' | 'createdAt' | 'updatedAt'
>;
// Lifecycle and its timestamps change only through transitionHabit, and
// ownership is immutable.
export type HabitPatch = Partial<Omit<NewHabit, 'ownerId'>>;

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
  const [row] = await db.insert(habits).values(input).returning();
  return row!;
}

export async function getHabit(db: Db, id: string): Promise<Habit | undefined> {
  const [row] = await db.select().from(habits).where(eq(habits.id, id));
  return row;
}

export async function updateHabit(db: Db, id: string, patch: HabitPatch): Promise<Habit> {
  // Runtime guard: the type forbids these keys, but callers may pass untyped data.
  const {
    lifecycle,
    startedAt,
    archivedAt,
    ownerId,
    id: _id,
    ...safe
  } = patch as Record<string, unknown>;
  void [lifecycle, startedAt, archivedAt, ownerId, _id];
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
