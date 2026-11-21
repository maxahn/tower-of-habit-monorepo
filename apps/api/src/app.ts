import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { buildOpenApiDocument, DOCS_PATH, OPENAPI_PATH } from './docs/openapi.js';
import { SWAGGER_UI_HTML } from './docs/swagger-ui.js';
import { requestClock, type ClockOptions } from './context.js';
import { catchNonErrors, DomainError, handleError, handleNotFound } from './errors.js';
import { healthRoutes, type ReadinessChecks } from './health.js';
import { requestLogger, type Logger } from './logger.js';

// Built once: the spec is static data derived from the zod schemas.
const OPENAPI_DOCUMENT = buildOpenApiDocument();

/**
 * 2.8: the app shell. A factory, not a module-level app: it never imports
 * @tower-of-habit/db or ioredis (db throws on import without DATABASE_URL), so
 * tests build it with fakes and index.ts wires in the real dependencies.
 */

// userId and sessionId are attached by the session auth middleware (2.9) and so
// are present on every authenticated (/v1) route; the public auth routes below
// do not read them.
export type AppEnv = {
  Variables: RequestIdVariables & {
    userId: string;
    sessionId: string;
    /** The request's single instant (2.10), set by the clock middleware. */
    now: Date;
  };
};

export type AppDeps = {
  logger: Logger;
  /** Runs on the authenticated /v1 routes only. Throws DomainError(401) to reject. */
  auth: MiddlewareHandler<AppEnv>;
  readiness: ReadinessChecks;
  isDraining: () => boolean;
  /** Exact origins allowed by CORS. */
  corsOrigins: readonly string[];
  /** Larger request bodies get 413 payload_too_large. */
  bodyLimitBytes: number;
  /** Per readiness check. Defaults to 1000. */
  readinessTimeoutMs?: number;
  /** 2.10 clock options. Defaults to no test clock. */
  clock?: ClockOptions;
  /**
   * Registers routes on a /v1 router that runs BEFORE auth, for endpoints that
   * must be reachable without a session (login code request/verify). Mounted
   * like the health routes: versioned, but public.
   */
  mountPublicRoutes?: (api: Hono<AppEnv>) => void;
  /** Registers routes on the authenticated /v1 router. */
  mountRoutes?: (api: Hono<AppEnv>) => void;
};

/** Everything versioned and authenticated lives under this prefix. */
export const API_PREFIX = '/v1';

export const DEFAULT_READINESS_TIMEOUT_MS = 1_000;

/**
 * Middleware order (acceptance criterion, do not reorder):
 *   requestId → requestLogger → clock → cors → bodyLimit → [health routes] → auth → route
 * The clock (2.10) sits right after the logger: it reads no request body and
 * must be set for public and authenticated routes alike.
 *
 * Health routes sit before auth so the Compose and Caddy probes need no
 * credentials. onError = handleError(logger), notFound = handleNotFound.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(requestLogger(deps.logger));
  app.use(requestClock(deps.clock ?? { allowTestClock: false }));
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

  // API docs: public and unversioned, like the health routes. Both are pure
  // (the spec is static data; the UI loads Swagger UI from a CDN), so they are
  // always served and testable through buildTestApp.
  app.get(OPENAPI_PATH, (c) => c.json(OPENAPI_DOCUMENT));
  app.get(DOCS_PATH, (c) => c.html(SWAGGER_UI_HTML));

  // Public /v1 routes, mounted before the authenticated router so a request to
  // one of their paths never reaches deps.auth. A path not registered here falls
  // through to the authenticated router below.
  if (deps.mountPublicRoutes) {
    const publicApi = new Hono<AppEnv>();
    publicApi.use(catchNonErrors);
    deps.mountPublicRoutes(publicApi);
    app.route(API_PREFIX, publicApi);
  }

  const api = new Hono<AppEnv>();
  api.use(deps.auth);
  api.use(catchNonErrors);
  deps.mountRoutes?.(api);
  app.route(API_PREFIX, api);

  app.onError(handleError(deps.logger));
  app.notFound(handleNotFound);
  return app;
}
