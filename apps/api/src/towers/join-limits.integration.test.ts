import { describe, expect, it } from 'vitest';
import { createFailingRateLimiter } from '../rate-limit/testing.js';
import { readErrorBody } from '../testing/harness.js';
import { useIntegrationApp } from '../testing/integration.js';
import { JOIN_PER_IP, JOIN_PER_USER } from './routes.js';

/*
 * 2.18: join-by-code is the enumeration surface for an 8-character code, so
 * it is limited per user (10/hour) and per client IP (30/hour), every attempt
 * counted, and fails closed when Redis is away.
 */

describe('join-by-code limits', () => {
  const it_ = useIntegrationApp();

  it('limits a user to 10 attempts per hour, successful or not, with Retry-After', async () => {
    const joiner = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(joiner);
    expect(JOIN_PER_USER).toMatchObject({ limit: 10, windowSeconds: 3600 });
    for (let i = 0; i < 10; i++) {
      const res = await it_.request('/v1/towers/join', {
        as: joiner,
        json: { joinCode: 'ZZZZ9999', habitId: habit.id },
      });
      expect(res.status).toBe(404);
    }
    const res = await it_.request('/v1/towers/join', {
      as: joiner,
      json: { joinCode: 'ZZZZ9999', habitId: habit.id },
    });
    expect(res.status).toBe(429);
    expect((await readErrorBody(res)).error.code).toBe('too_many_requests');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);

    // The window is fixed: an hour later the user may try again.
    it_.clock.advance({ hours: 1, minutes: 1 });
    const later = await it_.request('/v1/towers/join', {
      as: joiner,
      json: { joinCode: 'ZZZZ9999', habitId: habit.id },
    });
    expect(later.status).toBe(404);
  });

  it('limits a client IP to 30 attempts per hour across users', async () => {
    expect(JOIN_PER_IP).toMatchObject({ limit: 30, windowSeconds: 3600 });
    let sent = 0;
    for (let u = 0; u < 4; u++) {
      const joiner = await it_.fixtures.user();
      const habit = await it_.fixtures.habit(joiner);
      for (let i = 0; i < 8; i++) {
        const res = await it_.request('/v1/towers/join', {
          as: joiner,
          json: { joinCode: 'ZZZZ9999', habitId: habit.id },
          headers: { 'x-test-ip': '203.0.113.9' },
        });
        sent += 1;
        expect(res.status, `attempt ${sent}`).toBe(sent <= 30 ? 404 : 429);
      }
    }
  });
});

describe('join-by-code with the limiter unavailable', () => {
  const it_ = useIntegrationApp({ limiter: createFailingRateLimiter() });

  it('fails closed with 503 rate_limiter_unavailable, while ordinary writes fail open', async () => {
    const s = await it_.fixtures.lobby({ members: 1 });
    const joiner = await it_.fixtures.user();
    const habit = await it_.fixtures.habit(joiner);
    const join = await it_.request('/v1/towers/join', {
      as: joiner,
      json: { joinCode: s.tower.joinCode, habitId: habit.id },
    });
    expect(join.status).toBe(503);
    expect((await readErrorBody(join)).error.code).toBe('rate_limiter_unavailable');

    const write = await it_.request('/v1/habits', {
      as: joiner,
      json: { name: 'Still works', type: 'binary' },
    });
    expect(write.status).toBe(201);
  });
});
