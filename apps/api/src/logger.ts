import type { MiddlewareHandler } from 'hono';

/**
 * 2.8: structured logging. Deliberately tiny: one JSON object per line, so
 * Docker's json-file driver and Caddy-style log shippers can parse it. pino can
 * sit behind this interface later without touching call sites.
 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
}

export type LogLevel = 'info' | 'warn' | 'error';

/** JSON.stringify turns an Error into {}; keep what matters for debugging. */
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause !== undefined && { cause: value.cause }),
    };
  }
  return value;
}

/**
 * Writes `{ ...fields, level, time, msg }` as one JSON line per call. Error
 * values in fields are serialised as { name, message, stack }.
 */
export function createJsonLogger(
  write: (line: string) => void = (line) => process.stdout.write(line + '\n')
): Logger {
  const at =
    (level: LogLevel) =>
    (fields: LogFields, msg: string): void => {
      write(
        JSON.stringify({ ...fields, level, time: new Date().toISOString(), msg }, errorReplacer)
      );
    };
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

function levelFor(status: number): LogLevel {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/**
 * Logs one line per request AFTER the response is decided (including error
 * responses produced by onError), with
 *   { requestId, method, path, status, durationMs }.
 * Level: info for < 400, warn for 4xx, error for 5xx. `path` excludes the
 * query string so secrets passed there never reach the log.
 *
 * Must run after requestId() so `c.get('requestId')` is set.
 */
export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const status = c.res.status;
    logger[levelFor(status)](
      {
        requestId: c.get('requestId') as string | undefined,
        method: c.req.method,
        path: c.req.path,
        status,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      },
      'request'
    );
  };
}
