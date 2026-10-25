import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach } from 'vitest';
import type { db as appDb } from './client.js';
import * as schema from './schema.js';
import { users } from './schema.js';

const sql = postgres(process.env.DATABASE_URL!);
// Cast: services type their param as the app's db; same schema, same casing.
// Not importing client.ts keeps the connection under the test file's control.
export const db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as typeof appDb;

afterAll(async () => {
  await sql.end();
});

/** Fresh user per test; deleting it cascades to habits and tiers. */
export function useTestOwner(): () => string {
  let ownerId: string;
  beforeEach(async () => {
    const [u] = await db
      .insert(users)
      .values({
        email: `${crypto.randomUUID()}@test.local`,
        passwordHash: 'x',
        displayName: 'Tester',
      })
      .returning();
    ownerId = u!.id;
  });
  afterEach(async () => {
    await db.delete(users).where(eq(users.id, ownerId));
  });
  return () => ownerId;
}

/** Postgres error code lives on the cause in drizzle's wrapped errors. */
export async function pgError(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = (e as { cause?: unknown }).cause ?? e;
    return err as { code?: string; constraint_name?: string; column_name?: string };
  }
  throw new Error('expected a Postgres error, but the promise resolved');
}
