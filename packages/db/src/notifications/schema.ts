import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { towers } from '../towers/schema.js';
import { users } from '../users/schema.js';

// Enum type names are NOT affected by `casing`, so they're snake_case here.
//
// Grouped by subsystem for READABILITY only. Nothing may depend on the enum's
// sort order: ALTER TYPE ... ADD VALUE appends at the end unless BEFORE/AFTER is
// given, so ordinal order is not stable across migrations.
//
// Every value's dedupe SCOPE is documented on NotificationEvent in
// @tower-of-habit/shared, which is also where the reasoning for each lives.
// Adding a value here without adding it there fails a test in this package.
//
// Deliberately NOT here: tower_paused and tower_resumed. Both are REPEATABLE
// and, unlike host_transferred, not naturally once-per-period — a host can pause
// and resume within one day and both are meaningful — so there is no stored
// occurrence referent to key them on (towers has lifecycle and started_at, no
// paused_at). A key built today would either embed the clock, which is not
// idempotent and defeats this entire table, or read `tower_paused:{tower}:{user}`
// and permanently suppress every pause after the first. They arrive with the
// ticket that adds the column or event table to key them on.
export const notificationTypeEnum = pgEnum('notification_type', [
  // Section 5 escalation. Per period per user.
  'nudge',
  'wobble',
  'collapse',
  // Section 6 dormancy ladder. Per membership.
  'dormant',
  'returned',
  // Lifecycle.
  'member_joined',
  'tower_started',
  'tower_archived',
  'block_completed',
  'host_transferred',
]);

// pending -> sent | failed | skipped, with failed -> pending as an explicit
// re-queue. Changes only through transitionNotification (notifications.ts).
//
// 'skipped' is a real outcome, not a shade of failure. The row is created at
// EVALUATION time, before anyone has looked for a device, so "this user has no
// live push token" has to land somewhere. Recording it as 'failed' would make a
// failure dashboard permanently noisy AND make failed -> pending retry something
// that can never succeed. Keeping it separate is what lets 'failed' mean "a
// retry might work".
//
// There is no 'sending' value: see the known gap on listDueNotifications. The
// lease that value belongs to lands with the dispatcher ticket.
export const notificationStatusEnum = pgEnum('notification_status', [
  'pending',
  'sent',
  'failed',
  'skipped',
]);

export type NotificationStatus = (typeof notificationStatusEnum.enumValues)[number];

// No union type is exported for notificationTypeEnum on purpose. The canonical
// NotificationType lives in @tower-of-habit/shared next to buildDedupeKey, which
// is what decides a type's dedupe scope. A second name for the same union here
// would be the divergence the agreement test exists to catch, shipped as API.
// Readers who need the values have notificationTypeEnum.enumValues.

/**
 * `text` has no length modifier; see users_email_length. The longest
 * constructible key is 87 chars ('host_transferred' + two uuids), so this is
 * ~2.3x headroom. Must match the literal in notifications_dedupe_key_length.
 */
export const DEDUPE_KEY_MAX = 200;
/** Enough for a provider error line, short enough to read in a dashboard. */
export const NOTIFICATION_ERROR_MAX = 2000;

