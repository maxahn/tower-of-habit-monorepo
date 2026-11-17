import type { Db } from '@tower-of-habit/db';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from './app.js';
import { DomainError } from './errors.js';

/**
 * 2.10: request context and the transaction helper.
 *
 * One request, one `now`. The clock middleware captures a single instant per
 * request; every evaluator call, every `loggedAt` and every stamped timestamp
 * in that request reads it through ctxOf / withTx. Handlers never call
 * `new Date()` themselves, and eslint (no-restricted-syntax on apps/api/src)
 * fails the build if one does. This file and index.ts are the only exemptions:
 * the clock has to be read somewhere, and this is where.
 *
 * X-Test-Now overrides the captured instant ONLY when the app was built with
 * `clock.allowTestClock` (ALLOW_TEST_CLOCK=true, which index.ts refuses in
 * production). It is what lets the integration suite (2.20/2.21) cross a
 * deadline without sleeping.
 */

export const TEST_NOW_HEADER = 'x-test-now';

export type ClockOptions = {
  /** Honour X-Test-Now. Never true in production. */
  allowTestClock: boolean;
};

/** What a handler gets from the request: the instant, the caller, the trace id. */
export type RequestCtx = {
  now: Date;
  /** Set on authenticated routes; '' on public ones. */
  userId: string;
  requestId: string;
};

/** Sets `now` on the context. Runs before auth so public routes see it too. */
export function requestClock(options: ClockOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = options.allowTestClock ? c.req.header(TEST_NOW_HEADER) : undefined;
    let now: Date;
    if (header !== undefined) {
      const ms = Date.parse(header);
      if (Number.isNaN(ms)) {
        throw new DomainError(
          400,
          'invalid_test_clock',
          `${TEST_NOW_HEADER} is not an ISO instant`
        );
      }
      now = new Date(ms);
    } else {
      // The one clock read per request (this file is exempt from the lint rule).
      now = new Date();
    }
    c.set('now', now);
    await next();
  };
}

/** The request context, from values the middleware stack has already set. */
export function ctxOf(c: Context<AppEnv>): RequestCtx {
  const now = c.get('now');
  if (!(now instanceof Date)) {
    throw new Error('request clock middleware did not run; ctx.now is unset');
  }
  return {
    now,
    userId: c.get('userId') ?? '',
    requestId: (c.get('requestId') as string | undefined) ?? '',
  };
}

/**
 * The slice of the db handle withTx needs. Structural, so tests pass a fake
 * and the app layer never imports the db package at runtime (type-only).
 */
export type TxRunner = {
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
};

/**
 * Runs `fn` inside one transaction with the request context. Commits when `fn`
 * resolves, rolls back (and rethrows) when it throws, so a DomainError thrown
 * half-way through a multi-row write leaves nothing behind.
 */
export function withTx<T>(
  db: TxRunner,
  c: Context<AppEnv>,
  fn: (tx: Db, ctx: RequestCtx) => Promise<T>
): Promise<T> {
  const ctx = ctxOf(c);
  return db.transaction((tx) => fn(tx, ctx));
}
