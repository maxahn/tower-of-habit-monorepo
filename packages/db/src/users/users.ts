import { and, count, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memberships } from '../towers/memberships/schema.js';
import { towers } from '../towers/schema.js';
import { InvalidTimeZoneError, isValidTimeZone } from '../towers/towers.js';
import { users } from './schema.js';

export type User = typeof users.$inferSelect;

// Only the columns email-OTP signup sets. timezone has a DB default of 'UTC';
// displayName is nullable and collected later in onboarding. No passwordHash:
// authentication is passwordless (2.9).
export type NewUser = Pick<typeof users.$inferInsert, 'email' | 'timezone'>;

// 2.11: what PATCH /me may change. Email is the login credential and changes
// only through a verify-new-address flow (Phase 3), so it is not patchable.
export type UserPatch = Partial<Pick<typeof users.$inferInsert, 'displayName' | 'timezone'>>;

export class UserNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`User not found: ${id}`);
    this.name = 'UserNotFoundError';
  }
}

/**
 * Creates a user from a first successful login. The email must already be
 * normalized (trim + lowercase); the citext column rejects a case-variant
 * duplicate as users_email_unique (23505).
 */
export async function createUser(db: Db, input: NewUser): Promise<User> {
  // timezone omitted ⇒ the column default 'UTC' applies. A case-variant
  // duplicate email surfaces as users_email_unique (23505).
  const [row] = await db
    .insert(users)
    .values({ email: input.email, timezone: input.timezone })
    .returning();
  return row!;
}

export async function getUser(db: Db, id: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row;
}

export async function findUserByEmail(db: Db, email: string): Promise<User | undefined> {
  // Explicit ::citext: if the driver sends the parameter as text, `citext =
  // text` resolves to text = text and silently goes case-sensitive.
  const [row] = await db
    .select()
    .from(users)
    .where(sql`${users.email} = ${email.trim()}::citext`);
  return row;
}

/**
 * Updates display name and/or timezone. The timezone is validated against the
 * IANA database first (the same rule towers use), so an unknown zone never
 * reaches the row. Entries' local_date is never touched: history keeps the
 * zone it was written in.
 */
export async function updateUser(db: Db, id: string, patch: UserPatch): Promise<User> {
  // Runtime guard: the type forbids these keys, but callers may pass untyped data.
  const { id: _id, email, createdAt, updatedAt, ...safe } = patch as Record<string, unknown>;
  void [_id, email, createdAt, updatedAt];
  if (safe.timezone !== undefined && !isValidTimeZone(safe.timezone as string)) {
    throw new InvalidTimeZoneError(safe.timezone as string);
  }
  if (Object.keys(safe).length === 0) {
    const existing = await getUser(db, id);
    if (!existing) throw new UserNotFoundError(id);
    return existing;
  }
  const [row] = await db.update(users).set(safe).where(eq(users.id, id)).returning();
  if (!row) throw new UserNotFoundError(id);
  return row;
}

/**
 * Towers the user holds a live (non-removed) membership in whose lifecycle is
 * 'active'. Lobby (draft), paused and archived towers don't count.
 */
export async function countActiveTowersForUser(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(memberships)
    .innerJoin(towers, eq(towers.id, memberships.towerId))
    .where(
      and(
        eq(memberships.userId, userId),
        ne(memberships.state, 'removed'),
        eq(towers.lifecycle, 'active')
      )
    );
  return row?.n ?? 0;
}
