import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
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
    // IANA zone, captured at first login (2.9). Validated against the IANA
    // database at the API boundary (isValidTimeZone), the same rule towers use;
    // there is no DB check, only the NOT NULL + default. UTC is the fallback
    // when the verify request omits a timezone.
    timezone: text().notNull().default('UTC'),
    // Nullable: email-OTP signup (2.9) creates the user with only an email and
    // timezone. A display name is collected later in onboarding.
    displayName: varchar({ length: DISPLAY_VARCHAR_MAX }),
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
  // No passwordHash: authentication is passwordless email-OTP (2.9). No
  // password is ever stored, so the column that held one is gone, not nulled.
);
