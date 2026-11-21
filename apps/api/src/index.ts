import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { closeDb, db, pingDb } from '@tower-of-habit/db';
import { Redis } from 'ioredis';
import {
  assertAuthCodeLogDisabled,
  createEmailLoginCodeSender,
  createLogLoginCodeSender,
} from './auth/sender.js';
import { composeApp } from './compose.js';
import { createJsonLogger } from './logger.js';
import { createClientIpResolver } from './rate-limit/client-ip.js';
import { createRedisRateLimiter } from './rate-limit/limiter.js';
import { createGracefulShutdown, installSignalHandlers } from './shutdown.js';

// Composition root: the only module that touches real Redis, env and the
// process. The route table itself is wired in compose.ts, which the
// integration suite also runs.

const env = process.env;
const port = Number(env.PORT) || 3000;
const corsOrigins = (env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const bodyLimitBytes = Number(env.BODY_LIMIT_BYTES) || 1024 * 1024;
// Under Compose's default 10s stop_grace_period, so we exit before SIGKILL.
const shutdownTimeoutMs = Number(env.SHUTDOWN_TIMEOUT_MS) || 8_000;
const production = env.NODE_ENV === 'production';

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
assertAuthCodeLogDisabled({ production, authCodeLog });

// ALLOW_TEST_CLOCK lets a request override its `now` with X-Test-Now (2.10).
// Only for the integration suite; refused in production for the obvious reason.
const allowTestClock = env.ALLOW_TEST_CLOCK === 'true';
if (production && allowTestClock) {
  throw new Error('ALLOW_TEST_CLOCK must not be true when NODE_ENV=production');
}

const app = composeApp({
  db,
  logger,
  sender: authCodeLog
    ? createLogLoginCodeSender(logger, { logCode: true })
    : createEmailLoginCodeSender(db),
  // Shares the client above: no offline queue and one retry, so a Redis outage
  // fails fast and the limits fail open or closed per route (rate-limit/enforce.ts).
  limiter: createRedisRateLimiter(redis),
  // Set only behind a proxy that overwrites the header (Caddy: x-real-ip).
  clientIp: createClientIpResolver({ trustedHeader: env.TRUSTED_IP_HEADER }),
  readiness: { postgres: pingDb, redis: () => redis.ping() },
  // Called per request, never before the first tick, by which time `shutdown`
  // below is initialised.
  isDraining: () => shutdown.isDraining(),
  corsOrigins,
  bodyLimitBytes,
  clock: { allowTestClock },
  // 2.19: the internal evaluation trigger mounts only when a token is set.
  internalApiToken: env.INTERNAL_API_TOKEN,
  resendWebhookSecret: env.RESEND_WEBHOOK_SECRET,
});
if (!env.INTERNAL_API_TOKEN) {
  logger.warn({}, 'INTERNAL_API_TOKEN unset; internal routes not mounted');
}

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
