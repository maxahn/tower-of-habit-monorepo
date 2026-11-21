import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { citext } from '../columns.js';

export const emailDeliverability = pgTable('email_deliverability', {
  email: citext().primaryKey(),
  reason: text().notNull(),
  markedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
