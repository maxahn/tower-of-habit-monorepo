import { eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDedupeKey, NOTIFICATION_TYPES, type NotificationEvent } from '@tower-of-habit/shared';
import { asPgError } from '../pg-errors.js';
import { db, pgError, useTestOwner } from '../test-utils.js';
import { towers } from '../towers/schema.js';
import { createTower, type NewTower } from '../towers/towers.js';
import { users } from '../users/schema.js';
import { notifications, notificationTypeEnum, type NotificationStatus } from './schema.js';
import {
  ALLOWED_NOTIFICATION_TRANSITIONS,
  assertNotificationTransition,
  deleteNotification,
  DuplicateNotificationError,
  ensureNotification,
  getNotification,
  getNotificationByDedupeKey,
  IllegalNotificationTransitionError,
  listDueNotifications,
  listNotificationsForTower,
  listNotificationsForUser,
  MAX_SEND_ATTEMPTS,
  NotificationNotFoundError,
  NotificationScopeMismatchError,
  pruneNotificationsBefore,
  scheduleNotification,
  transitionNotification,
  type NewNotification,
  type NotificationTransition,
} from './notifications.js';

const owner = useTestOwner();

// host_id is ON DELETE RESTRICT, so towers must go before the owner;
// notifications cascade from towers. Vitest runs afterEach hooks in reverse
// registration order: this one runs first.
afterEach(async () => {
  await db.delete(towers).where(eq(towers.hostId, owner()));
});

const extraUsers: string[] = [];
afterEach(async () => {
  if (extraUsers.length) {
    await db.delete(users).where(inArray(users.id, extraUsers.splice(0)));
  }
});

async function otherUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `${crypto.randomUUID()}@test.local`,
      passwordHash: 'x',
      displayName: 'Other',
    })
    .returning();
  extraUsers.push(u!.id);
  return u!.id;
}

function tower(overrides: Partial<NewTower> = {}) {
  return createTower(db, {
    hostId: owner(),
    name: 'Morning run',
    deadlineTime: '22:00',
    timezone: 'America/Edmonton',
    ...overrides,
  });
}

const at = (iso: string) => new Date(iso);
const SCHEDULED = at('2026-03-07T05:00:00.000Z');

/** A wobble for a fresh period, so keys never collide across tests. */
const wobbleFor = (userId: string): NotificationEvent => ({
  type: 'wobble',
  periodId: crypto.randomUUID(),
  userId,
});

async function input(overrides: Partial<NewNotification> = {}): Promise<NewNotification> {
  const t = overrides.towerId ? undefined : await tower();
  const userId = overrides.userId ?? owner();
  return {
    userId,
    towerId: overrides.towerId ?? t!.id,
    scheduledFor: overrides.scheduledFor ?? SCHEDULED,
    event: overrides.event ?? wobbleFor(userId),
  };
}

/** Bypasses the service, for dispatcher-owned columns and constraint probes. */
async function rawNotification(
  values: Partial<typeof notifications.$inferInsert> & { towerId?: string } = {}
) {
  const towerId = values.towerId ?? (await tower()).id;
  return db
    .insert(notifications)
    .values({
      userId: owner(),
      towerId,
      type: 'wobble',
      dedupeKey: buildDedupeKey(wobbleFor(owner())),
      scheduledFor: SCHEDULED,
      ...values,
    })
    .returning();
}

const transitionTo = (to: NotificationStatus): NotificationTransition =>
  to === 'failed' ? { to, error: 'provider said no' } : ({ to } as NotificationTransition);

/** A notification parked in `status`, driven there through the service. */
async function inState(status: NotificationStatus) {
  const row = await scheduleNotification(db, await input());
  if (status === 'pending') return row;
  if (status === 'sent' || status === 'skipped' || status === 'failed') {
    return transitionNotification(db, row.id, transitionTo(status));
  }
  return row;
}

