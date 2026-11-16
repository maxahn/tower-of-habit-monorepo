import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { users } from './schema.js';

export type User = typeof users.$inferSelect;

// Only the columns email-OTP signup sets. timezone has a DB default of 'UTC';
// displayName is nullable and collected later in onboarding. No passwordHash:
// authentication is passwordless (2.9).
export type NewUser = Pick<typeof users.$inferInsert, 'email' | 'timezone'>;

/**
 * Creates a user from a first successful login. The email must already be
 * normalized (trim + lowercase); the citext column rejects a case-variant
 * duplicate as users_email_unique (23505).
 */
export async function createUser(db: Db, input: NewUser): Promise<User> {
  // timezone omitted ⇒ the column default 'UTC' applies. A case-variant
  // duplicate email surfaces as users_email_unique (23505).
  const [row] = await db
    .insert(users)
    .values({ email: input.email, timezone: input.timezone })
    .returning();
  return row!;
}

export async function findUserByEmail(db: Db, email: string): Promise<User | undefined> {
  // Explicit ::citext: if the driver sends the parameter as text, `citext =
  // text` resolves to text = text and silently goes case-sensitive.
  const [row] = await db
    .select()
    .from(users)
    .where(sql`${users.email} = ${email.trim()}::citext`);
  return row;
}
