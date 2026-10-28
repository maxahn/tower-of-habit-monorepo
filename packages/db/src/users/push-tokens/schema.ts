import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from '../schema.js';

// Enum type names are NOT affected by `casing`, so they're snake_case here.
//
// ios | android only. No 'web' value before a web client exists: ALTER TYPE ...
// ADD VALUE is cheap and non-blocking, while REMOVING a value is impossible, so
// the asymmetry says invent nothing.
export const pushPlatformEnum = pgEnum('push_platform', ['ios', 'android']);

export type PushPlatform = (typeof pushPlatformEnum.enumValues)[number];

/**
 * Headroom, not a spec. FCM registration tokens are ~160 chars and have grown
 * twice, APNs device tokens are 64 hex, Expo's wrapper is ~41. `text` has no
 * length modifier, so a CHECK is the only place a bound can be stated — the
 * same reason users_email_length exists. Must match the literal in
 * push_tokens_token_length below.
 */
export const PUSH_TOKEN_MAX = 512;

// One row per device registration. The dispatcher's fan-out is
// listLivePushTokens(user) -> one provider call per row.
//
// THERE IS NO is_active BOOLEAN. `invalidated_at IS NULL` *is* the live state,
// and it carries strictly more information than a flag would: a reaper needs the
// instant to apply a retention window, and reinstatement is `set null`. Two
// columns encoding one fact would need an iff constraint bought entirely to
// protect a redundancy.
//
// What else is deliberately NOT a column:
//   - No device_id, device_name, app_version, os_version or locale. The "a
//     nullable column is free, a migration on a live table isn't" precedent
//     (memberships.voluntary_return_date, tower_periods.freebie_source) applies
//     to columns with a NAMED future ticket behind them. Nothing names these, so
//     there is nothing to shape them to, and an unused column invites a feature
//     nobody designed.
//   - No last_push_error. A failed delivery is recorded on the notification row,
//     which is the thing that failed. The only verdict a provider returns about
//     the TOKEN is "gone", and that is invalidated_at.
//
// Invariants the service layer owns (push-tokens.ts), none expressible here:
//   - A token is REASSIGNED, never duplicated. Registering a token already held
//     by another user MOVES the row (see registerPushToken): a device handed to
//     another person must stop receiving the previous owner's towers, and
//     push_tokens_token_unique is what makes that the only reachable outcome.
//   - last_seen_at and invalidated_at are written with the DATABASE clock
//     (sql`now()`), never `new Date()`. The two ordering CHECKs below are safe
//     ONLY because of that: skew between an API host and Postgres would
//     otherwise turn a valid registration into a hard 23514.
export const pushTokens = pgTable(
  'push_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Cascade, unlike memberships.user_id: a registration with no user has no
    // recipient and nothing to send, so there is no history worth preserving.
    // It also keeps 1.2's account deletion from being blocked by a device row.
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Opaque provider string. `text`, not varchar: the length is the provider's
    // business and has changed before. See PUSH_TOKEN_MAX.
    token: text().notNull(),
    // Travels with the token and is overwritten on re-registration: a reinstall
    // can legitimately report a different platform for a recycled token.
    platform: pushPlatformEnum().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // The device's last sighting: bumped by register and by touchPushToken (app
    // foreground). NOT NULL with the same default as created_at, because a
    // registration IS a sighting — a nullable "never seen" would be a third
    // liveness value nobody reads.
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Null = live. Set on logout, or when the provider reports the token gone
    // (APNs 410 / FCM UNREGISTERED). Cleared by re-registration; that
    // resurrection is deliberate, see registerPushToken.
    invalidatedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    // THE load-bearing constraint. A token identifies a device installation
    // GLOBALLY, so it belongs to exactly one user at a time. Named explicitly
    // even though the generated name would coincide: it is the ON CONFLICT
    // target in registerPushToken and is asserted by name in the tests, so it
    // is a string two other files depend on.
    unique('push_tokens_token_unique').on(table.token),
    // FK columns aren't indexed automatically, and the user cascade scans this.
    // Full, NOT partial on `invalidated_at IS NULL`: a partial index cannot
    // serve the cascade's `delete where user_id = $1` (which must see
    // invalidated rows too), so it could not replace this one — only be a
    // second index, paid for on every register and invalidate, to save
    // filtering the two or three device rows a user has.
    index('push_tokens_user_id_idx').on(table.userId),
    // 512 = PUSH_TOKEN_MAX. Written as a literal because an interpolated number
    // becomes a bind parameter, which is not valid in DDL.
    check('push_tokens_token_length', sql`length(${table.token}) BETWEEN 1 AND 512`),
    // A token with leading or trailing whitespace — a stray newline from a
    // clipboard or a logging round trip — is a DIFFERENT key to the unique index
    // above, so it registers as a second device and then fails every send.
    // Rejecting it is how that uniqueness guarantee stays about devices.
    //
    // A regex rather than btrim(): single-argument btrim() strips SPACES AND
    // NOTHING ELSE, so it happily accepts a trailing newline, which is the most
    // likely way a bad token actually arrives. Passing btrim an explicit
    // character set works too, but spelling that set in a template literal means
    // escaping every control character twice over and emits raw control bytes
    // into the migration SQL. `\s` covers the whole class in one token.
    // Only the ENDS are checked: internal whitespace is not the unique index's
    // problem, and an empty token is push_tokens_token_length's.
    check('push_tokens_token_trimmed', sql`${table.token} !~ '^\\s|\\s$'`),
    // Separate names, not one bundled constraint: each is an independent fact,
    // and a bundled name cannot tell a failing test which fact broke.
    check(
      'push_tokens_last_seen_not_before_created',
      sql`${table.lastSeenAt} >= ${table.createdAt}`
    ),
    check(
      'push_tokens_invalidated_not_before_created',
      sql`${table.invalidatedAt} IS NULL OR ${table.invalidatedAt} >= ${table.createdAt}`
    ),
    // Deliberately NO `invalidated_at >= last_seen_at`: those two are written by
    // different callers for different reasons (a provider receipt vs. an app
    // foreground), and coupling them would buy an invariant nobody reads.
  ]
);
