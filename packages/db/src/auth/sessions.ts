import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { sessions } from './schema.js';

export type Session = typeof sessions.$inferSelect;

/** What createSession accepts; expires_at is derived from ttlSeconds + DB clock. */
export type NewSession = {
  userId: string;
  tokenHash: string;
  userAgent?: string | null;
  ttlSeconds: number;
};

/** Inserts a session with expires_at = now() + ttlSeconds (database clock). */
export async function createSession(db: Db, input: NewSession): Promise<Session> {
  const [row] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      userAgent: input.userAgent ?? null,
      // created_at and last_seen_at take the column default now(); expires_at is
      // the same DB clock so the expires_after_created CHECK holds.
      expiresAt: sql`now() + make_interval(secs => ${input.ttlSeconds})`,
    })
    .returning();
  return row!;
}

/**
 * The live session for a token hash, or undefined: revoked_at IS NULL AND
 * expires_at > now(). Lookup is by hash; the raw token is never stored.
 */
export async function findLiveSessionByHash(
  db: Db,
  tokenHash: string
): Promise<Session | undefined> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`
      )
    );
  return row;
}

/**
 * Bumps last_seen_at to now() only when it is more than an hour stale, so a busy
 * session is not written on every request. Returns the updated row, or undefined
 * when nothing was due.
 */
export async function touchLastSeen(db: Db, id: string): Promise<Session | undefined> {
  const [row] = await db
    .update(sessions)
    .set({ lastSeenAt: sql`now()` })
    .where(and(eq(sessions.id, id), sql`${sessions.lastSeenAt} < now() - interval '1 hour'`))
    .returning();
  return row;
}

/**
 * Compare-and-set revoke of one session: WHERE id = ? AND revoked_at IS NULL.
 * Returns the row on success, undefined if already revoked (logging out twice is
 * not an error).
 */
export async function revokeSession(db: Db, id: string): Promise<Session | undefined> {
  const [row] = await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .returning();
  return row;
}

/** Revokes every live session for the user; returns the rows revoked. */
export async function revokeAllForUser(db: Db, userId: string): Promise<Session[]> {
  return db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning();
}
