import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { closeDb, pingDb } from '@tower-of-habit/db';
import type { MiddlewareHandler } from 'hono';
import { Redis } from 'ioredis';
import { createApp, type AppEnv } from './app.js';
import { DomainError } from './errors.js';
import { createJsonLogger } from './logger.js';
import { createGracefulShutdown, installSignalHandlers } from './shutdown.js';

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

// Fail closed until real auth lands: nothing under /v1 is reachable yet.
const denyAll: MiddlewareHandler<AppEnv> = async () => {
  throw new DomainError(401, 'unauthorized', 'Missing or invalid credentials');
};

const app = createApp({
  logger,
  auth: denyAll,
  readiness: { postgres: pingDb, redis: () => redis.ping() },
  // Called per request, never before the first tick, by which time `shutdown`
  // below is initialised.
  isDraining: () => shutdown.isDraining(),
  corsOrigins,
  bodyLimitBytes,
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
