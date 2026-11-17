import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRedisRateLimiter, rateLimitKey, type RateRule } from './limiter.js';

/*
 * Runs the fixed-window Lua script against a real Redis (db 15, flushed per
 * test). Needs `pnpm dev:up` (Redis on localhost:6379) or REDIS_TEST_URL; the
 * suite is skipped with a notice when Redis is unreachable, so `pnpm test`
 * still passes without services.
 */

const URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/15';
const PREFIX = 'rl-test';
const RULE: RateRule = { name: 'r', limit: 2, windowSeconds: 60 };

const redis = new Redis(URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
redis.on('error', () => undefined);

const reachable = await redis
  .connect()
  .then(() => redis.ping())
  .then(
    () => true,
    () => false
  );
if (!reachable) console.warn(`[limiter.redis.test] Redis unreachable at ${URL}; skipping`);

describe.skipIf(!reachable)('createRedisRateLimiter (real Redis)', () => {
  const limiter = createRedisRateLimiter(redis, { prefix: PREFIX });
  const key = (id: string) => rateLimitKey(PREFIX, RULE, id);

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  it('allows up to the limit, then denies', async () => {
    expect(await limiter.hit(RULE, 'a')).toMatchObject({ allowed: true, count: 1 });
    expect(await limiter.hit(RULE, 'a')).toMatchObject({ allowed: true, count: 2 });
    expect(await limiter.hit(RULE, 'a')).toMatchObject({ allowed: false, count: 3 });
  });

  it('sets the window expiry on the first hit and reports it as Retry-After', async () => {
    const decision = await limiter.hit(RULE, 'a');
    const ttl = await redis.ttl(key('a'));
    expect(ttl).toBeGreaterThan(55);
    expect(ttl).toBeLessThanOrEqual(60);
    expect(decision.retryAfterSeconds).toBe(ttl);
  });

  it('does not extend the window on later hits', async () => {
    await limiter.hit(RULE, 'a');
    await redis.expire(key('a'), 10);
    await limiter.hit(RULE, 'a');
    expect(await redis.ttl(key('a'))).toBeLessThanOrEqual(10);
  });

  it('repairs a key that has no expiry', async () => {
    await redis.set(key('a'), '5'); // no TTL
    const decision = await limiter.hit(RULE, 'a');
    expect(decision).toMatchObject({ allowed: false, count: 6, retryAfterSeconds: 60 });
    expect(await redis.ttl(key('a'))).toBeGreaterThan(0);
  });

  it('starts a new window after the key expires', async () => {
    for (let i = 0; i < 3; i++) await limiter.hit(RULE, 'a');
    await redis.del(key('a')); // stands in for expiry
    expect(await limiter.hit(RULE, 'a')).toMatchObject({ allowed: true, count: 1 });
  });

  it('keeps ids independent', async () => {
    for (let i = 0; i < 3; i++) await limiter.hit(RULE, 'a');
    expect((await limiter.hit(RULE, 'b')).allowed).toBe(true);
  });
});
