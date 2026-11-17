import type { db as appDb } from '@tower-of-habit/db';
import type { Hono } from 'hono';
import { createApp, type AppEnv } from './app.js';
import { mountAuthedAuthRoutes, mountPublicAuthRoutes } from './auth/routes.js';
import type { LoginCodeSender } from './auth/sender.js';
import { createAuthService } from './auth/service.js';
import { createSessionMiddleware } from './auth/session-middleware.js';
import type { ClockOptions } from './context.js';
import { mountEntryRoutes } from './entries/routes.js';
import { createEvaluator } from './evaluation/service.js';
import { mountInternalRoutes } from './internal/routes.js';
import { mountHabitRoutes } from './habits/routes.js';
import type { ReadinessChecks } from './health.js';
import type { Logger } from './logger.js';
import { mountMeRoutes } from './me/routes.js';
import type { ClientIpResolver } from './rate-limit/client-ip.js';
import type { RateLimiter } from './rate-limit/limiter.js';
import { writeCeiling } from './rate-limit/write-ceiling.js';
import { mountTowerRoutes } from './towers/routes.js';

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
  /** 2.19: when set, mounts the guarded internal routes. */
  internalApiToken?: string | undefined;
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
    mountPublicRoutes: (api) => {
      mountPublicAuthRoutes(api, { authService, rateLimit });
      if (deps.internalApiToken) {
        mountInternalRoutes(api, {
          token: deps.internalApiToken,
          evaluate: createEvaluator(deps.db, deps.logger),
        });
      }
    },
    mountRoutes: (api) => {
      // 2.18: the per-user write ceiling, after auth so the user is known.
      api.use(writeCeiling(rateLimit, (c) => c.get('userId') ?? null));
      mountAuthedAuthRoutes(api, { authService });
      mountMeRoutes(api, { db: deps.db });
      mountHabitRoutes(api, { db: deps.db });
      mountTowerRoutes(api, { db: deps.db, rateLimit });
      mountEntryRoutes(api, { db: deps.db });
    },
  });
}
