import { sql } from 'drizzle-orm';
import { check, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { citext, DISPLAY_VARCHAR_MAX } from '../columns.js';

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    // citext: stored as entered (case kept for display), compared
    // case-insensitively, so the plain unique index already rejects
    // Max@x.com vs max@x.com. No app-side lowercasing or lower() index.
    // Callers should still trim(). Look up via findUserByEmail (see users.ts
    // for why the parameter needs a ::citext cast).
    email: citext().notNull().unique(),
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
  },
  (table) => [
    // citext has no length modifier. 320 = 64-char local part + '@' +
    // 255-char domain, the limit varchar(320) used to enforce.
    check('users_email_length', sql`length(${table.email}) <= 320`),
  ]
);
