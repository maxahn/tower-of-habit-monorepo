import { inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db, pgError, useTestOwner } from '../test-utils.js';
import { sessions } from './schema.js';
import {
  createSession,
  findLiveSessionByHash,
  revokeAllForUser,
  revokeSession,
  touchLastSeen,
} from './sessions.js';

/*
 * 2.9 sessions, against real Postgres. RED until Pass 3 (the queries are stubs).
 * Expiry and the at-most-hourly last_seen refresh are proven by seeding explicit
 * timestamps, never by waiting.
 */

const owner = useTestOwner();

const created: string[] = [];
afterEach(async () => {
  if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.splice(0)));
});

const freshHash = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, ''); // 64 hex

/** Bypasses the service to seed a row with chosen timestamps. */
async function rawSession(values: Partial<typeof sessions.$inferInsert> = {}) {
  const [row] = await db
    .insert(sessions)
    .values({
      userId: values.userId ?? owner(),
      tokenHash: values.tokenHash ?? freshHash(),
      expiresAt: values.expiresAt ?? new Date(Date.now() + 90 * 86_400_000),
      ...values,
    })
    .returning();
  created.push(row!.id);
  return row!;
}

describe('createSession', () => {
  it('sets expires_at ≈ now + ttl, last_seen_at ≈ created_at, revoked_at null', async () => {
    const row = await createSession(db, {
      userId: owner(),
      tokenHash: freshHash(),
      userAgent: 'vitest',
      ttlSeconds: 90 * 86_400,
    });
    created.push(row.id);

    expect(row.revokedAt).toBeNull();
    expect(row.userAgent).toBe('vitest');
    const ttlDays = (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000;
    expect(ttlDays).toBeGreaterThan(89.9);
    expect(ttlDays).toBeLessThan(90.1);
    expect(Math.abs(row.lastSeenAt.getTime() - row.createdAt.getTime())).toBeLessThan(1000);
  });

  it('rejects a duplicate token hash (sessions_token_hash_unique)', async () => {
    const tokenHash = freshHash();
    await rawSession({ tokenHash });
    const e = await pgError(rawSession({ tokenHash }));
    expect(e).toMatchObject({ code: '23505', constraint_name: 'sessions_token_hash_unique' });
  });
});

describe('findLiveSessionByHash', () => {
  it('returns a live session', async () => {
    const tokenHash = freshHash();
    const row = await rawSession({ tokenHash });
    expect((await findLiveSessionByHash(db, tokenHash))?.id).toBe(row.id);
  });

  it('excludes a revoked session', async () => {
    const tokenHash = freshHash();
    await rawSession({ tokenHash, revokedAt: new Date() });
    expect(await findLiveSessionByHash(db, tokenHash)).toBeUndefined();
  });

  it('excludes an expired session', async () => {
    const tokenHash = freshHash();
    await rawSession({
      tokenHash,
      createdAt: new Date(Date.now() - 100 * 86_400_000),
      expiresAt: new Date(Date.now() - 10 * 86_400_000),
    });
    expect(await findLiveSessionByHash(db, tokenHash)).toBeUndefined();
  });
});

describe('touchLastSeen (at most once per hour)', () => {
  it('bumps last_seen_at when it is more than an hour stale', async () => {
    const stale = new Date(Date.now() - 2 * 3_600_000);
    const row = await rawSession({ createdAt: stale, lastSeenAt: stale });
    const touched = await touchLastSeen(db, row.id);
    expect(touched).toBeDefined();
    expect(touched!.lastSeenAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it('leaves a recently-seen session untouched', async () => {
    const recent = new Date(Date.now() - 5 * 60_000); // 5 minutes ago
    const row = await rawSession({
      createdAt: new Date(Date.now() - 10 * 60_000),
      lastSeenAt: recent,
    });
    expect(await touchLastSeen(db, row.id)).toBeUndefined();
    const [after] = await db
      .select()
      .from(sessions)
      .where(inArray(sessions.id, [row.id]));
    expect(after!.lastSeenAt.getTime()).toBe(recent.getTime());
  });
});

describe('revoke', () => {
  it('revokeSession is compare-and-set: once, then undefined', async () => {
    const row = await rawSession();
    expect((await revokeSession(db, row.id))?.revokedAt).toBeInstanceOf(Date);
    expect(await revokeSession(db, row.id)).toBeUndefined();
  });

  it('revokeAllForUser revokes every live session for the user', async () => {
    await rawSession();
    await rawSession();
    const revoked = await revokeAllForUser(db, owner());
    expect(revoked.length).toBe(2);
    expect(await findLiveSessionByHash(db, revoked[0]!.tokenHash)).toBeUndefined();
  });
});
