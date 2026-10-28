import { eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { db, pgError, useTestOwner } from '../../test-utils.js';
import { users } from '../schema.js';
import { pushTokens } from './schema.js';
import {
  deletePushToken,
  getPushToken,
  getPushTokenByToken,
  invalidatePushToken,
  invalidatePushTokens,
  invalidateTokensForUser,
  listLivePushTokens,
  listPushTokensForUser,
  pruneInvalidatedPushTokens,
  PushTokenNotFoundError,
  registerPushToken,
  touchPushToken,
} from './push-tokens.js';

const owner = useTestOwner();

// Extra users for the handoff cases. push_tokens cascades from users, so
// deleting the user takes its registrations with it.
const extraUsers: string[] = [];
afterEach(async () => {
  if (extraUsers.length) {
    await db.delete(users).where(inArray(users.id, extraUsers.splice(0)));
  }
});

async function otherUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}@test.local`,
      passwordHash: 'x',
      displayName: 'Other',
    })
    .returning();
  extraUsers.push(u!.id);
  return u!.id;
}

/** Globally unique: push_tokens_token_unique spans the whole table. */
const freshToken = () => `ExponentPushToken[${crypto.randomUUID()}]`;

/** Bypasses the service, for constraint probes and service-owned columns. */
function rawToken(values: Partial<typeof pushTokens.$inferInsert> = {}) {
  return db
    .insert(pushTokens)
    .values({ userId: owner(), token: freshToken(), platform: 'ios', ...values })
    .returning();
}

describe('push_tokens defaults and CRUD', () => {
  it('inserts with spec defaults', async () => {
    const token = freshToken();
    const row = await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    expect(row).toMatchObject({ userId: owner(), token, platform: 'ios' });
    expect(row.invalidatedAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.lastSeenAt).toBeInstanceOf(Date);
  });

  it('gets by id and by token', async () => {
    const token = freshToken();
    const row = await registerPushToken(db, { userId: owner(), token, platform: 'android' });
    expect((await getPushToken(db, row.id))?.id).toBe(row.id);
    expect((await getPushTokenByToken(db, token))?.id).toBe(row.id);
    expect(await getPushTokenByToken(db, freshToken())).toBeUndefined();
  });

  it('lists every registration for a user, live or not', async () => {
    const a = await registerPushToken(db, {
      userId: owner(),
      token: freshToken(),
      platform: 'ios',
    });
    const b = await registerPushToken(db, {
      userId: owner(),
      token: freshToken(),
      platform: 'ios',
    });
    await invalidatePushToken(db, b.token);
    const all = await listPushTokensForUser(db, owner());
    expect(all.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('deletes', async () => {
    const row = await rawToken().then((r) => r[0]!);
    await deletePushToken(db, row.id);
    expect(await getPushToken(db, row.id)).toBeUndefined();
  });

  // Also what licenses the absence of a cleanup hook in this file.
  it('cascades from the user', async () => {
    const uid = await otherUser();
    const token = freshToken();
    await registerPushToken(db, { userId: uid, token, platform: 'ios' });
    await db.delete(users).where(eq(users.id, uid));
    extraUsers.splice(extraUsers.indexOf(uid), 1);
    expect(await getPushTokenByToken(db, token)).toBeUndefined();
  });
});

describe('push_tokens constraints', () => {
  it('rejects a duplicate token', async () => {
    const token = freshToken();
    await rawToken({ token });
    const e = await pgError(rawToken({ token }));
    expect(e).toMatchObject({ code: '23505', constraint_name: 'push_tokens_token_unique' });
  });

  // The service reassigns; a raw insert must still be refused, because the
  // unique index is what makes reassignment the ONLY reachable outcome.
  it('rejects a duplicate token held by another user', async () => {
    const token = freshToken();
    await rawToken({ token });
    const e = await pgError(rawToken({ token, userId: await otherUser() }));
    expect(e).toMatchObject({ code: '23505', constraint_name: 'push_tokens_token_unique' });
  });

  it.each([
    ['an empty token', ''],
    ['a token past PUSH_TOKEN_MAX', 'x'.repeat(513)],
  ])('rejects %s', async (_label, token) => {
    const e = await pgError(rawToken({ token }));
    expect(e).toMatchObject({ code: '23514', constraint_name: 'push_tokens_token_length' });
  });

  it('accepts a token at exactly PUSH_TOKEN_MAX', async () => {
    const token = 'x'.repeat(512);
    await expect(rawToken({ token })).resolves.toMatchObject([{ token }]);
  });

  it.each([
    ['a trailing newline', `${'a'.repeat(20)}\n`],
    ['a leading space', ` ${'a'.repeat(20)}`],
  ])('rejects a token with %s', async (_label, token) => {
    const e = await pgError(rawToken({ token }));
    expect(e).toMatchObject({ code: '23514', constraint_name: 'push_tokens_token_trimmed' });
  });

  it('rejects last_seen_at before created_at', async () => {
    const created = new Date('2026-03-01T00:00:00.000Z');
    const e = await pgError(
      rawToken({ createdAt: created, lastSeenAt: new Date('2026-02-28T00:00:00.000Z') })
    );
    expect(e).toMatchObject({
      code: '23514',
      constraint_name: 'push_tokens_last_seen_not_before_created',
    });
  });

  it('rejects invalidated_at before created_at', async () => {
    const created = new Date('2026-03-01T00:00:00.000Z');
    const e = await pgError(
      rawToken({
        createdAt: created,
        lastSeenAt: created,
        invalidatedAt: new Date('2026-02-28T00:00:00.000Z'),
      })
    );
    expect(e).toMatchObject({
      code: '23514',
      constraint_name: 'push_tokens_invalidated_not_before_created',
    });
  });

  it('rejects a null token', async () => {
    const e = await pgError(
      db.execute(
        sql`insert into push_tokens (user_id, token, platform)
            values (${owner()}, null, 'ios')`
      )
    );
    expect(e).toMatchObject({ code: '23502' });
  });

  it('rejects a missing user', async () => {
    const e = await pgError(rawToken({ userId: crypto.randomUUID() }));
    expect(e).toMatchObject({
      code: '23503',
      constraint_name: 'push_tokens_user_id_users_id_fk',
    });
  });

  // 22P02 (invalid text representation), NOT 23514: an unknown enum label fails
  // at input conversion, before any constraint runs. Pinned so a future reader
  // knows which code to expect.
  it('rejects an unknown platform', async () => {
    const e = await pgError(
      db.execute(
        sql`insert into push_tokens (user_id, token, platform)
            values (${owner()}, ${freshToken()}, 'windows')`
      )
    );
    expect(e).toMatchObject({ code: '22P02' });
  });
});

describe('registerPushToken reassignment', () => {
  it('registers a live token', async () => {
    const token = freshToken();
    const row = await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    expect(row.invalidatedAt).toBeNull();
    expect(await listLivePushTokens(db, owner())).toHaveLength(1);
  });

  it('is idempotent for the same user and token', async () => {
    const token = freshToken();
    const first = await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    const second = await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    expect(second.id).toBe(first.id);
    expect(await listPushTokensForUser(db, owner())).toHaveLength(1);
    expect(second.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
  });

  // The device-handoff case this ticket exists for.
  it('moves a token to a new user and clears invalidated_at', async () => {
    const token = freshToken();
    const first = await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    await invalidatePushToken(db, token);
    const uid = await otherUser();
    const moved = await registerPushToken(db, { userId: uid, token, platform: 'ios' });
    expect(moved.id).toBe(first.id);
    expect(moved.userId).toBe(uid);
    expect(moved.invalidatedAt).toBeNull();
  });

  it('stops the previous owner receiving the device', async () => {
    const token = freshToken();
    await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    const uid = await otherUser();
    await registerPushToken(db, { userId: uid, token, platform: 'ios' });
    expect(await listLivePushTokens(db, owner())).toEqual([]);
    expect(await listLivePushTokens(db, uid)).toHaveLength(1);
  });

  it('updates the platform a reinstall reports', async () => {
    const token = freshToken();
    await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    const again = await registerPushToken(db, { userId: owner(), token, platform: 'android' });
    expect(again.platform).toBe('android');
  });

  it('leaves created_at untouched on reassignment', async () => {
    const token = freshToken();
    const first = await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    const moved = await registerPushToken(db, {
      userId: await otherUser(),
      token,
      platform: 'ios',
    });
    expect(moved.createdAt.getTime()).toBe(first.createdAt.getTime());
  });

  it('lets concurrent registrations of one token converge on one row', async () => {
    const token = freshToken();
    const rows = await Promise.all(
      Array.from({ length: 5 }, () =>
        registerPushToken(db, { userId: owner(), token, platform: 'ios' })
      )
    );
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(await listPushTokensForUser(db, owner())).toHaveLength(1);
  });

  // THE test that proves DO UPDATE over DO NOTHING. B parks on A's uncommitted
  // index key; DO NOTHING would return zero rows at once and B's re-select would
  // find nothing for a token that is about to exist.
  it('a registration blocked on an uncommitted token key gets the committed row', async () => {
    const token = freshToken();
    const a = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      let release: () => void = () => {};
      let inserted: () => void = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      const aInserted = new Promise<void>((r) => {
        inserted = r;
      });

      const txA = a.begin(async (tx) => {
        await tx`insert into push_tokens (user_id, token, platform)
                 values (${owner()}, ${token}, 'ios')`;
        inserted();
        await held;
      });
      await aInserted;

      const bPromise = registerPushToken(db, {
        userId: owner(),
        token,
        platform: 'android',
      });
      release();
      await txA;

      const b = await bPromise;
      expect(b).toBeDefined();
      expect(b.token).toBe(token);
      expect(await listPushTokensForUser(db, owner())).toHaveLength(1);
    } finally {
      await a.end();
    }
  });

  it('ignores timestamps smuggled in untyped', async () => {
    const token = freshToken();
    const row = await registerPushToken(db, {
      userId: owner(),
      token,
      platform: 'ios',
      invalidatedAt: new Date('2020-01-01T00:00:00.000Z'),
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    } as never);
    expect(row.invalidatedAt).toBeNull();
    expect(row.createdAt.getUTCFullYear()).toBeGreaterThan(2020);
  });
});

describe('invalidation', () => {
  it('invalidates a live token', async () => {
    const token = freshToken();
    await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    const row = await invalidatePushToken(db, token);
    expect(row.invalidatedAt).toBeInstanceOf(Date);
    expect(await listLivePushTokens(db, owner())).toEqual([]);
  });

  // Logging out twice is not an error, and the FIRST instant stands.
  it('is idempotent and keeps the first instant', async () => {
    const token = freshToken();
    await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    const first = await invalidatePushToken(db, token);
    const second = await invalidatePushToken(db, token);
    expect(second.invalidatedAt!.getTime()).toBe(first.invalidatedAt!.getTime());
  });

  it('throws for an unknown token', async () => {
    await expect(invalidatePushToken(db, freshToken())).rejects.toThrow(PushTokenNotFoundError);
  });

  it('batch-invalidates a provider receipt list', async () => {
    const a = freshToken();
    const b = freshToken();
    const keep = freshToken();
    for (const t of [a, b, keep]) {
      await registerPushToken(db, { userId: owner(), token: t, platform: 'ios' });
    }
    const dead = await invalidatePushTokens(db, [a, b]);
    expect(dead).toHaveLength(2);
    expect((await listLivePushTokens(db, owner())).map((t) => t.token)).toEqual([keep]);
  });

  // A receipt list is the provider's statement about its records, not an
  // assertion about this table.
  it('ignores unknown tokens in a receipt list', async () => {
    const live = freshToken();
    await registerPushToken(db, { userId: owner(), token: live, platform: 'ios' });
    const dead = await invalidatePushTokens(db, [live, freshToken(), freshToken()]);
    expect(dead).toHaveLength(1);
  });

  it('invalidates every token for a user and leaves another user alone', async () => {
    const uid = await otherUser();
    await registerPushToken(db, { userId: owner(), token: freshToken(), platform: 'ios' });
    await registerPushToken(db, { userId: owner(), token: freshToken(), platform: 'ios' });
    await registerPushToken(db, { userId: uid, token: freshToken(), platform: 'ios' });
    expect(await invalidateTokensForUser(db, owner())).toHaveLength(2);
    expect(await listLivePushTokens(db, owner())).toEqual([]);
    expect(await listLivePushTokens(db, uid)).toHaveLength(1);
  });

  it('touchPushToken bumps last_seen_at', async () => {
    const token = freshToken();
    const [row] = await rawToken({
      token,
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    const touched = await touchPushToken(db, token);
    expect(touched.lastSeenAt.getTime()).toBeGreaterThan(row!.lastSeenAt.getTime());
  });

  // A client pinging a token the server will not send to must re-register.
  it('touchPushToken refuses an invalidated token', async () => {
    const token = freshToken();
    await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    await invalidatePushToken(db, token);
    await expect(touchPushToken(db, token)).rejects.toThrow(PushTokenNotFoundError);
  });

  it('a concurrent double invalidate produces one instant', async () => {
    const token = freshToken();
    await registerPushToken(db, { userId: owner(), token, platform: 'ios' });
    const results = await Promise.allSettled([
      invalidatePushToken(db, token),
      invalidatePushToken(db, token),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const instants = results.map((r) =>
      r.status === 'fulfilled' ? r.value.invalidatedAt!.getTime() : 0
    );
    expect(new Set(instants).size).toBe(1);
  });

  it('pruneInvalidatedPushTokens deletes only rows invalidated before the cutoff', async () => {
    const old = freshToken();
    const recent = freshToken();
    const created = new Date('2026-01-01T00:00:00.000Z');
    await rawToken({
      token: old,
      createdAt: created,
      lastSeenAt: created,
      invalidatedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await rawToken({
      token: recent,
      createdAt: created,
      lastSeenAt: created,
      invalidatedAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    const live = freshToken();
    await rawToken({ token: live });

    expect(await pruneInvalidatedPushTokens(db, new Date('2026-03-01T00:00:00.000Z'))).toBe(1);
    expect(await getPushTokenByToken(db, old)).toBeUndefined();
    expect(await getPushTokenByToken(db, recent)).toBeDefined();
    expect(await getPushTokenByToken(db, live)).toBeDefined();
  });
});
