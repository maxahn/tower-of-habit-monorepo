import { DomainError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { RateLimiter, RateRule } from './limiter.js';

export type RateLimitDeps = { limiter: RateLimiter; logger: Logger };

/** One rule applied to one id. A null id (e.g. an unknown client IP) is skipped. */
export type RateCheck = { rule: RateRule; id: string | null };

/**
 * Applies every check and throws 429 too_many_requests, with Retry-After set to
 * the longest wait, if any is over its limit.
 *
 * Fails open: if the limiter throws (Redis unreachable), that check is allowed
 * and a warn line is logged. Brute force stays bounded by the per-code attempt
 * cap in Postgres, and a Redis outage does not block every login.
 */
export async function enforceRateLimits(
  deps: RateLimitDeps,
  checks: readonly RateCheck[]
): Promise<void> {
  let retryAfter = 0;
  for (const { rule, id } of checks) {
    if (id === null) continue;
    try {
      const decision = await deps.limiter.hit(rule, id);
      if (!decision.allowed) retryAfter = Math.max(retryAfter, decision.retryAfterSeconds);
    } catch (err) {
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
