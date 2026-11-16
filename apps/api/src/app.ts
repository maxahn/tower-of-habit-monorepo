import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { catchNonErrors, DomainError, handleError, handleNotFound } from './errors.js';
import { healthRoutes, type ReadinessChecks } from './health.js';
import { requestLogger, type Logger } from './logger.js';

/**
 * 2.8: the app shell. A factory, not a module-level app: it never imports
 * @tower-of-habit/db or ioredis (db throws on import without DATABASE_URL), so
 * tests build it with fakes and index.ts wires in the real dependencies.
 */

export type AppEnv = { Variables: RequestIdVariables };

export type AppDeps = {
  logger: Logger;
  /** Runs on /v1/* only. Throws DomainError(401) to reject. */
  auth: MiddlewareHandler<AppEnv>;
  readiness: ReadinessChecks;
  isDraining: () => boolean;
  /** Exact origins allowed by CORS. */
  corsOrigins: readonly string[];
  /** Larger request bodies get 413 payload_too_large. */
  bodyLimitBytes: number;
  /** Per readiness check. Defaults to 1000. */
  readinessTimeoutMs?: number;
  /** Registers routes on the authenticated /v1 router. */
  mountRoutes?: (api: Hono<AppEnv>) => void;
};

/** Everything versioned and authenticated lives under this prefix. */
export const API_PREFIX = '/v1';

export const DEFAULT_READINESS_TIMEOUT_MS = 1_000;

/**
 * Middleware order (acceptance criterion, do not reorder):
 *   requestId → requestLogger → cors → bodyLimit → [health routes] → auth → route
 *
 * Health routes sit before auth so the Compose and Caddy probes need no
 * credentials. onError = handleError(logger), notFound = handleNotFound.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(requestLogger(deps.logger));
  app.use(cors({ origin: [...deps.corsOrigins], exposeHeaders: ['X-Request-Id'] }));
  app.use(
    bodyLimit({
      maxSize: deps.bodyLimitBytes,
      onError: () => {
        throw new DomainError(413, 'payload_too_large', 'Request body too large');
      },
    })
  );

  app.route(
    '/',
    healthRoutes({
      checks: deps.readiness,
      isDraining: deps.isDraining,
      checkTimeoutMs: deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    })
  );

  const api = new Hono<AppEnv>();
  api.use(deps.auth);
  api.use(catchNonErrors);
  deps.mountRoutes?.(api);
  app.route(API_PREFIX, api);

  app.onError(handleError(deps.logger));
  app.notFound(handleNotFound);
  return app;
}
