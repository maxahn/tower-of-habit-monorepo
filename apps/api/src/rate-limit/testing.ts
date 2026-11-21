import type { RateLimiter } from './limiter.js';

/**
 * In-memory fixed-window limiter with the same semantics as the Redis script,
 * driven by a movable clock (epoch milliseconds).
 */
export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async hit(rule, id) {
      const key = `${rule.name}:${id}`;
      const t = now();
      let w = windows.get(key);
      if (!w || t >= w.resetAt) {
        w = { count: 0, resetAt: t + rule.windowSeconds * 1000 };
        windows.set(key, w);
      }
      w.count += 1;
      return {
        allowed: w.count <= rule.limit,
        count: w.count,
        retryAfterSeconds: Math.max(Math.ceil((w.resetAt - t) / 1000), 1),
      };
    },
  };
}

/** Every hit rejects, as the Redis limiter does when Redis is unreachable. */
export function createFailingRateLimiter(
  error: Error = new Error('redis unavailable')
): RateLimiter & { calls: number } {
  const state = {
    calls: 0,
    async hit(): Promise<never> {
      state.calls += 1;
      throw error;
    },
  };
  return state;
}
