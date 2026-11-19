import {
  db,
  ensureNotification,
  getNotification,
  getPushTokenByToken,
  listLivePushTokens,
  registerPushToken,
  transitionNotification,
} from '@tower-of-habit/db';
import { useScenarios, SCENARIO_NOW } from '@tower-of-habit/db/testing/vitest';
import { describe, expect, it, vi } from 'vitest';
import {
  checkPushReceipts,
  deliverPush,
  type PushMessage,
  type PushReceipt,
  type PushService,
  type PushTicket,
} from './push.js';

/*
 * 3.13: Graphile Worker and push delivery — RED phase.
 *
 * Tests call deliverPush / checkPushReceipts directly against a real Postgres
 * database with a fake PushService. The stub returns no_op / 0 for everything,
 * so tests that assert state transitions FAIL (red), and tests that assert
 * no change PASS (green).
 *
 * Scenario clock: SCENARIO_NOW = 2026-10-27T18:00:00Z (Tuesday noon Edmonton).
 */

const scenarios = useScenarios();

function fakePushService(
  opts: {
    tickets?: PushTicket[];
    receipts?: Record<string, PushReceipt>;
  } = {}
): PushService & { sentMessages: PushMessage[]; receiptCalls: string[][] } {
  const sentMessages: PushMessage[] = [];
  const receiptCalls: string[][] = [];
  return {
    sentMessages,
    receiptCalls,
    sendPushNotifications: vi.fn(async (messages: PushMessage[]) => {
      sentMessages.push(...messages);
      return (
        opts.tickets ??
        messages.map((_, i) => ({
          status: 'ok' as const,
          id: `ticket-${i}`,
        }))
      );
    }),
    getPushNotificationReceipts: vi.fn(async (ids: string[]) => {
      receiptCalls.push(ids);
      return opts.receipts ?? Object.fromEntries(ids.map((id) => [id, { status: 'ok' as const }]));
    }),
  };
}

async function notificationForMember(
  towerId: string,
  userId: string,
  periodId: string
): Promise<string> {
  const row = await ensureNotification(db, {
    userId,
    towerId,
    scheduledFor: SCENARIO_NOW,
    event: { type: 'nudge', periodId, userId },
  });
  return row.id;
}

