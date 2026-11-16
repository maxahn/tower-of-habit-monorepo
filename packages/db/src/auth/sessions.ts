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

// NOTE(2.9, Pass 1): signatures only. The real queries land in Pass 3.

/** Inserts a session with expires_at = now() + ttlSeconds (database clock). */
export async function createSession(db: Db, input: NewSession): Promise<Session> {
  void [db, input];
  throw new Error('not implemented');
}

/**
 * The live session for a token hash, or undefined: revoked_at IS NULL AND
 * expires_at > now(). Lookup is by hash; the raw token is never stored.
 */
export async function findLiveSessionByHash(
  db: Db,
  tokenHash: string
): Promise<Session | undefined> {
  void [db, tokenHash];
  throw new Error('not implemented');
}

/**
 * Bumps last_seen_at to now() only when it is more than an hour stale:
 * UPDATE ... SET last_seen_at = now() WHERE id = ? AND last_seen_at < now() -
 * interval '1 hour'. Returns the updated row, or undefined when nothing was due.
 */
export async function touchLastSeen(db: Db, id: string): Promise<Session | undefined> {
  void [db, id];
  throw new Error('not implemented');
}

/**
 * Compare-and-set revoke of one session: WHERE id = ? AND revoked_at IS NULL.
 * Returns the row on success, undefined if already revoked (logging out twice is
 * not an error).
 */
export async function revokeSession(db: Db, id: string): Promise<Session | undefined> {
  void [db, id];
  throw new Error('not implemented');
}

/** Revokes every live session for the user; returns the rows revoked. */
export async function revokeAllForUser(db: Db, userId: string): Promise<Session[]> {
  void [db, userId];
  throw new Error('not implemented');
}
