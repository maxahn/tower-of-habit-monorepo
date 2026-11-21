import { DomainError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { RateLimiter, RateRule } from './limiter.js';

export type RateLimitDeps = { limiter: RateLimiter; logger: Logger };

/** One rule applied to one id. A null id (e.g. an unknown client IP) is skipped. */
export type RateCheck = { rule: RateRule; id: string | null };

export type EnforceOptions = {
  /**
   * 2.18: when the limiter is unreachable, refuse (503) instead of allowing.
   * For verify-code and join-by-code, where the limiter is load-bearing: an
   * unthrottled verify endpoint is brute-forceable in minutes. Ordinary writes
   * keep the default (fail open): a user who can't log loses a streak, a user
   * who can't sign in retries in a minute.
   */
  failClosed?: boolean;
};

/** What a 503 tells the client to wait before retrying. */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/**
 * Applies every check and throws 429 too_many_requests, with Retry-After set to
 * the longest wait, if any is over its limit.
 *
 * If the limiter throws (Redis unreachable): fails open by default (the check
 * is allowed and a warn line is logged), or, with failClosed, throws 503
 * rate_limiter_unavailable.
 */
export async function enforceRateLimits(
  deps: RateLimitDeps,
  checks: readonly RateCheck[],
  options: EnforceOptions = {}
): Promise<void> {
  let retryAfter = 0;
  for (const { rule, id } of checks) {
    if (id === null) continue;
    try {
      const decision = await deps.limiter.hit(rule, id);
      if (!decision.allowed) retryAfter = Math.max(retryAfter, decision.retryAfterSeconds);
    } catch (err) {
      if (options.failClosed) {
        deps.logger.error({ err, rule: rule.name }, 'rate limiter unavailable; refusing');
        throw new DomainError(503, 'rate_limiter_unavailable', 'Try again shortly', undefined, {
          'Retry-After': String(UNAVAILABLE_RETRY_AFTER_SECONDS),
        });
      }
      deps.logger.warn({ err, rule: rule.name }, 'rate limiter unavailable; allowing');
    }
  }
  if (retryAfter > 0) {
    throw new DomainError(
      429,
      'too_many_requests',
      'Too many requests; try again later',
      undefined,
      { 'Retry-After': String(retryAfter) }
    );
  }
}
