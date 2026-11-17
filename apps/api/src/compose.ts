import type { db as appDb } from '@tower-of-habit/db';
import type { Hono } from 'hono';
import { createApp, type AppEnv } from './app.js';
import { mountAuthedAuthRoutes, mountPublicAuthRoutes } from './auth/routes.js';
import type { LoginCodeSender } from './auth/sender.js';
import { createAuthService } from './auth/service.js';
import { createSessionMiddleware } from './auth/session-middleware.js';
import type { ClockOptions } from './context.js';
import type { ReadinessChecks } from './health.js';
import type { Logger } from './logger.js';
import { mountMeRoutes } from './me/routes.js';
import type { ClientIpResolver } from './rate-limit/client-ip.js';
import type { RateLimiter } from './rate-limit/limiter.js';

const SECONDS_PER_DAY = 24 * 60 * 60;
export const CODE_TTL_SECONDS = 10 * 60; // 10 minutes
export const SESSION_TTL_SECONDS = 90 * SECONDS_PER_DAY; // 90 days

/**
 * Everything the app needs from the outside world. index.ts fills this with
 * the real Postgres pool, Redis limiter and log sender; the integration
 * harness (2.20) fills it with the same pool, an in-memory limiter and an
 * in-memory code sink. Both run THIS wiring, so the integration suite
 * exercises the production route table, not a parallel one.
 */
export type ComposeDeps = {
  db: typeof appDb;
  logger: Logger;
  sender: LoginCodeSender;
  limiter: RateLimiter;
  clientIp: ClientIpResolver;
  readiness: ReadinessChecks;
  isDraining: () => boolean;
  corsOrigins: readonly string[];
  bodyLimitBytes: number;
  clock: ClockOptions;
};

export function composeApp(deps: ComposeDeps): Hono<AppEnv> {
  const authService = createAuthService({
    db: deps.db,
    sender: deps.sender,
    codeTtlSeconds: CODE_TTL_SECONDS,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
  });
  const rateLimit = { limiter: deps.limiter, logger: deps.logger, clientIp: deps.clientIp };

  return createApp({
    logger: deps.logger,
    auth: createSessionMiddleware(authService),
    readiness: deps.readiness,
    isDraining: deps.isDraining,
    corsOrigins: deps.corsOrigins,
    bodyLimitBytes: deps.bodyLimitBytes,
    clock: deps.clock,
    mountPublicRoutes: (api) => mountPublicAuthRoutes(api, { authService, rateLimit }),
    mountRoutes: (api) => {
      mountAuthedAuthRoutes(api, { authService });
      mountMeRoutes(api, { db: deps.db });
    },
  });
}
