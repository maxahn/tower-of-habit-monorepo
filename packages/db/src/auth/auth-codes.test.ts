import { inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../test-utils.js';
import {
  consumeCode,
  findLiveCodeForEmail,
  insertAuthCode,
  invalidateCodesForEmail,
  MAX_CODE_ATTEMPTS,
  recordFailedAttempt,
} from './auth-codes.js';
import { authCodes } from './schema.js';

/*
 * 2.9 auth_codes, against real Postgres. RED until Pass 3 (the queries are
 * stubs). The single-use and attempt-cap guarantees are enforced here at the
 * SQL level; time-based states (expired, consumed) are seeded as explicit
 * timestamps rather than by waiting.
 */

const created: string[] = [];
afterEach(async () => {
  if (created.length) await db.delete(authCodes).where(inArray(authCodes.id, created.splice(0)));
});

const freshEmail = () => `code.${crypto.randomUUID()}@example.com`;
const freshHash = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, ''); // 64 hex

/** Bypasses the service to seed a row with chosen timestamps / attempt counts. */
async function rawCode(values: Partial<typeof authCodes.$inferInsert> = {}) {
  const [row] = await db
    .insert(authCodes)
    .values({
      email: values.email ?? freshEmail(),
      codeHash: values.codeHash ?? freshHash(),
      expiresAt: values.expiresAt ?? new Date(Date.now() + 10 * 60_000),
      ...values,
    })
    .returning();
  created.push(row!.id);
  return row!;
}

describe('insertAuthCode', () => {
  it('sets expires_at ≈ now + ttl, consumed_at null, attempt_count 0', async () => {
    const email = freshEmail();
    const row = await insertAuthCode(db, { email, codeHash: freshHash(), ttlSeconds: 600 });
    created.push(row.id);

    expect(row.consumedAt).toBeNull();
    expect(row.attemptCount).toBe(0);
    const ttl = (row.expiresAt.getTime() - row.createdAt.getTime()) / 1000;
    expect(ttl).toBeGreaterThan(595);
    expect(ttl).toBeLessThan(605);
  });
});

describe('findLiveCodeForEmail', () => {
  it('returns a live, unconsumed, unexpired code under the attempt cap', async () => {
    const email = freshEmail();
    const row = await rawCode({ email });
    expect((await findLiveCodeForEmail(db, email))?.id).toBe(row.id);
  });

  it('excludes a consumed code', async () => {
    const email = freshEmail();
    await rawCode({ email, consumedAt: new Date() });
    expect(await findLiveCodeForEmail(db, email)).toBeUndefined();
  });

  it('excludes an expired code', async () => {
    const email = freshEmail();
    // created in the past so expires_after_created still holds, but already past.
    await rawCode({
      email,
      createdAt: new Date(Date.now() - 20 * 60_000),
      expiresAt: new Date(Date.now() - 10 * 60_000),
    });
    expect(await findLiveCodeForEmail(db, email)).toBeUndefined();
  });

  it('excludes a code at the attempt cap', async () => {
    const email = freshEmail();
    await rawCode({ email, attemptCount: MAX_CODE_ATTEMPTS });
    expect(await findLiveCodeForEmail(db, email)).toBeUndefined();
  });
});

describe('consumeCode (single-use, compare-and-set)', () => {
  it('consumes once, then returns undefined on reuse', async () => {
    const row = await rawCode();
    const first = await consumeCode(db, row.id);
    expect(first?.consumedAt).toBeInstanceOf(Date);
    expect(await consumeCode(db, row.id)).toBeUndefined();
  });
});

describe('recordFailedAttempt', () => {
  it('increments attempt_count and retires the code at the cap', async () => {
    const email = freshEmail();
    const row = await rawCode({ email });
    for (let i = 1; i <= MAX_CODE_ATTEMPTS; i++) {
      expect((await recordFailedAttempt(db, row.id))?.attemptCount).toBe(i);
    }
    expect(await findLiveCodeForEmail(db, email)).toBeUndefined();
  });
});

describe('invalidateCodesForEmail (one live code per email)', () => {
  it('removes any outstanding live code for the email', async () => {
    const email = freshEmail();
    await rawCode({ email });
    await rawCode({ email });
    await invalidateCodesForEmail(db, email);
    expect(await findLiveCodeForEmail(db, email)).toBeUndefined();
  });
});
