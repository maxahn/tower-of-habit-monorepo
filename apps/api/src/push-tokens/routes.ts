import { registerPushToken, type Db } from '@tower-of-habit/db';
import { registerPushTokenRequestSchema } from '@tower-of-habit/shared';
import type { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { withTx, type TxRunner } from '../context.js';
import { jsonBody } from '../validation.js';

export type PushTokenRouteDeps = { db: TxRunner };

export function mountPushTokenRoutes(api: Hono<AppEnv>, deps: PushTokenRouteDeps): void {
  api.post('/push-tokens', jsonBody(registerPushTokenRequestSchema), (c) =>
    withTx(deps.db, c, async (tx: Db, ctx) => {
      const { token, platform } = c.req.valid('json');
      await registerPushToken(tx, { userId: ctx.userId, token, platform });
      return c.body(null, 204);
    })
  );
}
