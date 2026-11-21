import { Hono } from 'hono';
import { errorBody } from './errors.js';

/**
 * 2.8: liveness and readiness, split on purpose.
 *
 *   /healthz  liveness. 200 while the process can serve HTTP at all. Touches
 *             nothing external. Compose's restart policy keys on this, so a
 *             brief Postgres outage never restart-loops a healthy process.
 *   /readyz   readiness. 200 only when Postgres and Redis both answer within
 *             checkTimeoutMs; otherwise 503. Caddy's upstream check keys on
 *             this, so traffic goes elsewhere while a dependency is down or
 *             while this process drains on shutdown.
 */

/** Resolves when the dependency is reachable; rejects (or hangs) when not. */
export type ReadinessCheck = () => Promise<unknown>;

export type ReadinessChecks = {
  postgres: ReadinessCheck;
  redis: ReadinessCheck;
};

export type DependencyState = 'up' | 'down';

export type HealthOptions = {
  checks: ReadinessChecks;
  /** True once graceful shutdown has started. */
  isDraining: () => boolean;
  /** A check slower than this counts as down. */
  checkTimeoutMs: number;
};

/** Never rejects: a throw, a rejection or a timeout are all 'down'. */
async function probe(check: ReadinessCheck, timeoutMs: number): Promise<DependencyState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DependencyState>((resolve) => {
    timer = setTimeout(() => resolve('down'), timeoutMs);
  });
  const attempt = (async (): Promise<DependencyState> => {
    await check();
    return 'up';
  })().catch((): DependencyState => 'down');
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Responses:
 *   GET /healthz → 200 { status: 'ok' }
 *   GET /readyz  → 200 { status: 'ready', checks: { postgres: 'up', redis: 'up' } }
 *                → 503 envelope, code not_ready,
 *                  details: { postgres: DependencyState, redis: DependencyState }
 *                → 503 envelope, code shutting_down, while draining (checks not run)
 * Checks run in parallel.
 */
export function healthRoutes(options: HealthOptions): Hono {
  const { checks, isDraining, checkTimeoutMs } = options;
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }, 200));

  app.get('/readyz', async (c) => {
    if (isDraining()) {
      return c.json(errorBody('shutting_down', 'Server is shutting down'), 503);
    }
    const [postgres, redis] = await Promise.all([
      probe(checks.postgres, checkTimeoutMs),
      probe(checks.redis, checkTimeoutMs),
    ]);
    if (postgres === 'up' && redis === 'up') {
      return c.json({ status: 'ready', checks: { postgres, redis } }, 200);
    }
    return c.json(errorBody('not_ready', 'A dependency is unavailable', { postgres, redis }), 503);
  });

  return app;
}