describe('notifications defaults and CRUD', () => {
  it('inserts with spec defaults', async () => {
    const row = await scheduleNotification(db, await input());
    expect(row).toMatchObject({ status: 'pending', attempts: 0 });
    expect(row.sentAt).toBeNull();
    expect(row.error).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('derives type and dedupe_key from the event', async () => {
    const event: NotificationEvent = {
      type: 'collapse',
      periodId: crypto.randomUUID(),
      userId: owner(),
    };
    const row = await scheduleNotification(db, await input({ event }));
    expect(row.type).toBe('collapse');
    expect(row.dedupeKey).toBe(buildDedupeKey(event));
  });

  it('gets by id and by dedupe key', async () => {
    const row = await scheduleNotification(db, await input());
    expect((await getNotification(db, row.id))?.id).toBe(row.id);
    expect((await getNotificationByDedupeKey(db, row.dedupeKey))?.id).toBe(row.id);
    expect(await getNotification(db, crypto.randomUUID())).toBeUndefined();
  });

  it('lists for a user and for a tower', async () => {
    const t = await tower();
    const a = await scheduleNotification(db, await input({ towerId: t.id }));
    const b = await scheduleNotification(db, await input({ towerId: t.id }));
    expect((await listNotificationsForTower(db, t.id)).map((n) => n.id).sort()).toEqual(
      [a.id, b.id].sort()
    );
    expect((await listNotificationsForUser(db, owner())).length).toBeGreaterThanOrEqual(2);
  });

  it('deletes', async () => {
    const row = await scheduleNotification(db, await input());
    await deleteNotification(db, row.id);
    expect(await getNotification(db, row.id)).toBeUndefined();
  });

  it('cascades from the tower', async () => {
    const t = await tower();
    const row = await scheduleNotification(db, await input({ towerId: t.id }));
    await db.delete(towers).where(eq(towers.id, t.id));
    expect(await getNotification(db, row.id)).toBeUndefined();
  });

  it('cascades from the user', async () => {
    const uid = await otherUser();
    const t = await tower();
    const row = await scheduleNotification(
      db,
      await input({ towerId: t.id, userId: uid, event: wobbleFor(uid) })
    );
    await db.delete(users).where(eq(users.id, uid));
    extraUsers.splice(extraUsers.indexOf(uid), 1);
    expect(await getNotification(db, row.id)).toBeUndefined();
  });
});

describe('notifications_dedupe_key_unique', () => {
  it('rejects a second row with the same dedupe key', async () => {
    const key = buildDedupeKey(wobbleFor(owner()));
    await rawNotification({ dedupeKey: key });
    const e = await pgError(rawNotification({ dedupeKey: key }));
    expect(e).toMatchObject({
      code: '23505',
      constraint_name: 'notifications_dedupe_key_unique',
    });
  });

  // The key is GLOBAL, not scoped to a user or tower. That is exactly why every
  // per-user scope has to carry the user inside the key.
  it('rejects a duplicate key even for a different user and tower', async () => {
    const key = buildDedupeKey(wobbleFor(owner()));
    await rawNotification({ dedupeKey: key });
    const uid = await otherUser();
    const other = await tower();
    const e = await pgError(rawNotification({ dedupeKey: key, userId: uid, towerId: other.id }));
    expect(e).toMatchObject({
      code: '23505',
      constraint_name: 'notifications_dedupe_key_unique',
    });
  });

  it('scheduleNotification raises DuplicateNotificationError carrying the existing id', async () => {
    const i = await input();
    const first = await scheduleNotification(db, i);
    try {
      await scheduleNotification(db, i);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateNotificationError);
      expect(e).toMatchObject({ dedupeKey: first.dedupeKey, existingId: first.id });
    }
  });

  it('ensureNotification returns the existing row instead of raising', async () => {
    const i = await input();
    const first = await ensureNotification(db, i);
    const again = await ensureNotification(db, i);
    expect(again.id).toBe(first.id);
  });

  // THE ticket's acceptance test: a re-run of the evaluator must not produce a
  // second push for an event that already went out.
  it('does not re-arm a notification that was already sent', async () => {
    const i = await input();
    const first = await ensureNotification(db, i);
    const sent = await transitionNotification(db, first.id, { to: 'sent' });

    const again = await ensureNotification(db, i);

    expect(again.id).toBe(first.id);
    expect(again.status).toBe('sent');
    expect(again.sentAt!.getTime()).toBe(sent.sentAt!.getTime());
    expect(again.attempts).toBe(sent.attempts);
  });

  it("keeps the winner's scheduled_for", async () => {
    const i = await input();
    const first = await ensureNotification(db, i);
    const again = await ensureNotification(db, {
      ...i,
      scheduledFor: at('2030-01-01T00:00:00.000Z'),
    });
    expect(again.scheduledFor.getTime()).toBe(first.scheduledFor.getTime());
  });

  it('lets concurrent ensureNotification calls converge on one row', async () => {
    const i = await input();
    const rows = await Promise.all(Array.from({ length: 5 }, () => ensureNotification(db, i)));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(await listNotificationsForTower(db, i.towerId)).toHaveLength(1);
  });

  // DO NOTHING would return zero rows at once here and the loser would see
  // nothing for a row that is about to exist.
  it('a loser blocked on an uncommitted dedupe key gets the winner row', async () => {
    const i = await input();
    const key = buildDedupeKey(i.event);
    const a = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      let release: () => void = () => {};
      let inserted: () => void = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      const aInserted = new Promise<void>((r) => {
        inserted = r;
      });

      const txA = a.begin(async (tx) => {
        await tx`insert into notifications (user_id, tower_id, type, dedupe_key, scheduled_for)
                 values (${i.userId}, ${i.towerId}, 'wobble', ${key}, ${i.scheduledFor})`;
        inserted();
        await held;
      });
      await aInserted;

      const loser = ensureNotification(db, i);
      release();
      await txA;

      const row = await loser;
      expect(row.dedupeKey).toBe(key);
      expect(await listNotificationsForTower(db, i.towerId)).toHaveLength(1);
    } finally {
      await a.end();
    }
  });

  // These two together are why BOTH writers ship. Inside a transaction a 23505
  // aborts the whole transaction, so an exception-based dedupe would kill the
  // evaluator's write in the EXPECTED case, on every re-run.
  it('ensureNotification leaves the surrounding transaction usable', async () => {
    const i = await input();
    const first = await ensureNotification(db, i);
    const out = await db.transaction(async (tx) => {
      const again = await ensureNotification(tx, i);
      // A statement AFTER the conflict: this is what would fail with 25P02 if
      // the conflict had aborted the transaction.
      await tx.execute(sql`select 1`);
      return again;
    });
    expect(out.id).toBe(first.id);
  });

  it('a duplicate through scheduleNotification poisons the surrounding transaction', async () => {
    const i = await input();
    await scheduleNotification(db, i);

    let followUp: ReturnType<typeof asPgError> | undefined;
    await expect(
      db.transaction(async (tx) => {
        try {
          await scheduleNotification(tx, i);
        } catch {
          // Swallowed on purpose: the point is that catching it does not save
          // the transaction.
        }
        try {
          await tx.execute(sql`select 1`);
        } catch (e) {
          followUp = asPgError(e);
          throw e;
        }
      })
    ).rejects.toThrow();
    expect(followUp).toMatchObject({ code: '25P02' });
  });

  it('allows the same type for a different period', async () => {
    const t = await tower();
    const a = await scheduleNotification(db, await input({ towerId: t.id }));
    const b = await scheduleNotification(db, await input({ towerId: t.id }));
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });
});

