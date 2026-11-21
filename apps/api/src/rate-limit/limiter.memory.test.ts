import { describe, expect, it } from 'vitest';
import type { RateRule } from './limiter.js';
import { createMemoryRateLimiter } from './testing.js';

const RULE: RateRule = { name: 'r', limit: 2, windowSeconds: 60 };

function clocked() {
  let now = 1_000_000;
  return {
    limiter: createMemoryRateLimiter(() => now),
    advance: (ms: number) => (now += ms),
  };
}

describe('createMemoryRateLimiter (fixed window)', () => {
  it('allows up to the limit, then denies with the time left in the window', async () => {
    const { limiter, advance } = clocked();
    expect(await limiter.hit(RULE, 'a')).toEqual({
      allowed: true,
      count: 1,
      retryAfterSeconds: 60,
    });
    advance(10_000);
    expect(await limiter.hit(RULE, 'a')).toEqual({
      allowed: true,
      count: 2,
      retryAfterSeconds: 50,
    });
    expect(await limiter.hit(RULE, 'a')).toEqual({
      allowed: false,
      count: 3,
      retryAfterSeconds: 50,
    });
  });

  it('starts a fresh window once the old one has passed', async () => {
    const { limiter, advance } = clocked();
    for (let i = 0; i < 3; i++) await limiter.hit(RULE, 'a');
    advance(60_000);
    expect(await limiter.hit(RULE, 'a')).toMatchObject({ allowed: true, count: 1 });
  });

  it('keeps ids and rules independent', async () => {
    const { limiter } = clocked();
    for (let i = 0; i < 3; i++) await limiter.hit(RULE, 'a');
    expect((await limiter.hit(RULE, 'b')).allowed).toBe(true);
    expect((await limiter.hit({ ...RULE, name: 'other' }, 'a')).allowed).toBe(true);
  });
});
