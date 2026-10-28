import { and, asc, desc, eq, lt, lte, sql } from 'drizzle-orm';
import {
  buildDedupeKey,
  dedupeEventRecipient,
  type NotificationEvent,
} from '@tower-of-habit/shared';
import type { Db } from '../client.js';
import { isUniqueViolation } from '../pg-errors.js';
import { notifications, type NotificationStatus } from './schema.js';

export type Notification = typeof notifications.$inferSelect;

/**
 * `type` and `dedupe_key` are NOT fields here: both are DERIVED from `event`, so
 * a row whose type disagrees with its key is unreachable through this service —
 * the same reason appendBaseBlock refuses a caller-supplied ordinal. `status`,
 * `attempts`, `sent_at` and `error` are dispatcher-owned and move only through
 * transitionNotification.
 */
export type NewNotification = {
  userId: string;
  towerId: string;
  /** Resolved ONCE by the caller, like deadline_at. Never re-derived at dispatch. */
  scheduledFor: Date;
  event: NotificationEvent;
};

/** One dispatcher tick's worth of due rows. Bounds the read and the fan-out. */
export const DEFAULT_DUE_LIMIT = 100;
/**
 * A notification that has failed this many times is poison and the due read
 * stops picking it up. It then never sends, so it needs an operator alert —
 * the same gap MAX_CLAIM_ATTEMPTS documents on tower_periods.
 */
export const MAX_SEND_ATTEMPTS = 5;
/**
 * A FLOOR, not a preference. Pruning a row deletes its dedupe key and RE-ARMS
 * the event: the next evaluation of a period inside this window would send a
 * collapse push that already went out. So the retention window must exceed the
 * longest span over which the evaluator can re-run a period (MAX_CLAIM_ATTEMPTS
 * leases, plus any manual replay).
 */
export const MIN_DEDUPE_RETENTION_DAYS = 90;

// An error can't be omitted when failing: notifications_error_iff_failed would
// reject the row, and the type says so first.
export type NotificationTransition =
  { to: 'sent' } | { to: 'failed'; error: string } | { to: 'skipped' } | { to: 'pending' };

export const ALLOWED_NOTIFICATION_TRANSITIONS: Record<
  NotificationStatus,
  readonly NotificationStatus[]
> = {
  pending: ['sent', 'failed', 'skipped'],
  // Terminal: a push cannot be unsent.
  sent: [],
  // 'pending' is an explicit re-queue. Abandoning a notification is leaving it
  // failed, not transitioning it anywhere.
  failed: ['pending'],
  // Terminal: the moment has passed. There was no device to send to.
  skipped: [],
};

