import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db, pgError } from '../test-utils.js';
import { users } from './schema.js';
import { createUser, findUserByEmail } from './users.js';

const created: string[] = [];

afterEach(async () => {
  if (created.length) await db.delete(users).where(inArray(users.id, created.splice(0)));
});

async function insertUser(email: string) {
  const [u] = await db.insert(users).values({ email, displayName: 'Tester' }).returning();
  created.push(u!.id);
  return u!;
}

/** Unique per test, with mixed case so case handling is exercised. */
const mixedCaseEmail = () => `Max.${crypto.randomUUID()}@Example.com`;

describe('users.email citext', () => {
  it('is a citext column', async () => {
    const rows = await db.execute<{ udt_name: string }>(
      sql`select udt_name from information_schema.columns
          where table_name = 'users' and column_name = 'email'`
    );
    expect(rows[0]?.udt_name).toBe('citext');
  });

  it('preserves case as entered', async () => {
    const email = mixedCaseEmail();
    expect((await insertUser(email)).email).toBe(email);
  });

  it('rejects an email differing only by case', async () => {
    const email = mixedCaseEmail();
    await insertUser(email.toLowerCase());
    const e = await pgError(insertUser(email.toUpperCase()));
    expect(e).toMatchObject({ code: '23505', constraint_name: 'users_email_unique' });
  });

  it('findUserByEmail matches case-insensitively and trims', async () => {
    const email = mixedCaseEmail();
    const u = await insertUser(email);
    expect((await findUserByEmail(db, `  ${email.toUpperCase()} `))?.id).toBe(u.id);
    expect(await findUserByEmail(db, `nobody.${crypto.randomUUID()}@example.com`)).toBeUndefined();
  });

  // Documents driver behaviour; findUserByEmail casts regardless.
  it('plain eq() is also case-insensitive with postgres-js', async () => {
    const email = mixedCaseEmail();
    const u = await insertUser(email);
    const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    expect(row?.id).toBe(u.id);
  });

  it('rejects emails longer than 320 characters', async () => {
    const email = `${'a'.repeat(64)}@${'b'.repeat(252)}.com`; // 321 chars
    expect(email).toHaveLength(321);
    const e = await pgError(insertUser(email));
    expect(e).toMatchObject({ code: '23514', constraint_name: 'users_email_length' });
  });

  it('accepts exactly 320 characters', async () => {
    const email = `${'a'.repeat(64)}@${'b'.repeat(251)}.com`;
    expect(email).toHaveLength(320);
    await expect(insertUser(email)).resolves.toMatchObject({ email });
  });
});

describe('users timezone + displayName (2.9: passwordless)', () => {
  it('defaults timezone to UTC', async () => {
    expect((await insertUser(mixedCaseEmail())).timezone).toBe('UTC');
  });

  it('allows a null displayName (set later in onboarding)', async () => {
    const [u] = await db.insert(users).values({ email: mixedCaseEmail() }).returning();
    created.push(u!.id);
    expect(u!.displayName).toBeNull();
  });

  // RED until Pass 3: createUser is a stub.
  it('createUser inserts an OTP user with email + timezone and no display name', async () => {
    const email = `otp.${crypto.randomUUID()}@example.com`;
    const u = await createUser(db, { email, timezone: 'America/New_York' });
    created.push(u.id);
    expect(u).toMatchObject({ email, timezone: 'America/New_York', displayName: null });
  });
});
