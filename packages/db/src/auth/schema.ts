import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { citext } from '../columns.js';
import { users } from '../schema.js';

// Email-OTP authentication (2.9). Two tables: a short-lived one-time code, and
// a long-lived session. No passwords anywhere — the users table dropped its
// password_hash column.

/**
 * A SHA-256 hex digest is exactly 64 characters. Both the login code and the
 * session token are stored only as their SHA-256 hash, never in the clear:
 *   - A 6-digit code has ~20 bits of entropy, brute-forceable offline in
 *     milliseconds, so a leaked auth_codes table must not be a leaked set of
 *     live codes.
 *   - A raw session token is a bearer credential; it is never persisted in any
 *     form, so lookup is by hash.
 */
export const SHA256_HEX_LENGTH = 64;

// One live code per email at a time (requestCode deletes prior live rows). Keyed
// on EMAIL, not user_id, and with NO foreign key: the user does not exist until
// the first successful verification, which is where createUser runs.
export const authCodes = pgTable(
  'auth_codes',
  {
    id: uuid().primaryKey().defaultRandom(),
    // citext + trimmed/lowercased on write (normalizeEmail at the API edge), so
    // it joins back to users.email, which is also citext.
    email: citext().notNull(),
    // SHA-256 hex of the 6-digit code. Compared in constant time by the service.
    codeHash: varchar({ length: SHA256_HEX_LENGTH }).notNull(),
    // Failed verifications against THIS code. The service invalidates the code at
    // 5 (findLiveCodeForEmail stops returning it). This is the per-code cap, a
    // different control from the per-email rate limit (2.18): the cap stops
    // guessing one live code, the limiter stops request-a-fresh-code-and-retry.
    attemptCount: integer().notNull().default(0),
    // created_at + 10 minutes, written with the DATABASE clock by insertAuthCode
    // (sql`now() + interval`), never host time — the expires_after_created CHECK
    // below is only safe because both sides come from Postgres.
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    // Null = live (the compare-and-set target for single-use consumption).
    consumedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // findLiveCodeForEmail filters by email; the delete in invalidateCodesForEmail
    // and the per-request insert both key on it.
    index('auth_codes_email_idx').on(table.email),
    check('auth_codes_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    check('auth_codes_attempt_count_nonneg', sql`${table.attemptCount} >= 0`),
  ]
);

// A session: 30 days, rotatable via /auth/refresh, revocable.
export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar({ length: SHA256_HEX_LENGTH })
      .notNull()
      .unique('sessions_token_hash_unique'),
    // On refresh the old hash moves here. A request matching this hash within
    // the grace window (30 s) is allowed; after that it triggers revocation
    // (reuse detection — the theft signal).
    previousTokenHash: varchar({ length: SHA256_HEX_LENGTH }),
    // DB clock when the last rotation happened. Null until first refresh.
    rotatedAt: timestamp({ withTimezone: true }),
    userAgent: varchar({ length: 400 }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    check('sessions_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    check('sessions_last_seen_not_before_created', sql`${table.lastSeenAt} >= ${table.createdAt}`),
  ]
);
