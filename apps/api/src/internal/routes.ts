import { createHash, timingSafeEqual } from 'node:crypto';
import type { EvaluationResponse } from '@tower-of-habit/shared';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { ctxOf } from '../context.js';
import { DomainError } from '../errors.js';

/**
 * 2.19: the internal router. Mounted on the PUBLIC /v1 router (it bypasses
 * session auth) and guarded by its own bearer token, INTERNAL_API_TOKEN.
 * Refuses to mount without one, so a deployment that forgot the variable
 * serves 404 here rather than an open evaluation trigger.
 *
 *   POST /internal/towers/:towerId/periods/:periodId/evaluate
 */

export type InternalRouteDeps = {
  token: string | undefined;
  evaluate: (towerId: string, periodId: string, now: Date) => Promise<EvaluationResponse | object>;
};

const params = z.strictObject({ towerId: z.uuid(), periodId: z.uuid() });

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time equality on the digests, so length never leaks either. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

export function mountInternalRoutes(api: Hono<AppEnv>, deps: InternalRouteDeps): void {
  const token = deps.token?.trim();
  if (!token) {
    throw new Error('INTERNAL_API_TOKEN must be set to mount the internal routes');
  }

  api.use('/internal/*', async (c, next) => {
    const header = c.req.header('authorization');
    const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!tokenMatches(presented, token)) {
      throw new DomainError(401, 'unauthenticated', 'Missing or invalid internal token');
    }
    await next();
  });

  api.post('/internal/towers/:towerId/periods/:periodId/evaluate', async (c) => {
    const { towerId, periodId } = params.parse(c.req.param());
    return c.json(await deps.evaluate(towerId, periodId, ctxOf(c).now));
  });
}
