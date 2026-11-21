import {
  countActiveTowersForUser,
  getUser,
  listLiveSessionsForUser,
  updateUser,
  type Db,
  type User,
} from '@tower-of-habit/db';
import {
  updateMeRequestSchema,
  type MeResponse,
  type MeSessionsResponse,
} from '@tower-of-habit/shared';
import type { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { withTx, type TxRunner } from '../context.js';
import { DomainError } from '../errors.js';
import { jsonBody } from '../validation.js';

/**
 * 2.11: the profile.
 *   GET   /me           → { user, activeTowerCount }
 *   PATCH /me           → same shape, after updating displayName / timezone
 *   GET   /me/sessions  → { sessions: [...] }, the current one marked
 *
 * Email is not patchable (the schema rejects it): it is the login credential
 * and needs a verify-new-address flow, which needs email delivery (Phase 3).
 * Changing timezone never rewrites entries.local_date: that is history.
 */

export type MeRouteDeps = { db: TxRunner };

/** The user as the API returns it. Dates serialise to ISO via c.json. */
export function toSessionUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    timezone: user.timezone,
    displayName: user.displayName,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function meBody(tx: Db, userId: string): Promise<MeResponse> {
  const user = await getUser(tx, userId);
  // The session resolved, so the user exists unless deleted mid-request.
  if (!user) throw new DomainError(401, 'unauthenticated', 'Missing or invalid session');
  const activeTowerCount = await countActiveTowersForUser(tx, userId);
  return {
    user: toSessionUser(user) as unknown as MeResponse['user'],
    activeTowerCount,
  };
}

export function mountMeRoutes(api: Hono<AppEnv>, deps: MeRouteDeps): void {
  api.get('/me', (c) =>
    withTx(deps.db, c, async (tx, ctx) => c.json(await meBody(tx, ctx.userId)))
  );

  api.patch('/me', jsonBody(updateMeRequestSchema), (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const patch = c.req.valid('json');
      // exactOptionalPropertyTypes: only forward the keys that were sent.
      await updateUser(tx, ctx.userId, {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      });
      return c.json(await meBody(tx, ctx.userId));
    })
  );

  api.get('/me/sessions', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const current = c.get('sessionId');
      const rows = await listLiveSessionsForUser(tx, ctx.userId);
      const body: MeSessionsResponse = {
        sessions: rows.map((s) => ({
          id: s.id,
          createdAt: s.createdAt as unknown as string,
          lastSeenAt: s.lastSeenAt as unknown as string,
          expiresAt: s.expiresAt as unknown as string,
          userAgent: s.userAgent,
          current: s.id === current,
        })),
      };
      return c.json(body);
    })
  );
}
