import { isValidTimeZone, JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH } from '@tower-of-habit/shared';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { habits } from '../habits/schema.js';
import { isUniqueViolation } from '../pg-errors.js';
import { users } from '../users/schema.js';
import { memberships } from './memberships/schema.js';
import type { MembershipState } from './memberships/schema.js';
import { towers } from './schema.js';

export type Tower = typeof towers.$inferSelect;
// Lifecycle and startedAt change only through lifecycle transitions; height
// and currentStreak are evaluator-owned.
export type NewTower = Omit<
  typeof towers.$inferInsert,
  'id' | 'lifecycle' | 'startedAt' | 'createdAt' | 'height' | 'currentStreak' | 'joinCode'
> & { joinCode?: string };
// The host changes only through host reassignment, not a patch.
export type TowerPatch = Partial<Omit<NewTower, 'hostId'>>;

export class InvalidTimeZoneError extends Error {
  constructor(readonly timezone: string) {
    super(`Invalid IANA time zone: ${JSON.stringify(timezone)}`);
    this.name = 'InvalidTimeZoneError';
  }
}

export class TowerNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Tower not found: ${id}`);
    this.name = 'TowerNotFoundError';
  }
}

// The rule lives in @tower-of-habit/shared so the API schemas apply the same
// one; re-exported here so existing db callers keep their import.
export { isValidTimeZone };

export function generateJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(JOIN_CODE_LENGTH));
  // Modulo bias over 31 symbols is negligible for a join code.
  return Array.from(bytes, (b) => JOIN_CODE_ALPHABET[b % JOIN_CODE_ALPHABET.length]).join('');
}

export async function createTower(db: Db, input: NewTower): Promise<Tower> {
  if (!isValidTimeZone(input.timezone)) throw new InvalidTimeZoneError(input.timezone);
  // A join_code collision surfaces as towers_join_code_unique (23505).
  const [row] = await db
    .insert(towers)
    .values({ ...input, joinCode: input.joinCode ?? generateJoinCode() })
    .returning();
  return row!;
}

/**
 * 2.14: join-by-code lookup. join_code is citext, so the match is
 * case-insensitive; the explicit ::citext cast keeps it so even if the driver
 * sends the parameter as text (see findUserByEmail). Trimmed, nothing else.
 */
export async function findTowerByJoinCode(db: Db, code: string): Promise<Tower | undefined> {
  const [row] = await db
    .select()
    .from(towers)
    .where(sql`${towers.joinCode} = ${code.trim()}::citext`);
  return row;
}

export async function getTower(db: Db, id: string): Promise<Tower | undefined> {
  const [row] = await db.select().from(towers).where(eq(towers.id, id));
  return row;
}

/**
 * Known gap: changing deadlineTime, timezone or graceWindowMinutes does NOT
 * reach tower_periods rows already materialised. Their deadline_at and
 * evaluate_at were resolved at creation, so pending periods keep the old
 * instants until they are evaluated.
 */
export async function updateTower(db: Db, id: string, patch: TowerPatch): Promise<Tower> {
  // Runtime guard: the type forbids these keys, but callers may pass untyped data.
  const {
    id: _id,
    hostId,
    lifecycle,
    startedAt,
    createdAt,
    height,
    currentStreak,
    ...safe
  } = patch as Record<string, unknown>;
  void [_id, hostId, lifecycle, startedAt, createdAt, height, currentStreak];
  if (safe.timezone !== undefined && !isValidTimeZone(safe.timezone as string)) {
    throw new InvalidTimeZoneError(safe.timezone as string);
  }
  if (Object.keys(safe).length === 0) {
    const existing = await getTower(db, id);
    if (!existing) throw new TowerNotFoundError(id);
    return existing;
  }
  const [row] = await db.update(towers).set(safe).where(eq(towers.id, id)).returning();
  if (!row) throw new TowerNotFoundError(id);
  return row;
}

/**
 * 2.15: lobby -> active, stamping started_at with the injected `now`.
 * Conditioned on lifecycle = 'draft', so a concurrent start loses cleanly:
 * undefined means the tower was not a draft (already started, or gone).
 */
export async function activateTower(db: Db, id: string, now: Date): Promise<Tower | undefined> {
  const [row] = await db
    .update(towers)
    .set({ lifecycle: 'active', startedAt: now })
    .where(and(eq(towers.id, id), eq(towers.lifecycle, 'draft')))
    .returning();
  return row;
}

/** The tower row, locked FOR UPDATE for the rest of the transaction. */
export async function lockTower(db: Db, id: string): Promise<Tower | undefined> {
  const [row] = await db.select().from(towers).where(eq(towers.id, id)).for('update');
  return row;
}

/**
 * 2.19: a survived period extends the run. Evaluator-owned columns, written
 * directly: updateTower refuses them, which is right for application code and
 * exactly what the evaluation job has to get round.
 */
export async function extendTowerRun(db: Db, id: string): Promise<Tower> {
  const [row] = await db
    .update(towers)
    .set({ height: sql`${towers.height} + 1`, currentStreak: sql`${towers.currentStreak} + 1` })
    .where(eq(towers.id, id))
    .returning();
  if (!row) throw new TowerNotFoundError(id);
  return row;
}

/** 2.19: a collapse closes the run (DECISIONS P15: the block keeps its height). */
export async function closeTowerRun(db: Db, id: string): Promise<Tower> {
  const [row] = await db
    .update(towers)
    .set({ height: 0, currentStreak: 0 })
    .where(eq(towers.id, id))
    .returning();
  if (!row) throw new TowerNotFoundError(id);
  return row;
}

export async function deleteTower(db: Db, id: string): Promise<void> {
  await db.delete(towers).where(eq(towers.id, id));
}

/** 2.13: five attempts at a unique join code is plenty for a 31^8 space. */
export const JOIN_CODE_ATTEMPTS = 5;

export class JoinCodeExhaustedError extends Error {
  constructor(readonly attempts: number) {
    super(`Could not allocate a unique join code in ${attempts} attempts`);
    this.name = 'JoinCodeExhaustedError';
  }
}

/**
 * createTower with a fresh CSPRNG join code, retried on
 * towers_join_code_unique up to `attempts` times. Codes are stored
 * upper-cased (the column is citext, so lookups are case-insensitive either
 * way; normalising on write keeps the stored form canonical).
 *
 * Each attempt runs in its own savepoint, so a collision inside a caller's
 * transaction does not poison it (a unique violation otherwise aborts the
 * whole transaction until rollback).
 */
export async function createTowerWithFreshCode(
  db: Db,
  input: Omit<NewTower, 'joinCode'>,
  options: { attempts?: number; generate?: () => string } = {}
): Promise<Tower> {
  const attempts = options.attempts ?? JOIN_CODE_ATTEMPTS;
  const generate = options.generate ?? generateJoinCode;
  for (let i = 0; i < attempts; i++) {
    const joinCode = generate().toUpperCase();
    try {
      return await db.transaction((tx) => createTower(tx, { ...input, joinCode }));
    } catch (e) {
      if (!isUniqueViolation(e, 'towers_join_code_unique')) throw e;
    }
  }
  throw new JoinCodeExhaustedError(attempts);
}

export type TowerListItem = {
  tower: Tower;
  membershipState: MembershipState;
  /** Live (non-removed) memberships. */
  memberCount: number;
};

/** Towers the user holds a live membership in, oldest first (GET /towers). */
export async function listTowersForUser(db: Db, userId: string): Promise<TowerListItem[]> {
  const memberCounts = db
    .select({ towerId: memberships.towerId, n: count().as('n') })
    .from(memberships)
    .where(ne(memberships.state, 'removed'))
    .groupBy(memberships.towerId)
    .as('member_counts');

  const rows = await db
    .select({
      tower: towers,
      membershipState: memberships.state,
      memberCount: memberCounts.n,
    })
    .from(memberships)
    .innerJoin(towers, eq(towers.id, memberships.towerId))
    .leftJoin(memberCounts, eq(memberCounts.towerId, towers.id))
    .where(and(eq(memberships.userId, userId), ne(memberships.state, 'removed')))
    .orderBy(asc(towers.createdAt), asc(towers.id));

  return rows.map((r) => ({
    tower: r.tower,
    membershipState: r.membershipState,
    memberCount: r.memberCount ?? 0,
  }));
}

export type TowerMemberRow = {
  membershipId: string;
  userId: string;
  displayName: string | null;
  habitId: string;
  habitName: string;
  habitType: (typeof habits.$inferSelect)['type'];
  state: MembershipState;
  joinedAt: Date;
};

/**
 * The roster as the lobby and tower views show it: every live membership
 * joined to its user and habit, the host first and then by join time.
 */
export async function listTowerMembers(db: Db, towerId: string): Promise<TowerMemberRow[]> {
  return db
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      displayName: users.displayName,
      habitId: memberships.habitId,
      habitName: habits.name,
      habitType: habits.type,
      state: memberships.state,
      joinedAt: memberships.joinedAt,
    })
    .from(memberships)
    .innerJoin(towers, eq(towers.id, memberships.towerId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(habits, eq(habits.id, memberships.habitId))
    .where(and(eq(memberships.towerId, towerId), ne(memberships.state, 'removed')))
    .orderBy(
      sql`case when ${memberships.userId} = ${towers.hostId} then 0 else 1 end`,
      asc(memberships.joinedAt),
      asc(memberships.id)
    );
}
