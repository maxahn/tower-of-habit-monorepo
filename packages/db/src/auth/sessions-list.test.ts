import { inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db, useTestOwner } from '../test-utils.js';
import { sessions } from './schema.js';
import { listLiveSessionsForUser } from './sessions.js';

/*
 * 2.11: GET /me/sessions lists the caller's LIVE sessions (not revoked, not
 * expired), newest first.
 */

const owner = useTestOwner();

const created: string[] = [];
afterEach(async () => {
  if (created.length) await db.delete(sessions).where(inArray(sessions.id, created.splice(0)));
});

const freshHash = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');

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

describe('listLiveSessionsForUser', () => {
  it('returns live sessions only, newest first', async () => {
    const older = await rawSession({
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      lastSeenAt: new Date(Date.now() - 2 * 86_400_000),
      userAgent: 'old phone',
    });
    const newer = await rawSession({ userAgent: 'new phone' });
    await rawSession({ revokedAt: new Date() });
    await rawSession({
      createdAt: new Date(Date.now() - 100 * 86_400_000),
      lastSeenAt: new Date(Date.now() - 100 * 86_400_000),
      expiresAt: new Date(Date.now() - 10 * 86_400_000),
    });

    const rows = await listLiveSessionsForUser(db, owner());
    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(rows.map((r) => r.userAgent)).toEqual(['new phone', 'old phone']);
  });

  it('is scoped to the user', async () => {
    await rawSession();
    expect(await listLiveSessionsForUser(db, crypto.randomUUID())).toEqual([]);
  });
});
