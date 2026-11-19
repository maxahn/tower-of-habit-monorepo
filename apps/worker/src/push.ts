import {
  getNotification,
  invalidatePushToken,
  listLivePushTokens,
  transitionNotification,
  type Db,
} from '@tower-of-habit/db';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface PushReceipt {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

export interface PushService {
  sendPushNotifications(messages: PushMessage[]): Promise<PushTicket[]>;
  getPushNotificationReceipts(receiptIds: string[]): Promise<Record<string, PushReceipt>>;
}

export type DeliveryOutcome = 'sent' | 'failed' | 'skipped' | 'no_op';

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  ticketIds: string[];
  receiptMap?: Record<string, string>;
}

export interface ReceiptCheckResult {
  checked: number;
  invalidated: number;
}

const PERMANENT_EXPO_ERRORS = new Set(['MessageTooBig', 'InvalidCredentials']);

export async function deliverPush(
  db: Db,
  notificationId: string,
  pushService: PushService
): Promise<DeliveryResult> {
  const notification = await getNotification(db, notificationId);
  if (!notification || notification.status !== 'pending') {
    return { outcome: 'no_op', ticketIds: [] };
  }

  const tokens = await listLivePushTokens(db, notification.userId);

  if (tokens.length === 0) {
    await transitionNotification(db, notificationId, { to: 'skipped' });
    return { outcome: 'skipped', ticketIds: [] };
  }

  const messages: PushMessage[] = tokens.map((t) => ({
    to: t.token,
    title: 'Tower of Habit',
    body: `You have a ${notification.type} notification`,
  }));

  const tickets = await pushService.sendPushNotifications(messages);

  const permanentError = tickets.find(
    (t) => t.status === 'error' && t.details?.error && PERMANENT_EXPO_ERRORS.has(t.details.error)
  );
  if (permanentError) {
    const errorMsg =
      permanentError.message || permanentError.details?.error || 'Push delivery failed';
    await transitionNotification(db, notificationId, { to: 'failed', error: errorMsg });
    return { outcome: 'failed', ticketIds: [] };
  }

  const transientError = tickets.find(
    (t) =>
      t.status === 'error' && (!t.details?.error || !PERMANENT_EXPO_ERRORS.has(t.details.error))
  );
  if (transientError) {
    throw new Error(
      `Transient push error: ${transientError.message || transientError.details?.error || 'unknown'}`
    );
  }

  const ticketIds: string[] = [];
  const receiptMap: Record<string, string> = {};
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i]!;
    if (ticket.status === 'ok' && ticket.id) {
      ticketIds.push(ticket.id);
      receiptMap[ticket.id] = tokens[i]!.token;
    }
  }

  await transitionNotification(db, notificationId, { to: 'sent' });

  return { outcome: 'sent', ticketIds, receiptMap };
}

export async function checkPushReceipts(
  db: Db,
  receiptMap: Record<string, string>,
  pushService: PushService
): Promise<ReceiptCheckResult> {
  const ticketIds = Object.keys(receiptMap);
  if (ticketIds.length === 0) {
    return { checked: 0, invalidated: 0 };
  }

  const receipts = await pushService.getPushNotificationReceipts(ticketIds);

  let invalidated = 0;
  for (const [ticketId, receipt] of Object.entries(receipts)) {
    if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
      const token = receiptMap[ticketId];
      if (token) {
        await invalidatePushToken(db, token);
        invalidated++;
      }
    }
  }

  return { checked: Object.keys(receipts).length, invalidated };
}
