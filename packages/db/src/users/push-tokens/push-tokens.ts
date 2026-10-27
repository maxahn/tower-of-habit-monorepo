import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../../client.js';
import { pushTokens } from './schema.js';

export type PushToken = typeof pushTokens.$inferSelect;
// Timestamps are all service-owned: created_at from the column default,
// last_seen_at and invalidated_at only through register / touch / invalidate.
export type NewPushToken = Pick<typeof pushTokens.$inferInsert, 'userId' | 'token' | 'platform'>;

/**
 * How long an invalidated row is kept before it carries no information. Nothing
 * drives this yet — the reaper lands with the dispatcher ticket — but
 * pruneInvalidatedPushTokens is the function it will call.
 */
export const INVALIDATED_TOKEN_RETENTION_DAYS = 30;

export class PushTokenNotFoundError extends Error {
  constructor(readonly token: string) {
    super(`Push token not found: ${token}`);
    this.name = 'PushTokenNotFoundError';
  }
}

/**
 * Registers a device, or MOVES an existing registration to this user.
 *
 * Reassignment is the whole point, not a side effect. A phone handed to another
 * person re-registers the same provider token, and that device must stop
 * receiving the previous owner's towers. push_tokens_token_unique makes
 * reassignment the only reachable outcome: there is no code path that leaves two
 * users holding one token.
 *
 * onConflictDoUpdate, not onConflictDoNothing + re-select — the ensurePeriod
 * reasoning applies verbatim. DO NOTHING does not wait on an UNCOMMITTED
 * conflicting row, it returns zero rows at once, so the loser's re-select could
 * find nothing for a token that is about to exist. DO UPDATE blocks on the
 * winner and returns its row. Here it is doubly forced: the point is to MOVE the
 * row, so doing nothing is not even the right semantics.
 *
 * created_at is deliberately untouched — it records the device's FIRST sighting,
 * which is what makes a "registered since" line in a settings screen true.
 *
 * sql`now()`, never `new Date()`: the database clock is the one
 * push_tokens_last_seen_not_before_created compares against, and host skew would
 * otherwise turn a valid registration into a hard 23514.
 */
export async function registerPushToken(db: Db, input: NewPushToken): Promise<PushToken> {
  // Runtime guard: the type forbids these keys, but callers may pass untyped
  // data, and a smuggled last_seen_at or invalidated_at would defeat the
  // ordering checks and the liveness rule respectively.
  const { userId, token, platform } = input as NewPushToken;
  const [row] = await db
    .insert(pushTokens)
    .values({ userId, token, platform })
    .onConflictDoUpdate({
      target: pushTokens.token,
      set: {
        userId: sql`excluded.user_id`,
        // A reinstall can legitimately report a different platform for a
        // recycled token.
        platform: sql`excluded.platform`,
        lastSeenAt: sql`now()`,
        // Logging back in on a device resurrects its registration. Inserting a
        // fresh row instead is impossible; the token is unique.
        invalidatedAt: null,
      },
    })
    .returning();
  return row!;
}

/**
 * Records that the app came to the foreground on this device.
 *
 * Refuses an invalidated token rather than silently resurrecting it: a client
 * pinging a token the server will not send to must re-register, and silence
 * would hide that. Resurrection is registerPushToken's job, where the platform
 * is re-stated.
 */
export async function touchPushToken(db: Db, token: string): Promise<PushToken> {
  const [row] = await db
    .update(pushTokens)
    .set({ lastSeenAt: sql`now()` })
    .where(and(eq(pushTokens.token, token), isNull(pushTokens.invalidatedAt)))
    .returning();
  if (!row) throw new PushTokenNotFoundError(token);
  return row;
}

/**
 * Marks a device as gone: a logout, or a provider receipt (APNs 410 / FCM
 * UNREGISTERED).
 *
 * The `invalidated_at is null` predicate IS the compare-and-set, so a concurrent
 * double-invalidate loses cleanly with zero rows rather than overwriting the
 * first instant. Zero rows then takes the transitionPeriod loser path: re-read,
 * and if the row exists it was already invalidated — logging out twice is not an
 * error, and the FIRST instant stands.
 */
export async function invalidatePushToken(db: Db, token: string): Promise<PushToken> {
  const [row] = await db
    .update(pushTokens)
    .set({ invalidatedAt: sql`now()` })
    .where(and(eq(pushTokens.token, token), isNull(pushTokens.invalidatedAt)))
    .returning();
  if (row) return row;
  const existing = await getPushTokenByToken(db, token);
  if (!existing) throw new PushTokenNotFoundError(token);
  return existing;
}

/**
 * The batch form, for a provider's dead-token receipt list after a send.
 *
 * Unknown tokens are silently absent from the result rather than throwing: a
 * receipt list is the provider's statement about its own records, not an
 * assertion about this table.
 */
export async function invalidatePushTokens(
  db: Db,
  tokens: readonly string[]
): Promise<PushToken[]> {
  if (tokens.length === 0) return [];
  return db
    .update(pushTokens)
    .set({ invalidatedAt: sql`now()` })
    .where(and(inArray(pushTokens.token, [...tokens]), isNull(pushTokens.invalidatedAt)))
    .returning();
}

/** Logging out everywhere. */
export async function invalidateTokensForUser(db: Db, userId: string): Promise<PushToken[]> {
  return db
    .update(pushTokens)
    .set({ invalidatedAt: sql`now()` })
    .where(and(eq(pushTokens.userId, userId), isNull(pushTokens.invalidatedAt)))
    .returning();
}

export async function getPushToken(db: Db, id: string): Promise<PushToken | undefined> {
  const [row] = await db.select().from(pushTokens).where(eq(pushTokens.id, id));
  return row;
}

export async function getPushTokenByToken(db: Db, token: string): Promise<PushToken | undefined> {
  const [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
  return row;
}

/** The dispatcher's fan-out: one provider call per row. */
export async function listLivePushTokens(db: Db, userId: string): Promise<PushToken[]> {
  return db
    .select()
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), isNull(pushTokens.invalidatedAt)));
}

/** Every registration, live or not — a settings screen's device list. */
export async function listPushTokensForUser(db: Db, userId: string): Promise<PushToken[]> {
  return db.select().from(pushTokens).where(eq(pushTokens.userId, userId));
}

export async function deletePushToken(db: Db, id: string): Promise<void> {
  await db.delete(pushTokens).where(eq(pushTokens.id, id));
}

/**
 * Drops rows invalidated before the cutoff. Unlike a notification row, deleting
 * one of these re-arms nothing: a device that registers again simply inserts.
 */
export async function pruneInvalidatedPushTokens(db: Db, before: Date): Promise<number> {
  const deleted = await db
    .delete(pushTokens)
    .where(lt(pushTokens.invalidatedAt, before))
    .returning({ id: pushTokens.id });
  return deleted.length;
}

// There is deliberately NO updatePushToken and no PushTokenPatch, the same way
// blocks.ts has no patch type: `token` is identity, `platform` travels with the
// token through re-registration, and all three timestamps are owned by
// register / touch / invalidate. There is nothing left to patch.
//
// There is also no transition matrix. Two states with one reversible edge do not
// need an ALLOWED_* map — the `invalidated_at is null` predicate above IS the
// compare-and-set, and it is what makes the concurrent case lose cleanly.
