import type { Redis } from 'ioredis';

/**
 * 2.18: fixed-window rate limiting. A rule allows `limit` hits per id within a
 * `windowSeconds` window that starts at the id's first hit. Every hit counts,
 * including denied ones.
 */
export type RateRule = { name: string; limit: number; windowSeconds: number };

export type RateDecision = {
  allowed: boolean;
  /** Hits so far in the current window, this one included. */
  count: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
};

/**
 * The limiter port. Implementations throw when the backing store is
 * unreachable; deciding to fail open is the caller's job (enforce.ts).
 */
export interface RateLimiter {
  hit(rule: RateRule, id: string): Promise<RateDecision>;
}

/**
 * INCR, set the expiry on the window's first hit, return [count, ttl]. The
 * `ttl < 0` branch repairs a key that somehow lost its expiry, so an id can
 * never be locked out forever. Atomic: Redis runs a script without interleaving.
 */
const FIXED_WINDOW_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { n, ttl }
`;

export function rateLimitKey(prefix: string, rule: RateRule, id: string): string {
  return `${prefix}:${rule.name}:${id}`;
}

/** Type-only ioredis import: the app layer never loads ioredis itself. */
export function createRedisRateLimiter(
  redis: Pick<Redis, 'eval'>,
  options: { prefix?: string } = {}
): RateLimiter {
  const prefix = options.prefix ?? 'rl';
  return {
    async hit(rule, id) {
      const reply = (await redis.eval(
        FIXED_WINDOW_SCRIPT,
        1,
        rateLimitKey(prefix, rule, id),
        String(rule.windowSeconds)
      )) as [number, number];
      const [count, ttl] = reply;
      return { allowed: count <= rule.limit, count, retryAfterSeconds: Math.max(ttl, 1) };
    },
  };
}