describe('notifications constraints', () => {
  it.each([
    [
      'sent without a sent_at',
      { status: 'sent' as const, attempts: 1 },
      'notifications_sent_at_iff_sent',
    ],
    ['a sent_at while pending', { sentAt: SCHEDULED }, 'notifications_sent_at_iff_sent'],
    [
      'failed carrying a sent_at',
      { status: 'failed' as const, error: 'boom', sentAt: SCHEDULED, attempts: 1 },
      'notifications_sent_at_iff_sent',
    ],
    [
      'failed without an error',
      { status: 'failed' as const, attempts: 1 },
      'notifications_error_iff_failed',
    ],
    ['an error while pending', { error: 'boom' }, 'notifications_error_iff_failed'],
    // The hole a single combined iff would leave open: `true = true` accepts a
    // sent row carrying an error and no sent_at.
    [
      'sent carrying an error',
      { status: 'sent' as const, sentAt: SCHEDULED, error: 'boom', attempts: 1 },
      'notifications_error_iff_failed',
    ],
    [
      'skipped carrying an error',
      { status: 'skipped' as const, error: 'boom' },
      'notifications_error_iff_failed',
    ],
    [
      'an empty error on a failed row',
      { status: 'failed' as const, error: '', attempts: 1 },
      'notifications_error_length',
    ],
    [
      'an over-length error',
      { status: 'failed' as const, error: 'x'.repeat(2001), attempts: 1 },
      'notifications_error_length',
    ],
    ['an empty dedupe key', { dedupeKey: '' }, 'notifications_dedupe_key_length'],
    [
      'an over-length dedupe key',
      { dedupeKey: 'x'.repeat(201) },
      'notifications_dedupe_key_length',
    ],
    ['negative attempts', { attempts: -1 }, 'notifications_attempts_nonnegative'],
    [
      'a sent row with no recorded attempt',
      { status: 'sent' as const, sentAt: SCHEDULED, attempts: 0 },
      'notifications_attempts_recorded_when_attempted',
    ],
  ] as ReadonlyArray<readonly [string, Partial<typeof notifications.$inferInsert>, string]>)(
    'rejects %s',
    async (_label, values, constraint) => {
      const e = await pgError(rawNotification(values));
      expect(e).toMatchObject({ code: '23514', constraint_name: constraint });
    }
  );

  it.each([
    ['a sent row', { status: 'sent' as const, sentAt: SCHEDULED, attempts: 1 }],
    ['a skipped row with no error', { status: 'skipped' as const }],
    ['a failed row with an error', { status: 'failed' as const, error: 'boom', attempts: 1 }],
    // A re-queue keeps its attempt count; the constraint is one-directional.
    ['a re-queued row carrying attempts', { status: 'pending' as const, attempts: 2 }],
    [
      'an error at exactly the limit',
      { status: 'failed' as const, error: 'x'.repeat(2000), attempts: 1 },
    ],
  ] as ReadonlyArray<readonly [string, Partial<typeof notifications.$inferInsert>]>)(
    'accepts %s',
    async (_label, values) => {
      await expect(rawNotification(values)).resolves.toHaveLength(1);
    }
  );

  // Pins the NOT NULL decision.
  it('rejects a null tower_id', async () => {
    const e = await pgError(
      db.execute(
        sql`insert into notifications (user_id, tower_id, type, dedupe_key, scheduled_for)
            values (${owner()}, null, 'wobble', ${crypto.randomUUID()}, now())`
      )
    );
    expect(e).toMatchObject({ code: '23502' });
  });

  it('rejects a missing tower', async () => {
    const e = await pgError(rawNotification({ towerId: crypto.randomUUID() }));
    expect(e).toMatchObject({
      code: '23503',
      constraint_name: 'notifications_tower_id_towers_id_fk',
    });
  });

  it('rejects a missing user', async () => {
    const e = await pgError(rawNotification({ userId: crypto.randomUUID() }));
    expect(e).toMatchObject({
      code: '23503',
      constraint_name: 'notifications_user_id_users_id_fk',
    });
  });

  it.each([
    ['type', `insert into notifications (user_id, tower_id, type, dedupe_key, scheduled_for)`],
    [
      'status',
      `insert into notifications (user_id, tower_id, type, dedupe_key, scheduled_for, status)`,
    ],
  ])('rejects an unknown %s', async (column) => {
    const t = await tower();
    const stmt =
      column === 'type'
        ? sql`insert into notifications (user_id, tower_id, type, dedupe_key, scheduled_for)
              values (${owner()}, ${t.id}, 'tower_paused', ${crypto.randomUUID()}, now())`
        : sql`insert into notifications (user_id, tower_id, type, dedupe_key, scheduled_for, status)
              values (${owner()}, ${t.id}, 'wobble', ${crypto.randomUUID()}, now(), 'sending')`;
    const e = await pgError(db.execute(stmt));
    expect(e).toMatchObject({ code: '22P02' });
  });

  /**
   * The base_blocks / caused_collapse pattern. period_id must not arrive by
   * accident: the dedupe key's persistence is the idempotency guarantee, and an
   * FK to a prunable table would subordinate it to that table's lifecycle.
   */
  it('has exactly the specified columns, and no period_id', async () => {
    const rows = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'notifications'`
    );
    expect([...rows].map((r) => r.column_name).sort()).toEqual([
      'attempts',
      'created_at',
      'dedupe_key',
      'error',
      'id',
      'scheduled_for',
      'sent_at',
      'status',
      'tower_id',
      'type',
      'user_id',
    ]);
  });
});

describe('notification status transitions', () => {
  const STATES = ['pending', 'sent', 'failed', 'skipped'] as const;
  const cases = STATES.flatMap((from) =>
    STATES.map((to) => ({
      from,
      to,
      legal: (ALLOWED_NOTIFICATION_TRANSITIONS[from] as readonly string[]).includes(to),
    }))
  );

  it.each(cases.filter((c) => c.legal))('allows $from -> $to', async ({ from, to }) => {
    const row = await inState(from);
    const moved = await transitionNotification(db, row.id, transitionTo(to));
    expect(moved.status).toBe(to);
    expect(() => assertNotificationTransition(from, to)).not.toThrow();
  });

  it.each(cases.filter((c) => !c.legal))('rejects $from -> $to', async ({ from, to }) => {
    const row = await inState(from);
    await expect(transitionNotification(db, row.id, transitionTo(to))).rejects.toThrow(
      IllegalNotificationTransitionError
    );
    expect(() => assertNotificationTransition(from, to)).toThrow(
      IllegalNotificationTransitionError
    );
    // The row is untouched by a rejected transition.
    expect((await getNotification(db, row.id))?.status).toBe(from);
  });

  it('sets sent_at on sent', async () => {
    const row = await inState('pending');
    const sent = await transitionNotification(db, row.id, { to: 'sent' });
    expect(sent.sentAt).toBeInstanceOf(Date);
    expect(sent.error).toBeNull();
  });

  it('stores the error on failed', async () => {
    const row = await inState('pending');
    const failed = await transitionNotification(db, row.id, { to: 'failed', error: 'APNs 500' });
    expect(failed.error).toBe('APNs 500');
    expect(failed.sentAt).toBeNull();
  });

  it('clears sent_at and error on a re-queue', async () => {
    const failed = await inState('failed');
    const requeued = await transitionNotification(db, failed.id, { to: 'pending' });
    expect(requeued.error).toBeNull();
    expect(requeued.sentAt).toBeNull();
  });

  it('counts an attempt on sent and on failed, but not on a re-queue or a skip', async () => {
    const failed = await inState('failed');
    expect(failed.attempts).toBe(1);
    const requeued = await transitionNotification(db, failed.id, { to: 'pending' });
    expect(requeued.attempts).toBe(1);
    const sent = await transitionNotification(db, requeued.id, { to: 'sent' });
    expect(sent.attempts).toBe(2);

    const skipped = await inState('skipped');
    expect(skipped.attempts).toBe(0);
  });

  it('a concurrent transition loses cleanly rather than overwriting', async () => {
    const row = await inState('pending');
    const results = await Promise.allSettled([
      transitionNotification(db, row.id, { to: 'sent' }),
      transitionNotification(db, row.id, { to: 'skipped' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('throws for a missing notification', async () => {
    await expect(transitionNotification(db, crypto.randomUUID(), { to: 'sent' })).rejects.toThrow(
      NotificationNotFoundError
    );
  });

  it('requires an error to fail at the type level', async () => {
    // @ts-expect-error notifications_error_iff_failed makes an error mandatory
    const t: NotificationTransition = { to: 'failed' };
    expect(t).toBeDefined();
  });
});

describe('listDueNotifications', () => {
  it('returns pending rows at or before now, oldest first', async () => {
    const t = await tower();
    const early = await rawNotification({
      towerId: t.id,
      scheduledFor: at('2026-03-01T00:00:00.000Z'),
    });
    const late = await rawNotification({
      towerId: t.id,
      scheduledFor: at('2026-03-02T00:00:00.000Z'),
    });
    const due = await listDueNotifications(db, at('2026-03-03T00:00:00.000Z'));
    const ids = due.filter((n) => n.towerId === t.id).map((n) => n.id);
    expect(ids).toEqual([early[0]!.id, late[0]!.id]);
  });

  it('excludes a future scheduled_for', async () => {
    const t = await tower();
    await rawNotification({ towerId: t.id, scheduledFor: at('2026-03-10T00:00:00.000Z') });
    const due = await listDueNotifications(db, at('2026-03-03T00:00:00.000Z'));
    expect(due.filter((n) => n.towerId === t.id)).toEqual([]);
  });

  it.each(['sent', 'failed', 'skipped'] as const)('excludes a %s row', async (status) => {
    const t = await tower();
    await rawNotification({
      towerId: t.id,
      scheduledFor: at('2026-03-01T00:00:00.000Z'),
      status,
      attempts: status === 'skipped' ? 0 : 1,
      ...(status === 'sent' ? { sentAt: SCHEDULED } : {}),
      ...(status === 'failed' ? { error: 'boom' } : {}),
    });
    const due = await listDueNotifications(db, at('2026-03-03T00:00:00.000Z'));
    expect(due.filter((n) => n.towerId === t.id)).toEqual([]);
  });

  it('includes a re-queued row immediately', async () => {
    const t = await tower();
    const [row] = await rawNotification({
      towerId: t.id,
      scheduledFor: at('2026-03-01T00:00:00.000Z'),
      status: 'failed',
      error: 'boom',
      attempts: 1,
    });
    await transitionNotification(db, row!.id, { to: 'pending' });
    const due = await listDueNotifications(db, at('2026-03-03T00:00:00.000Z'));
    expect(due.map((n) => n.id)).toContain(row!.id);
  });

  // A poison notification stops being retried, and then needs an operator alert.
  it('excludes a row at the attempt ceiling', async () => {
    const t = await tower();
    await rawNotification({
      towerId: t.id,
      scheduledFor: at('2026-03-01T00:00:00.000Z'),
      attempts: MAX_SEND_ATTEMPTS,
    });
    const due = await listDueNotifications(db, at('2026-03-03T00:00:00.000Z'));
    expect(due.filter((n) => n.towerId === t.id)).toEqual([]);
  });

  it('honours the limit', async () => {
    const t = await tower();
    for (const d of ['2026-03-01', '2026-03-02', '2026-03-03']) {
      await rawNotification({ towerId: t.id, scheduledFor: at(`${d}T00:00:00.000Z`) });
    }
    expect(await listDueNotifications(db, at('2026-03-05T00:00:00.000Z'), 2)).toHaveLength(2);
  });

  it('serves the due read from notifications_due', async () => {
    const plan = await db.transaction(async (tx) => {
      // A small table is seq-scanned whatever the index says.
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute(sql`explain select id from notifications
        where status = 'pending' and scheduled_for <= now() and attempts < 5
        order by scheduled_for limit 100`);
    });
    expect(JSON.stringify(plan)).toContain('notifications_due');
  });
});

describe('dedupe keys and the notification_type enum', () => {
  // The ROSTER_DISPLAY_NAME_MAX precedent: the duplicated list in
  // @tower-of-habit/shared and the pg enum must agree, in both directions.
  it('agrees with NOTIFICATION_TYPES in @tower-of-habit/shared', () => {
    expect([...notificationTypeEnum.enumValues].sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it('gives every notification_type a dedupe scope', () => {
    for (const type of notificationTypeEnum.enumValues) {
      expect(NOTIFICATION_TYPES).toContain(type);
    }
  });

  it('accepts the longest constructible key', async () => {
    const event: NotificationEvent = {
      type: 'host_transferred',
      periodId: crypto.randomUUID(),
      userId: owner(),
    };
    const key = buildDedupeKey(event);
    expect(key.length).toBeLessThanOrEqual(200);
    await expect(
      rawNotification({ type: 'host_transferred', dedupeKey: key })
    ).resolves.toHaveLength(1);
  });

  it('blocks only that period and user with a wobble key', async () => {
    const periodId = crypto.randomUUID();
    const uid = await otherUser();
    const t = await tower();
    await scheduleNotification(
      db,
      await input({ towerId: t.id, event: { type: 'wobble', periodId, userId: owner() } })
    );
    // Same period, a different member: a separate push.
    await expect(
      scheduleNotification(
        db,
        await input({
          towerId: t.id,
          userId: uid,
          event: { type: 'wobble', periodId, userId: uid },
        })
      )
    ).resolves.toBeDefined();
    // Same period, same member: absorbed.
    await expect(
      scheduleNotification(
        db,
        await input({ towerId: t.id, event: { type: 'wobble', periodId, userId: owner() } })
      )
    ).rejects.toThrow(DuplicateNotificationError);
  });
});

describe('scheduleNotification input guards', () => {
  it('never accepts a caller-supplied dedupe_key or type', async () => {
    const i = await input();
    const row = await scheduleNotification(db, {
      ...i,
      type: 'collapse',
      dedupeKey: 'smuggled',
      status: 'sent',
      attempts: 99,
    } as never);
    expect(row.dedupeKey).toBe(buildDedupeKey(i.event));
    expect(row.type).toBe('wobble');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });

  // A key naming a different recipient than its row would make the next
  // evaluation compute the OTHER user's key and send twice.
  it('rejects an event whose userId disagrees with the row', async () => {
    const uid = await otherUser();
    const t = await tower();
    await expect(
      scheduleNotification(db, {
        userId: owner(),
        towerId: t.id,
        scheduledFor: SCHEDULED,
        event: wobbleFor(uid),
      })
    ).rejects.toThrow(NotificationScopeMismatchError);
  });

  it('allows a membership-scoped event, which names no recipient', async () => {
    const t = await tower();
    await expect(
      scheduleNotification(db, {
        userId: owner(),
        towerId: t.id,
        scheduledFor: SCHEDULED,
        event: { type: 'dormant', membershipId: crypto.randomUUID() },
      })
    ).resolves.toMatchObject({ type: 'dormant' });
  });
});

describe('retention', () => {
  it('deletes only rows created before the cutoff', async () => {
    const t = await tower();
    const [old] = await rawNotification({
      towerId: t.id,
      createdAt: at('2026-01-01T00:00:00.000Z'),
    });
    const [recent] = await rawNotification({
      towerId: t.id,
      createdAt: at('2026-05-01T00:00:00.000Z'),
    });
    expect(
      await pruneNotificationsBefore(db, at('2026-03-01T00:00:00.000Z'))
    ).toBeGreaterThanOrEqual(1);
    expect(await getNotification(db, old!.id)).toBeUndefined();
    expect(await getNotification(db, recent!.id)).toBeDefined();
  });

  /**
   * The uncomfortable one, and the reason MIN_DEDUPE_RETENTION_DAYS is a FLOOR
   * rather than a preference: pruning a row deletes its dedupe key, and the
   * event becomes sendable again.
   */
  it('re-arms the event when its key is pruned', async () => {
    const i = await input();
    const sent = await ensureNotification(db, i);
    await transitionNotification(db, sent.id, { to: 'sent' });

    await deleteNotification(db, sent.id);

    const again = await ensureNotification(db, i);
    expect(again.id).not.toBe(sent.id);
    expect(again.status).toBe('pending');
  });
});
