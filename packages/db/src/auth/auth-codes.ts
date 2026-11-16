import type { Db } from '../client.js';
import { authCodes } from './schema.js';

export type AuthCode = typeof authCodes.$inferSelect;

// The per-code attempt cap. A code that has failed this many verifications is no
// longer returned by findLiveCodeForEmail — see the two-layer limiting note in
// the 2.9 spec.
export const MAX_CODE_ATTEMPTS = 5;

/** What insertAuthCode accepts; expires_at is derived from ttlSeconds + DB clock. */
export type NewAuthCode = {
  email: string;
  codeHash: string;
  ttlSeconds: number;
};

// NOTE(2.9, Pass 1): signatures only. The real queries land in Pass 3.

/**
 * Deletes every live code for the email, so requesting a new code leaves exactly
 * one outstanding. Called by the service before inserting the fresh code.
 */
export async function invalidateCodesForEmail(db: Db, email: string): Promise<void> {
  void [db, email];
  throw new Error('not implemented');
}

/** Inserts a code with expires_at = now() + ttlSeconds (database clock). */
export async function insertAuthCode(db: Db, input: NewAuthCode): Promise<AuthCode> {
  void [db, input];
  throw new Error('not implemented');
}

/**
 * The single live code for the email, or undefined: consumed_at IS NULL AND
 * expires_at > now() AND attempt_count < MAX_CODE_ATTEMPTS.
 */
export async function findLiveCodeForEmail(db: Db, email: string): Promise<AuthCode | undefined> {
  void [db, email];
  throw new Error('not implemented');
}

/** Increments attempt_count on a wrong guess; the cap retires the code at 5. */
export async function recordFailedAttempt(db: Db, id: string): Promise<AuthCode | undefined> {
  void [db, id];
  throw new Error('not implemented');
}

/**
 * Compare-and-set consume: UPDATE ... SET consumed_at = now() WHERE id = ? AND
 * consumed_at IS NULL. Returns the row on success, undefined if it was already
 * consumed (a lost race) — that is how single-use stays race-safe.
 */
export async function consumeCode(db: Db, id: string): Promise<AuthCode | undefined> {
  void [db, id];
  throw new Error('not implemented');
}
