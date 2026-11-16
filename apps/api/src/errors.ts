import type { ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { Logger } from './logger.js';
import { zodFieldDetails } from './validation.js';

/**
 * 2.8: the one error envelope. Every non-2xx response the API produces has this
 * body, whatever raised it: a DomainError, a Zod failure, a Hono
 * HTTPException (body limit, malformed JSON), an unknown route, or an
 * unhandled throw.
 *
 * `code` is the stable, machine-readable part; clients branch on it. `message`
 * is for humans and may change. `details` is optional and code-specific
 * (validation_failed: field-keyed messages; not_ready: per-dependency state).
 */
export type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

/** Shown for every unhandled throw. The real message goes to the log only. */
export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

/**
 * An expected, client-facing failure. Thrown from anywhere below the router;
 * handleError turns it into its own status and envelope.
 *
 * Its message IS sent to the client, so never put internals in it.
 */
export class DomainError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/**
 * Wraps a thrown non-Error (a string, a plain object, undefined). Hono only
 * routes `instanceof Error` to onError and rethrows anything else as an
 * unhandled rejection, so catchNonErrors converts it first.
 */
export class NonErrorThrown extends Error {
  constructor(readonly value: unknown) {
    super('Non-Error value thrown');
    this.name = 'NonErrorThrown';
  }
}

/** Sits directly above route handlers so every throw reaches onError. */
export const catchNonErrors: MiddlewareHandler = async (_c, next) => {
  try {
    await next();
  } catch (e) {
    throw e instanceof Error ? e : new NonErrorThrown(e);
  }
};

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

const CODE_BY_STATUS: Partial<Record<number, string>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'too_many_requests',
};

const MESSAGE_BY_STATUS: Partial<Record<number, string>> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  413: 'Request body too large',
  415: 'Unsupported media type',
  429: 'Too many requests',
};

/**
 * app.onError. Maps, in order:
 *   - DomainError    → its own status, code, message, details
 *   - ZodError       → 400 validation_failed, details = zodFieldDetails(err)
 *   - HTTPException  → its status; code from the status (413 payload_too_large,
 *                      400 bad_request, ...), its own response is discarded.
 *                      A 5xx HTTPException is treated as unhandled.
 *   - anything else  → 500 internal_error with INTERNAL_ERROR_MESSAGE. The
 *                      real error is logged once at `error` as
 *                      { requestId, err } (err keeps message + stack); never
 *                      echoed to the client. Expected errors above are not
 *                      logged here; requestLogger's line covers them.
 */
export function handleError(logger: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof DomainError) {
      return c.json(errorBody(err.code, err.message, err.details), err.status);
    }
    if (err instanceof z.ZodError) {
      return c.json(
        errorBody('validation_failed', 'Request validation failed', zodFieldDetails(err)),
        400
      );
    }
    if (err instanceof HTTPException && err.status < 500) {
      const status = err.status;
      const code = CODE_BY_STATUS[status] ?? `http_${status}`;
      const message = err.message || MESSAGE_BY_STATUS[status] || 'Request failed';
      return c.json(errorBody(code, message), status);
    }
    logger.error(
      {
        requestId: c.get('requestId') as string | undefined,
        err: err instanceof NonErrorThrown ? err.value : err,
      },
      'unhandled error'
    );
    return c.json(errorBody('internal_error', INTERNAL_ERROR_MESSAGE), 500);
  };
}

/** app.notFound: 404 not_found in the envelope. */
export const handleNotFound: NotFoundHandler = (c) =>
  c.json(errorBody('not_found', 'Route not found'), 404);
