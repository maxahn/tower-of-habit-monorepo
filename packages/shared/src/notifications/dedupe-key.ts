/**
 * Notification dedupe keys: the identity of a semantic event.
 *
 * The evaluator is idempotent and may re-run a period (3.5). That idempotency
 * stops at the database: a re-evaluated period recomputes the same outcome, but
 * a push it already sent cannot be un-sent. So dispatch needs idempotency OF
 * ITS OWN, keyed on the EVENT rather than on the evaluation that produced it —
 * `wobble:{period_id}:{user_id}` — and notifications_dedupe_key_unique absorbs
 * the duplicate.
 *
 * THIS FORMAT IS FROZEN.
 *
 * A format change does not fail; it SILENTLY RE-SENDS every notification still
 * inside the retention window, because a new-format key collides with nothing.
 * There is no error, no log line, and nothing in the database to show it
 * happened — just every user receiving their last 90 days of collapses again.
 * Changing it is therefore a migration that rewrites existing keys, or a mass
 * re-send accepted on purpose. The tests spell every format out as a literal
 * string so the change cannot be quiet.
 *
 * There is deliberately NO version prefix ('v2:wobble:...'). A version number is
 * an invitation to bump it, and bumping it is exactly the failure above wearing
 * a thin coat of intent.
 *
 * Lives here rather than in @tower-of-habit/db because THE EVALUATOR LIVES HERE
 * and cannot import db (the eslint firewall). The evaluator is what decides
 * "period X collapsed for user Y"; if it could not NAME that event, the worker
 * layer would re-derive the scope, and that is where a second, subtly different
 * key format is born. db -> shared is the established direction already
 * (resolvePeriodWindow, parseBlockRoster).
 */

/**
 * Must equal notificationTypeEnum's values in @tower-of-habit/db
 * (src/notifications/schema.ts).
 *
 * Duplicated rather than imported, the same trade ROSTER_DISPLAY_NAME_MAX makes:
 * the firewall forbids this package from importing db. A test in that package
 * asserts the two agree in both directions, so adding a pg enum value without a
 * scope here fails there.
 */
