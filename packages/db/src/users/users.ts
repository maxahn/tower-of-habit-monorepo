import { sql } from 'drizzle-orm';
import type { db as appDb } from '../client.js';
import { users } from './schema.js';

type Db = typeof appDb;
export type User = typeof users.$inferSelect;

export async function findUserByEmail(db: Db, email: string): Promise<User | undefined> {
  // Explicit ::citext: if the driver sends the parameter as text, `citext =
  // text` resolves to text = text and silently goes case-sensitive.
  const [row] = await db
    .select()
    .from(users)
    .where(sql`${users.email} = ${email.trim()}::citext`);
  return row;
}
