import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { closeDb, db, pingDb } from '@tower-of-habit/db';
import { Redis } from 'ioredis';
import { createApp } from './app.js';
import { mountAuthedAuthRoutes, mountPublicAuthRoutes } from './auth/routes.js';
import { createLogLoginCodeSender } from './auth/sender.js';
import { createAuthService } from './auth/service.js';
import { createSessionMiddleware } from './auth/session-middleware.js';
import { createJsonLogger } from './logger.js';
import { createGracefulShutdown, installSignalHandlers } from './shutdown.js';

const SECONDS_PER_DAY = 24 * 60 * 60;
const CODE_TTL_SECONDS = 10 * 60; // 10 minutes
const SESSION_TTL_SECONDS = 90 * SECONDS_PER_DAY; // 90 days

// Composition root: the only module that touches real Postgres, Redis, env and
// the process. Everything it wires is unit-tested through createApp.

const env = process.env;
const port = Number(env.PORT) || 3000;
const corsOrigins = (env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const bodyLimitBytes = Number(env.BODY_LIMIT_BYTES) || 1024 * 1024;
// Under Compose's default 10s stop_grace_period, so we exit before SIGKILL.
const shutdownTimeoutMs = Number(env.SHUTDOWN_TIMEOUT_MS) || 8_000;

const logger = createJsonLogger();

// No offline queue and one retry: a ping while Redis is down fails fast
// instead of waiting for a reconnect, which is what /readyz needs.
const redis = new Redis(env.REDIS_URL ?? 'redis://redis:6379', {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
redis.on('error', (err) => logger.warn({ err }, 'redis connection error'));

// AUTH_CODE_LOG writes the login code to the application log (Phase 2, before
// real email delivery). Defaulted false, and refused in production: a code in a
// prod log is a code in everyone's log shipper.
const authCodeLog = env.AUTH_CODE_LOG === 'true';
if (env.NODE_ENV === 'production' && authCodeLog) {
  throw new Error('AUTH_CODE_LOG must not be true when NODE_ENV=production');
}

const loginCodeSender = createLogLoginCodeSender(logger, { logCode: authCodeLog });
const authService = createAuthService({
  db,
  sender: loginCodeSender,
  codeTtlSeconds: CODE_TTL_SECONDS,
  sessionTtlSeconds: SESSION_TTL_SECONDS,
});

const app = createApp({
  logger,
  auth: createSessionMiddleware(authService),
  readiness: { postgres: pingDb, redis: () => redis.ping() },
  // Called per request, never before the first tick, by which time `shutdown`
  // below is initialised.
  isDraining: () => shutdown.isDraining(),
  corsOrigins,
  bodyLimitBytes,
  mountPublicRoutes: (api) => mountPublicAuthRoutes(api, { authService }),
  mountRoutes: (api) => mountAuthedAuthRoutes(api, { authService }),
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, 'api listening');
});

// serve() returns an HTTP/1 server unless createServer is overridden.
const shutdown = createGracefulShutdown({
  server: server as Server,
  logger,
  timeoutMs: shutdownTimeoutMs,
  onDrained: async () => {
    // quit() needs a live connection; with Redis unreachable just drop the socket.
    const closeRedis =
      redis.status === 'ready' ? redis.quit() : Promise.resolve(redis.disconnect());
    await Promise.all([closeDb(), closeRedis]);
  },
  exit: (code) => process.exit(code),
});
installSignalHandlers(process, shutdown);
