import { Expo } from 'expo-server-sdk';
import type { PushMessage, PushReceipt, PushService, PushTicket } from './push.js';

export function createExpoPushService(accessToken?: string): PushService {
  const expo = new Expo(accessToken ? { accessToken } : {});

  return {
    async sendPushNotifications(messages: PushMessage[]): Promise<PushTicket[]> {
      const chunks = expo.chunkPushNotifications(
        messages.map((m) => ({
          to: m.to,
          title: m.title,
          body: m.body,
          ...(m.data ? { data: m.data } : {}),
        }))
      );
      const tickets: PushTicket[] = [];
      for (const chunk of chunks) {
        const result = await expo.sendPushNotificationsAsync(chunk);
        for (const t of result) {
          const ticket: PushTicket = { status: t.status };
          if (t.status === 'ok') ticket.id = t.id;
          if (t.status === 'error') {
            if (t.message) ticket.message = t.message;
            if (t.details?.error) ticket.details = { error: t.details.error as string };
          }
          tickets.push(ticket);
        }
      }
      return tickets;
    },

    async getPushNotificationReceipts(receiptIds: string[]): Promise<Record<string, PushReceipt>> {
      const chunks = expo.chunkPushNotificationReceiptIds(receiptIds);
      const all: Record<string, PushReceipt> = {};
      for (const chunk of chunks) {
        const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
        for (const [id, receipt] of Object.entries(receipts)) {
          const r: PushReceipt = { status: receipt.status };
          if (receipt.status === 'error') {
            if (receipt.message) r.message = receipt.message;
            if (receipt.details?.error) r.details = { error: receipt.details.error as string };
          }
          all[id] = r;
        }
      }
      return all;
    },
  };
}
