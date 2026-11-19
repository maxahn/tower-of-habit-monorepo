import type { Db } from '@tower-of-habit/db';

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
}

export interface ReceiptCheckResult {
  checked: number;
  invalidated: number;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function deliverPush(
  db: Db,
  notificationId: string,
  pushService: PushService
): Promise<DeliveryResult> {
  return { outcome: 'no_op', ticketIds: [] };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function checkPushReceipts(
  db: Db,
  receiptMap: Record<string, string>,
  pushService: PushService
): Promise<ReceiptCheckResult> {
  return { checked: 0, invalidated: 0 };
}
