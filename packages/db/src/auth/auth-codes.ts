import { and, eq, isNull, lt, sql } from 'drizzle-orm';
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

// Explicit ::citext cast on every email predicate, for the same reason as
// findUserByEmail: if the driver sends the parameter as text, `citext = text`
// resolves to text = text and silently goes case-sensitive. Emails are already
// normalized to lowercase on write, but the cast keeps the comparison correct
// regardless.
const emailEq = (email: string) => sql`${authCodes.email} = ${email}::citext`;

/**
 * Deletes every code for the email, so requesting a new one leaves exactly one
 * outstanding. Called by the service before inserting the fresh code.
 */
export async function invalidateCodesForEmail(db: Db, email: string): Promise<void> {
  await db.delete(authCodes).where(emailEq(email));
}

/** Inserts a code with expires_at = now() + ttlSeconds (database clock). */
export async function insertAuthCode(db: Db, input: NewAuthCode): Promise<AuthCode> {
  const [row] = await db
    .insert(authCodes)
    .values({
      email: input.email,
      codeHash: input.codeHash,
      // make_interval keeps ttlSeconds a bind parameter (valid in DML); the DB
      // clock is the one the expires_after_created CHECK compares against.
      expiresAt: sql`now() + make_interval(secs => ${input.ttlSeconds})`,
    })
    .returning();
  return row!;
}

/**
 * The single live code for the email, or undefined: consumed_at IS NULL AND
 * expires_at > now() AND attempt_count < MAX_CODE_ATTEMPTS.
 */
export async function findLiveCodeForEmail(db: Db, email: string): Promise<AuthCode | undefined> {
  const [row] = await db
    .select()
    .from(authCodes)
    .where(
      and(
        emailEq(email),
        isNull(authCodes.consumedAt),
        sql`${authCodes.expiresAt} > now()`,
        lt(authCodes.attemptCount, MAX_CODE_ATTEMPTS)
      )
    );
  return row;
}

/** Increments attempt_count on a wrong guess; the cap retires the code at 5. */
export async function recordFailedAttempt(db: Db, id: string): Promise<AuthCode | undefined> {
  const [row] = await db
    .update(authCodes)
    .set({ attemptCount: sql`${authCodes.attemptCount} + 1` })
    .where(eq(authCodes.id, id))
    .returning();
  return row;
}

/**
 * Compare-and-set consume: UPDATE ... SET consumed_at = now() WHERE id = ? AND
 * consumed_at IS NULL. Returns the row on success, undefined if it was already
 * consumed (a lost race) — that is how single-use stays race-safe.
 */
export async function consumeCode(db: Db, id: string): Promise<AuthCode | undefined> {
  const [row] = await db
    .update(authCodes)
    .set({ consumedAt: sql`now()` })
    .where(and(eq(authCodes.id, id), isNull(authCodes.consumedAt)))
    .returning();
  return row;
}
