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

// A session: 90 days, refreshed last_seen_at at most hourly, revocable.
export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Cascade: a session with no user has nothing to authenticate, and it keeps
    // account deletion from being blocked by a session row (same reasoning as
    // push_tokens.user_id).
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 hex of a 32-byte CSPRNG token. Unique: lookup is by this hash, and
    // a collision would let two raw tokens resolve to one session. The raw token
    // is never stored. Named explicitly (like push_tokens_token_unique) so tests
    // can assert the 23505 by constraint name.
    tokenHash: varchar({ length: SHA256_HEX_LENGTH })
      .notNull()
      .unique('sessions_token_hash_unique'),
    // Optional: the client's User-Agent at creation, for a "your devices" screen.
    // Nullable because it is advisory, not load-bearing.
    userAgent: varchar({ length: 400 }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // A registration IS a sighting, so NOT NULL with the same default as
    // created_at. Bumped by touchLastSeen at most once per hour (DB clock).
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // created_at + 90 days, DATABASE clock (see expires_after_created CHECK).
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    // Null = live. Set by logout (this session) or revoke-all (every session).
    revokedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    // FK columns aren't indexed automatically; the user cascade and
    // revokeAllForUser both scan user_id.
    index('sessions_user_id_idx').on(table.userId),
    check('sessions_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    check('sessions_last_seen_not_before_created', sql`${table.lastSeenAt} >= ${table.createdAt}`),
  ]
);