export const NOTIFICATION_TYPES = [
  // Section 5 escalation. Per PERIOD per USER.
  'nudge',
  'wobble',
  'collapse',
  // Section 6 dormancy ladder. Per MEMBERSHIP.
  'dormant',
  'returned',
  // Lifecycle.
  'member_joined',
  'tower_started',
  'tower_archived',
  'block_completed',
  'host_transferred',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** uuids contain no colon, so a key splits unambiguously and reads in psql. */
const SEPARATOR = ':';

/**
 * The scope per type, and why each is what it is. A wrong scope is a silent
 * double-send or a silent suppression, so the discriminated union makes the
 * wrong one a compile error rather than a judgement call at the call site.
 *
 *   nudge | wobble | collapse   per PERIOD per USER. Each member gets their own
 *                               push about one period, and tower_periods.id is
 *                               the stored, stable referent.
 *   dormant | returned          per MEMBERSHIP. A membership IS the (tower,
 *                               user) pair — memberships_tower_id_user_id_unique
 *                               — so adding userId would let a key claim a user
 *                               the membership does not have. A membership
 *                               deleted and re-created gets a new id, and the
 *                               event firing again for it is correct.
 *   member_joined               per MEMBERSHIP (the joiner) per RECIPIENT. The
 *                               joiner's membership id carries tower AND joiner
 *                               in one stored id.
 *   block_completed             per BLOCK per RECIPIENT. base_blocks rows are
 *                               written once and never updated, so the id is an
 *                               ideal referent.
 *   tower_started | tower_archived
 *                               per TOWER per RECIPIENT. Both are once-per-tower
 *                               and monotone: started_at is written once and
 *                               never cleared, and 'archived' is terminal in
 *                               towerLifecycleEnum.
 *   host_transferred            per PERIOD per RECIPIENT, and this one is the
 *                               exception that needs explaining. Unlike every
 *                               other type it is REPEATABLE with no stored
 *                               occurrence referent: towers.host_id is
 *                               overwritten in place, and there is no
 *                               host_transfers table and no host_since column.
 *                               Keying it on the tower would suppress every
 *                               transfer after the first; embedding the clock
 *                               would not be idempotent at all. The current
 *                               period is the available immutable referent, so
 *                               the key repeats in a later period and dedupes
 *                               within one: two transfers on the same day
 *                               produce one "the host changed today" push.
 *
 * NOT here: tower_paused / tower_resumed. Repeatable like host_transferred, but
 * NOT naturally once-per-period — a host can pause and resume within one day
 * and both are meaningful — so the period trick does not fit and there is
 * nothing else to key them on. They arrive with the ticket that adds the column
 * or event table to key them on.
 */
export type NotificationEvent =
  | { type: 'nudge' | 'wobble' | 'collapse'; periodId: string; userId: string }
  | { type: 'dormant' | 'returned'; membershipId: string }
  | { type: 'member_joined'; membershipId: string; userId: string }
  | { type: 'block_completed'; blockId: string; userId: string }
  | { type: 'tower_started' | 'tower_archived'; towerId: string; userId: string }
  | { type: 'host_transferred'; periodId: string; userId: string };

export class InvalidDedupeKeyInputError extends Error {
  constructor(
    readonly field: string,
    readonly value: string
  ) {
    super(`Invalid dedupe key segment ${field}: ${JSON.stringify(value)}`);
    this.name = 'InvalidDedupeKeyInputError';
  }
}

/**
 * Composition only, not validation. An empty segment or one containing the
 * separator would produce a key that still inserts and still dedupes — against
 * the WRONG set of events, which is the one failure mode nothing downstream can
 * detect. A wrong-but-well-formed uuid is undetectable here and is the foreign
 * key's problem, so there is no uuid regex and no zod: this checks only the two
 * things that would break the GRAMMAR.
 */
function segment(field: string, value: string): string {
  if (value.length === 0 || value.includes(SEPARATOR)) {
    throw new InvalidDedupeKeyInputError(field, value);
  }
  return value;
}

export function buildDedupeKey(event: NotificationEvent): string {
  switch (event.type) {
    case 'nudge':
    case 'wobble':
    case 'collapse':
    case 'host_transferred':
      return [
        event.type,
        segment('periodId', event.periodId),
        segment('userId', event.userId),
      ].join(SEPARATOR);
    case 'dormant':
    case 'returned':
      return [event.type, segment('membershipId', event.membershipId)].join(SEPARATOR);
    case 'member_joined':
      return [
        event.type,
        segment('membershipId', event.membershipId),
        segment('userId', event.userId),
      ].join(SEPARATOR);
    case 'block_completed':
      return [event.type, segment('blockId', event.blockId), segment('userId', event.userId)].join(
        SEPARATOR
      );
    case 'tower_started':
    case 'tower_archived':
      return [event.type, segment('towerId', event.towerId), segment('userId', event.userId)].join(
        SEPARATOR
      );
    default: {
      // Exhaustiveness: a new notification_type cannot compile until someone
      // chooses its scope above. That is the whole guard against a type whose
      // key quietly falls back to something tower-wide.
      const unhandled: never = event;
      throw new Error(`Unhandled notification event: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * The recipient a key names, when it names one.
 *
 * Membership-scoped events (dormant, returned) carry no recipient: the
 * membership already identifies the user. Everything else does, and
 * scheduleNotification cross-checks it against the row's user_id — a key
 * claiming a different recipient than its row would make the next evaluation
 * compute the OTHER user's key and send twice.
 */
export function dedupeEventRecipient(event: NotificationEvent): string | undefined {
  return 'userId' in event ? event.userId : undefined;
}