export class NotificationNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Notification not found: ${id}`);
    this.name = 'NotificationNotFoundError';
  }
}

export class IllegalNotificationTransitionError extends Error {
  constructor(
    readonly from: NotificationStatus,
    readonly to: NotificationStatus
  ) {
    super(`Illegal notification status transition: ${from} -> ${to}`);
    this.name = 'IllegalNotificationTransitionError';
  }
}

export class DuplicateNotificationError extends Error {
  constructor(
    readonly dedupeKey: string,
    readonly existingId: string | undefined
  ) {
    super(`Notification already exists for dedupe key: ${dedupeKey}`);
    this.name = 'DuplicateNotificationError';
  }
}

export class NotificationScopeMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(`Notification event names recipient ${expected}, but the row is for ${actual}`);
    this.name = 'NotificationScopeMismatchError';
  }
}

/** Pure check, usable by the evaluator before it touches the DB. */
export function assertNotificationTransition(
  from: NotificationStatus,
  to: NotificationStatus
): void {
  if (!ALLOWED_NOTIFICATION_TRANSITIONS[from].includes(to)) {
    throw new IllegalNotificationTransitionError(from, to);
  }
}

/**
 * The values both writers insert, with type and key derived from the event.
 *
 * The scope check is load-bearing, not defensive. If the key named a different
 * recipient than the row, the next evaluation would compute the OTHER user's key
 * — which collides with nothing — and send a second push. Membership-scoped
 * events (dormant, returned) name no recipient, so there is nothing to check.
 */
function valuesFor(input: NewNotification) {
  const { userId, towerId, scheduledFor, event } = input;
  const recipient = dedupeEventRecipient(event);
  if (recipient !== undefined && recipient !== userId) {
    throw new NotificationScopeMismatchError(recipient, userId);
  }
  return {
    userId,
    towerId,
    scheduledFor,
    type: event.type,
    dedupeKey: buildDedupeKey(event),
  };
}

/**
 * The STRICT writer: a duplicate is an error, cleanly typed.
 *
 * For a caller that must know the row is new — an admin "send this now", a
 * one-off broadcast. The evaluator does NOT use this; see ensureNotification for
 * why an exception is the wrong shape for an idempotent re-run.
 *
 * Name-checked rather than any-23505. retriedEntry's any-violation rule exists
 * because entries has TWO unique indexes and Postgres reports whichever it
 * validated first; notifications has exactly one, so the name test is exact and
 * won't swallow a future index. The moment a second unique index lands here,
 * this must become the entries-style any-23505 test.
 */
export async function scheduleNotification(db: Db, input: NewNotification): Promise<Notification> {
  const values = valuesFor(input);
  try {
    const [row] = await db.insert(notifications).values(values).returning();
    return row!;
  } catch (e) {
    if (isUniqueViolation(e, 'notifications_dedupe_key_unique')) {
      const existing = await getNotificationByDedupeKey(db, values.dedupeKey);
      throw new DuplicateNotificationError(values.dedupeKey, existing?.id);
    }
    throw e;
  }
}

/**
 * The IDEMPOTENT writer, and the one the evaluator calls: the row for this
 * event, created if absent. Racing callers all get the winner's row; none errors.
 *
 * Why this exists alongside scheduleNotification is TRANSACTION COMPOSITION, not
 * ergonomics. The evaluator writes the period transition, towers.height /
 * current_streak, the base block and the notification rows in ONE transaction.
 * Inside a transaction a 23505 is not a catchable hiccup — it ABORTS the
 * transaction, and every later statement fails with 25P02 until rollback. An
 * exception-based dedupe would therefore kill the one transaction that matters,
 * in the expected case, on every re-run. ON CONFLICT never raises, so this
 * composes. (appendBaseBlock makes the same argument choosing locking over
 * retry-on-23505: locking composes, retrying does not.)
 *
 * onConflictDoUpdate with a no-op SET, not onConflictDoNothing + re-select: DO
 * NOTHING doesn't wait on an UNCOMMITTED conflicting row, it returns zero rows
 * at once, so the loser's re-select could find nothing for a row that is about
 * to exist. DO UPDATE blocks on the winner and returns its row.
 *
 * The SET writes back the conflict target, which equals the existing value BY
 * DEFINITION of the conflict. It must NOT write back status, attempts,
 * scheduled_for, sent_at or error: that would reset an already-SENT collapse to
 * pending and send it again, which is the exact bug this table exists to
 * prevent. The winner's row stands, whole.
 *
 * Returns the row rather than a `created` flag. The dispatcher doesn't want to
 * know whose insert won; it wants to know whether this event is still owed a
 * push — and a loser whose row is still 'pending' SHOULD be dispatched, because
 * the winner may have crashed between inserting and sending. `row.status` is
 * that signal, and it stays correct no matter who inserted.
 */
export async function ensureNotification(db: Db, input: NewNotification): Promise<Notification> {
  const values = valuesFor(input);
  const [row] = await db
    .insert(notifications)
    .values(values)
    .onConflictDoUpdate({
      target: notifications.dedupeKey,
      set: { dedupeKey: sql`excluded.dedupe_key` },
    })
    .returning();
  return row!;
}

export async function getNotification(db: Db, id: string): Promise<Notification | undefined> {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
  return row;
}

export async function getNotificationByDedupeKey(
  db: Db,
  dedupeKey: string
): Promise<Notification | undefined> {
  const [row] = await db.select().from(notifications).where(eq(notifications.dedupeKey, dedupeKey));
  return row;
}

/**
 * The dispatcher's due read: everything owed a push, oldest first.
 *
 * The status is a SQL LITERAL rather than eq(status, 'pending') for the same
 * reason claimDuePeriods spells its states out: a bind parameter isn't provably
 * equal to a partial index predicate at plan time, so a generic plan could not
 * use notifications_due.
 *
 * KNOWN GAP (closes with the dispatcher ticket): this is a READ, not a claim.
 * notifications_dedupe_key_unique guarantees one ROW per event; one DELIVERY per
 * row needs a lease — a 'sending' status plus claimed_at, the shape
 * claimDuePeriods already has. Until then two concurrent dispatchers could both
 * pick up the same row and double-send. `attempts` is incremented by the RESULT
 * transition rather than by a claim, so it stays honest about what it counts.
 */
export async function listDueNotifications(
  db: Db,
  now: Date,
  limit = DEFAULT_DUE_LIMIT
): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        sql`${notifications.status} = 'pending'`,
        lte(notifications.scheduledFor, now),
        lt(notifications.attempts, MAX_SEND_ATTEMPTS)
      )
    )
    .orderBy(asc(notifications.scheduledFor))
    .limit(limit);
}

export async function listNotificationsForUser(
  db: Db,
  userId: string,
  limit = 50
): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.scheduledFor))
    .limit(limit);
}

export async function listNotificationsForTower(
  db: Db,
  towerId: string,
  limit = 50
): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.towerId, towerId))
    .orderBy(desc(notifications.scheduledFor))
    .limit(limit);
}

/**
 * The single mutator. Reads, checks the edge, then compare-and-sets.
 *
 * sent_at and error are set to satisfy the two iffs
 * (notifications_sent_at_iff_sent, notifications_error_iff_failed). attempts is
 * incremented on the RESULT of an attempt — sent or failed — and left alone on a
 * re-queue or a skip, because neither was an attempt to deliver.
 *
 * sql`now()` rather than `new Date()`, which is where this differs from
 * transitionPeriod: both tables in this subsystem take their instants from the
 * database clock, and push_tokens has ordering CHECKs that REQUIRE it. One clock
 * across the pair is worth more than matching the older file.
 */
export async function transitionNotification(
  db: Db,
  id: string,
  t: NotificationTransition
): Promise<Notification> {
  const current = await getNotification(db, id);
  if (!current) throw new NotificationNotFoundError(id);
  const from = current.status;
  assertNotificationTransition(from, t.to);

  const [row] = await db
    .update(notifications)
    .set({
      status: t.to,
      sentAt: t.to === 'sent' ? sql`now()` : null,
      error: t.to === 'failed' ? t.error : null,
      ...(t.to === 'sent' || t.to === 'failed'
        ? { attempts: sql`${notifications.attempts} + 1` }
        : {}),
    })
    // Conditioning on the observed `from` makes a concurrent transition lose
    // cleanly (zero rows) instead of overwriting.
    .where(and(eq(notifications.id, id), eq(notifications.status, from)))
    .returning();
  if (!row) {
    const latest = await getNotification(db, id);
    if (!latest) throw new NotificationNotFoundError(id);
    throw new IllegalNotificationTransitionError(latest.status, t.to);
  }
  return row;
}

export async function deleteNotification(db: Db, id: string): Promise<void> {
  await db.delete(notifications).where(eq(notifications.id, id));
}

/**
 * Retention. Takes an EXPLICIT cutoff and has no default on purpose: deleting a
 * row deletes its dedupe key and re-arms the event, so a prune with a default is
 * a prune someone runs without reading what it re-arms. See
 * MIN_DEDUPE_RETENTION_DAYS for the floor the cutoff must respect.
 */
export async function pruneNotificationsBefore(db: Db, cutoff: Date): Promise<number> {
  const deleted = await db
    .delete(notifications)
    .where(lt(notifications.createdAt, cutoff))
    .returning({ id: notifications.id });
  return deleted.length;
}

// There is deliberately NO updateNotification and no NotificationPatch. user_id,
// tower_id, type and dedupe_key are immutable identity; the outcome columns move
// only through transitionNotification; scheduled_for is resolved once at
// creation. Rescheduling is a different event, or it is nothing.
