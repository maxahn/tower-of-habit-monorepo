import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.js';
import { enforceRateLimits, type RateLimitDeps } from './enforce.js';
import type { RateRule } from './limiter.js';

/**
 * 2.18: a global per-user ceiling on write endpoints. Well above anything a
 * person does by hand (600 writes an hour is ten a minute, sustained), so it
 * is a backstop against a runaway client, not a product constraint. Fails
 * open, and never counts reads.
 */
export const WRITE_CEILING_PER_USER: RateRule = {
  name: 'write:user',
  limit: 600,
  windowSeconds: 60 * 60,
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Mounted on the authenticated router, after auth, so the user id is known. */
export function writeCeiling(
  deps: RateLimitDeps,
  userIdOf: (c: Context<AppEnv>) => string | null
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (WRITE_METHODS.has(c.req.method)) {
      await enforceRateLimits(deps, [{ rule: WRITE_CEILING_PER_USER, id: userIdOf(c) }]);
    }
    await next();
  };
}