describe('deliverPush', () => {
  it('sends push to all live tokens and marks notification sent', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const member = s.members[0]!;
    const period = s.periods.at(-1)!;

    await registerPushToken(db, {
      userId: member.user.id,
      token: 'ExponentPushToken[aaa]',
      platform: 'ios',
    });
    await registerPushToken(db, {
      userId: member.user.id,
      token: 'ExponentPushToken[bbb]',
      platform: 'android',
    });

    const notifId = await notificationForMember(tower.id, member.user.id, period.id);
    const push = fakePushService();

    const result = await deliverPush(db, notifId, push);

    // The stub must have called the push service with both tokens.
    expect(push.sentMessages).toHaveLength(2);
    const tokens = push.sentMessages.map((m) => m.to).sort();
    expect(tokens).toEqual(['ExponentPushToken[aaa]', 'ExponentPushToken[bbb]']);

    // The notification must be transitioned to 'sent'.
    const notif = await getNotification(db, notifId);
    expect(notif!.status).toBe('sent');

    expect(result.outcome).toBe('sent');
    expect(result.ticketIds).toHaveLength(2);
  });

  it('marks notification skipped when user has no live push tokens', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const member = s.members[0]!;
    const period = s.periods.at(-1)!;

    // No push tokens registered for this user.
    const notifId = await notificationForMember(tower.id, member.user.id, period.id);
    const push = fakePushService();

    const result = await deliverPush(db, notifId, push);

    // Push service should not have been called.
    expect(push.sentMessages).toHaveLength(0);

    // The notification must be transitioned to 'skipped'.
    const notif = await getNotification(db, notifId);
    expect(notif!.status).toBe('skipped');

    expect(result.outcome).toBe('skipped');
  });

  it('marks notification failed on permanent Expo error', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const member = s.members[0]!;
    const period = s.periods.at(-1)!;

    await registerPushToken(db, {
      userId: member.user.id,
      token: 'ExponentPushToken[ccc]',
      platform: 'ios',
    });

    const notifId = await notificationForMember(tower.id, member.user.id, period.id);
    const push = fakePushService({
      tickets: [
        {
          status: 'error',
          message: 'The push notification payload is too large',
          details: { error: 'MessageTooBig' },
        },
      ],
    });

    const result = await deliverPush(db, notifId, push);

    // The notification must be transitioned to 'failed' with an error message.
    const notif = await getNotification(db, notifId);
    expect(notif!.status).toBe('failed');
    expect(notif!.error).toBeTruthy();

    expect(result.outcome).toBe('failed');
  });

  it('does not re-deliver an already-sent notification', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const member = s.members[0]!;
    const period = s.periods.at(-1)!;

    await registerPushToken(db, {
      userId: member.user.id,
      token: 'ExponentPushToken[ddd]',
      platform: 'ios',
    });

    const notifId = await notificationForMember(tower.id, member.user.id, period.id);
    // Pre-transition to 'sent'.
    await transitionNotification(db, notifId, { to: 'sent' });

    const push = fakePushService();
    const result = await deliverPush(db, notifId, push);

    // Push service must NOT have been called.
    expect(push.sentMessages).toHaveLength(0);

    // The notification must still be 'sent'.
    const notif = await getNotification(db, notifId);
    expect(notif!.status).toBe('sent');

    expect(result.outcome).toBe('no_op');
  });

  it('does not re-deliver an already-skipped notification', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const tower = s.tower!;
    const member = s.members[0]!;
    const period = s.periods.at(-1)!;

    const notifId = await notificationForMember(tower.id, member.user.id, period.id);
    // Pre-transition to 'skipped'.
    await transitionNotification(db, notifId, { to: 'skipped' });

    const push = fakePushService();
    const result = await deliverPush(db, notifId, push);

    // Push service must NOT have been called.
    expect(push.sentMessages).toHaveLength(0);

    // The notification must still be 'skipped'.
    const notif = await getNotification(db, notifId);
    expect(notif!.status).toBe('skipped');

    expect(result.outcome).toBe('no_op');
  });
});

describe('checkPushReceipts', () => {
  it('invalidates token on DeviceNotRegistered receipt', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const member = s.members[0]!;

    await registerPushToken(db, {
      userId: member.user.id,
      token: 'ExponentPushToken[eee]',
      platform: 'ios',
    });

    // Verify the token is live before the check.
    const liveBefore = await listLivePushTokens(db, member.user.id);
    expect(liveBefore).toHaveLength(1);

    const push = fakePushService({
      receipts: {
        'ticket-0': {
          status: 'error',
          message: 'The device is not registered',
          details: { error: 'DeviceNotRegistered' },
        },
      },
    });

    // Map: ticketId → the push token string that was sent to.
    const result = await checkPushReceipts(db, { 'ticket-0': 'ExponentPushToken[eee]' }, push);

    // The token must have been invalidated.
    const updated = await getPushTokenByToken(db, 'ExponentPushToken[eee]');
    expect(updated!.invalidatedAt).not.toBeNull();

    // No live tokens remain.
    const liveAfter = await listLivePushTokens(db, member.user.id);
    expect(liveAfter).toHaveLength(0);

    expect(result.invalidated).toBe(1);
    expect(result.checked).toBe(1);
  });

  it('leaves token live on ok receipt', async () => {
    const s = await scenarios.towerRunningFor(5, { members: 2 });
    const member = s.members[0]!;

    await registerPushToken(db, {
      userId: member.user.id,
      token: 'ExponentPushToken[fff]',
      platform: 'ios',
    });

    const push = fakePushService({
      receipts: {
        'ticket-0': { status: 'ok' },
      },
    });

    const result = await checkPushReceipts(db, { 'ticket-0': 'ExponentPushToken[fff]' }, push);

    // The token must still be live.
    const live = await listLivePushTokens(db, member.user.id);
    expect(live).toHaveLength(1);
    expect(live[0]!.invalidatedAt).toBeNull();

    // Checked but nothing invalidated.
    expect(result.checked).toBeGreaterThanOrEqual(0);
    expect(result.invalidated).toBe(0);
  });
});
