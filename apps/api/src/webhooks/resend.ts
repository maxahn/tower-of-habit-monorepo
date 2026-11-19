import { markEmailUndeliverable, type Db } from '@tower-of-habit/db';
import type { Hono } from 'hono';
import { Webhook } from 'svix';
import type { AppEnv } from '../app.js';
import type { Logger } from '../logger.js';

type ResendEvent = {
  type: string;
  data: { to: string[] };
};

export type ResendWebhookDeps = {
  db: Db;
  webhookSecret: string;
  logger: Logger;
};

export function mountResendWebhook(api: Hono<AppEnv>, deps: ResendWebhookDeps): void {
  const wh = new Webhook(deps.webhookSecret);

  api.post('/webhooks/resend', async (c) => {
    const body = await c.req.text();
    const headers = {
      'svix-id': c.req.header('svix-id') ?? '',
      'svix-timestamp': c.req.header('svix-timestamp') ?? '',
      'svix-signature': c.req.header('svix-signature') ?? '',
    };

    let event: ResendEvent;
    try {
      event = wh.verify(body, headers) as unknown as ResendEvent;
    } catch {
      return c.json(
        { error: { code: 'invalid_signature', message: 'Invalid webhook signature' } },
        401
      );
    }

    if (event.type === 'email.bounced' || event.type === 'email.complained') {
      const reason = event.type === 'email.bounced' ? 'bounce' : 'complaint';
      for (const email of event.data.to) {
        await markEmailUndeliverable(deps.db, email, reason);
        deps.logger.info({ email, reason }, 'email marked undeliverable');
      }
    }

    return c.body(null, 200);
  });
}
