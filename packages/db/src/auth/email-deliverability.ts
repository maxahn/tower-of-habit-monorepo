import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { emailDeliverability } from './email-deliverability-schema.js';

export async function markEmailUndeliverable(db: Db, email: string, reason: string): Promise<void> {
  await db
    .insert(emailDeliverability)
    .values({ email: sql`${email}::citext`, reason })
    .onConflictDoUpdate({
      target: emailDeliverability.email,
      set: { reason, markedAt: sql`now()` },
    });
}

export async function isEmailDeliverable(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ email: emailDeliverability.email })
    .from(emailDeliverability)
    .where(eq(emailDeliverability.email, sql`${email}::citext`))
    .limit(1);
  return rows.length === 0;
}

export async function clearEmailDeliverability(db: Db, email: string): Promise<void> {
  await db.delete(emailDeliverability).where(eq(emailDeliverability.email, sql`${email}::citext`));
}