// The dispatch outbox: one row per SEMANTIC EVENT a user must be told about.
//
// dedupe_key is the entire point of this table. The evaluator is idempotent and
// may re-run a period (3.5), so dispatch needs idempotency OF ITS OWN or a
// retried evaluation sends a second collapse push. The key names the event —
// `wobble:{period_id}:{user_id}` — and notifications_dedupe_key_unique absorbs
// the duplicate. It is built ONLY by buildDedupeKey (@tower-of-habit/shared) and
// is never accepted from a caller; see scheduleNotification.
//
// THERE IS NO period_id COLUMN, AND THERE MUST NOT BE ONE. The period id is not
// missing from this row — it is INSIDE dedupe_key, as an opaque referent rather
// than a navigable relationship. In order of severity:
//   1. A period_id FK would make the dedupe key as prunable as the period.
//      tower_periods is explicitly prunable (see towers/blocks/schema.ts), and
//      the key's PERSISTENCE *is* the idempotency guarantee. ON DELETE CASCADE
//      would delete the key, and the very next evaluation of a retained period
//      would re-send a collapse that already went out. RESTRICT would make the
//      outbox block the prune. SET NULL would orphan the referent while the key
//      kept working. So the guarantee must not be reachable by another table's
//      lifecycle. (tower_id CASCADE is safe for the opposite reason: with the
//      tower gone nothing can re-evaluate, so no resend is possible. A period
//      can disappear while its tower lives on.)
//   2. The scope VARIES by type: period for nudge/wobble/collapse and
//      host_transferred, membership for dormant/returned/member_joined, block
//      for block_completed, tower for the remaining lifecycle types. A period_id
//      column would be NULL on most rows and would need a per-type "X iff Y"
//      CHECK to stay honest — several constraints re-encoding what one text key
//      encodes once.
//   3. It is an event identity, not a relationship. Nothing navigates from a
//      notification to a period; the dispatcher needs the user, the tower and
//      the payload.
//   4. What it costs: you cannot JOIN notifications to tower_periods. Accepted.
//      The per-period read is a prefix match (dedupe_key LIKE 'wobble:<uuid>:%')
//      and split_part(dedupe_key, ':', 2)::uuid is the escape hatch for a cold
//      analytics query. Neither is a hot path. The column set is pinned by a
//      test in notifications.test.ts so period_id cannot arrive by accident.
//
// Invariants the service layer owns (notifications.ts), none expressible here:
//   - type and dedupe_key AGREE, because both are derived from one
//     NotificationEvent by scheduleNotification. A row saying type = 'wobble'
//     with a key reading `collapse:...` is unreachable through the service.
//   - scheduled_for is RESOLVED ONCE at creation from the period's deadline_at
//     minus the tower's lead minutes — the same doctrine as deadline_at itself
//     (see towers/periods/schema.ts). It is not re-derived at dispatch time.
//   - RETENTION IS PART OF THE IDEMPOTENCY GUARANTEE. Deleting a row deletes its
//     dedupe key and RE-ARMS the event. Any prune window must exceed the longest
//     span over which the evaluator can re-run a period. See
//     MIN_DEDUPE_RETENTION_DAYS.
export const notifications = pgTable(
  'notifications',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Cascade: a message with no recipient cannot be delivered and must not
    // block 1.2's account deletion. Unlike memberships.user_id there is no
    // history worth protecting here — base_blocks is the history.
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // NOT NULL: every value in notificationTypeEnum is a tower event. A
    // tower-less notification would be an account email, which is a different
    // subsystem with a different transport.
    towerId: uuid()
      .notNull()
      .references(() => towers.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum().notNull(),
    // The semantic event id. See the header. Opaque to SQL on purpose: there is
    // no format CHECK, because encoding the key grammar in SQL as well would be
    // the same rule written twice, in two languages, drifting apart on the first
    // change to either — the argument base_blocks makes about roster. Length is
    // the only thing SQL can usefully say about it.
    dedupeKey: text().notNull(),
    // The intended delivery instant: deadline_at minus the nudge/wobble lead for
    // the escalation types, the evaluation instant for a collapse. No default —
    // caller-owned and derived, like deadline_at.
    scheduledFor: timestamp({ withTimezone: true }).notNull(),
    status: notificationStatusEnum().notNull().default('pending'),
    // Delivery attempts so far, incremented by the RESULT transition (sent or
    // failed), not by a claim — there is no claim yet. Bounds the retry loop so
    // a poison notification stops being picked up (MAX_SEND_ATTEMPTS).
    attempts: integer().notNull().default(0),
    // Set iff status = 'sent'. See notifications_sent_at_iff_sent.
    sentAt: timestamp({ withTimezone: true }),
    // Set iff status = 'failed'. See notifications_error_iff_failed.
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // THE constraint this ticket exists for. A retried evaluation's second
    // insert loses here rather than becoming a second push. Named explicitly:
    // ensureNotification targets it and the tests assert it by name.
    unique('notifications_dedupe_key_unique').on(table.dedupeKey),
    // The dispatcher's due read. Shaped exactly like periods_due, partial
    // predicate included: the overwhelming majority of rows in a retained outbox
    // are terminal, and the index should not carry them. Callers must write the
    // state as a SQL LITERAL rather than eq(status, 'pending') — a bind
    // parameter isn't provably equal to a partial index predicate at plan time,
    // so a generic plan could not use this index.
    index('notifications_due')
      .on(table.status, table.scheduledFor)
      .where(sql`${table.status} = 'pending'`),
    // FK columns aren't indexed automatically. The unique above leads with
    // dedupe_key, so neither FK is covered by it, and an un-indexed cascade is a
    // sequential scan of the whole outbox on every account or tower deletion.
    // Single-column, not (user_id, scheduled_for desc): the cascade is what
    // justifies these today, and an ordering column is added when a read needs
    // it, not in advance.
    index('notifications_user_id_idx').on(table.userId),
    index('notifications_tower_id_idx').on(table.towerId),
    // 200 = DEDUPE_KEY_MAX, written as a literal: an interpolated number becomes
    // a bind parameter, which is not valid in DDL.
    check('notifications_dedupe_key_length', sql`length(${table.dedupeKey}) BETWEEN 1 AND 200`),
    // TWO SEPARATE IFFS UNDER TWO NAMES, not one combined constraint. The
    // tempting form is
    //     (status IN ('sent','failed')) = (sent_at IS NOT NULL OR error IS NOT NULL)
    // and it accepts a 'sent' row carrying an error and no sent_at, because
    // true = true. This is the same hole tower_periods_outcome_iff_evaluated
    // splits itself to avoid. Two names also mean a failing test names the fact
    // that broke rather than the pair.
    //
    // Plain `=`, NOT `IS NOT DISTINCT FROM`: status is NOT NULL, so
    // `status = 'sent'` is never NULL and the CHECK can never be vacuous.
    // tower_periods needs IS NOT DISTINCT FROM on its freebie iff because
    // `outcome` is NULLABLE there and `NULL = 'freebie'` is NULL, which a CHECK
    // lets through. Using it here would be noise that hides where it matters.
    check(
      'notifications_sent_at_iff_sent',
      sql`(${table.status} = 'sent') = (${table.sentAt} IS NOT NULL)`
    ),
    check(
      'notifications_error_iff_failed',
      sql`(${table.status} = 'failed') = (${table.error} IS NOT NULL)`
    ),
    // The iff above is only honest if '' is rejected: an empty-string error
    // satisfies IS NOT NULL while saying nothing, so a failed row could claim a
    // diagnosis it does not have. 2000 = NOTIFICATION_ERROR_MAX.
    check(
      'notifications_error_length',
      sql`${table.error} IS NULL OR length(${table.error}) BETWEEN 1 AND 2000`
    ),
    check('notifications_attempts_nonnegative', sql`${table.attempts} >= 0`),
    // One-directional, NOT an iff, like tower_periods_claimed_unless_pending: a
    // row re-queued to 'pending' after a failure keeps its attempt count, and a
    // 'skipped' row was never attempted at all (no device to send to).
    check(
      'notifications_attempts_recorded_when_attempted',
      sql`${table.status} NOT IN ('sent', 'failed') OR ${table.attempts} >= 1`
    ),
    // Deliberately NOT written:
    //   - sent_at >= scheduled_for. The two instants come from different clocks
    //     on different hosts at different times, so sub-second skew would turn a
    //     push that actually went out into a hard 23514.
    //     tower_periods_evaluate_after_deadline is safe only because both ITS
    //     instants come out of one pure function in one call.
    //   - scheduled_for >= created_at. A backfill legitimately inserts a past
    //     scheduled_for, and the same skew problem applies.
  ]
);
