import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { createApp, type AppDeps, type AppEnv } from '../app.js';
import { DomainError } from '../errors.js';
import type { LogFields, Logger, LogLevel } from '../logger.js';

export type LogLine = { level: LogLevel; msg: string } & LogFields;

export type MemoryLogger = Logger & { lines: LogLine[] };

/** A Logger that keeps every line in memory, for assertions. */
export function createMemoryLogger(): MemoryLogger {
  const lines: LogLine[] = [];
  const at =
    (level: LogLevel) =>
    (fields: LogFields, msg: string): void => {
      lines.push({ ...fields, level, msg });
    };
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

export const TEST_TOKEN = 'test';
export const TEST_ORIGIN = 'https://app.test';
export const TEST_BODY_LIMIT = 1024;

/**
 * Stand-in for real auth (out of scope for 2.8): accepts `Bearer test`,
 * otherwise DomainError(401, 'unauthorized'). `calls` counts invocations, and
 * `sawRequestId` records whether requestId() had already run.
 */
export function createTestAuth() {
  const state = { calls: 0, sawRequestId: [] as boolean[] };
  const middleware: MiddlewareHandler<AppEnv> = async (c, next) => {
    state.calls += 1;
    state.sawRequestId.push(typeof c.get('requestId') === 'string');
    if (c.req.header('authorization') !== `Bearer ${TEST_TOKEN}`) {
      throw new DomainError(401, 'unauthorized', 'Missing or invalid credentials');
    }
    await next();
  };
  return Object.assign(state, { middleware });
}

export const AUTH_HEADER = { authorization: `Bearer ${TEST_TOKEN}` } as const;

/** createApp with fakes: checks pass, nothing draining, a memory logger. */
export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  const logger = createMemoryLogger();
  const auth = createTestAuth();
  const app = createApp({
    logger,
    auth: auth.middleware,
    readiness: { postgres: async () => undefined, redis: async () => undefined },
    isDraining: () => false,
    corsOrigins: [TEST_ORIGIN],
    bodyLimitBytes: TEST_BODY_LIMIT,
    readinessTimeoutMs: 50,
    ...overrides,
  });
  return { app, logger, auth };
}

/** The envelope's shape, for asserting any error response. */
export const errorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

/** Asserts the response is a JSON error envelope and returns it parsed. */
export async function readErrorBody(res: Response) {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(`expected JSON error envelope, got content-type "${contentType}"`);
  }
  return errorBodySchema.parse(await res.json());
}
