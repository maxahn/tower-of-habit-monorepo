import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../errors.js';
import { createMemoryLogger } from '../testing/harness.js';
import { enforceRateLimits } from './enforce.js';
import type { RateLimiter, RateRule } from './limiter.js';
import { createFailingRateLimiter } from './testing.js';

const A: RateRule = { name: 'a', limit: 1, windowSeconds: 60 };
const B: RateRule = { name: 'b', limit: 1, windowSeconds: 60 };

/** A limiter that returns a fixed decision per rule name. */
function scripted(decisions: Record<string, { allowed: boolean; retryAfterSeconds: number }>) {
  const hit = vi.fn<RateLimiter['hit']>(async (rule) => ({ count: 1, ...decisions[rule.name]! }));
  return { hit };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('enforceRateLimits', () => {
  it('resolves when every check is allowed', async () => {
    const limiter = scripted({ a: { allowed: true, retryAfterSeconds: 60 } });
    await expect(
      enforceRateLimits({ limiter, logger: createMemoryLogger() }, [{ rule: A, id: 'x' }])
    ).resolves.toBeUndefined();
  });

  it('skips a check whose id is null', async () => {
    const limiter = scripted({});
    await enforceRateLimits({ limiter, logger: createMemoryLogger() }, [{ rule: A, id: null }]);
    expect(limiter.hit).not.toHaveBeenCalled();
  });

  it('throws 429 too_many_requests with the longest Retry-After when any check is denied', async () => {
    const limiter = scripted({
      a: { allowed: false, retryAfterSeconds: 30 },
      b: { allowed: false, retryAfterSeconds: 120 },
    });
    const err = await caught(
      enforceRateLimits({ limiter, logger: createMemoryLogger() }, [
        { rule: A, id: 'x' },
        { rule: B, id: 'y' },
      ])
    );

    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({
      status: 429,
      code: 'too_many_requests',
      headers: { 'Retry-After': '120' },
    });
    // Every check still counts, even after one is denied.
    expect(limiter.hit).toHaveBeenCalledTimes(2);
  });

  it('fails open: a throwing limiter is allowed and logs one warn per check', async () => {
    const logger = createMemoryLogger();
    await enforceRateLimits({ limiter: createFailingRateLimiter(), logger }, [
      { rule: A, id: 'x' },
    ]);

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({
      level: 'warn',
      rule: 'a',
      msg: 'rate limiter unavailable; allowing',
    });
  });
});
