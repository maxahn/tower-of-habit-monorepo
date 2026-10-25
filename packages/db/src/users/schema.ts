import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { DISPLAY_VARCHAR_MAX } from '../columns.js';

export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  // Stored already-lowercased; normalize at the write boundary in app code.
  // A plain unique index then gives case-insensitive uniqueness without a
  // lower(email) functional index that every query would have to opt into.
  // 320 = 64-char local part + '@' + 255-char domain.
  email: varchar({ length: 320 }).notNull().unique(),
  // 255 covers bcrypt (60) and argon2id (~100) with headroom.
  passwordHash: varchar({ length: 255 }).notNull(),
  displayName: varchar({ length: DISPLAY_VARCHAR_MAX }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  // ORM-side only: fires on db.update(users), not on raw SQL or Studio edits.
  // Needs a Postgres trigger if direct SQL writes ever land.
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
