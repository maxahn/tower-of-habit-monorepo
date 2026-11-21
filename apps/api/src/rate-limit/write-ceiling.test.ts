import { describe, expect, it } from 'vitest';
import {
  AUTH_HEADER,
  buildTestApp,
  createMemoryLogger,
  readErrorBody,
} from '../testing/harness.js';
import { createFailingRateLimiter, createMemoryRateLimiter } from './testing.js';
import { WRITE_CEILING_PER_USER, writeCeiling } from './write-ceiling.js';

/*
 * 2.18: a global per-user ceiling on write endpoints, well above normal use.
 * A backstop, not a product constraint: it fails open, and reads are never
 * counted.
 */

function app(limiter = createMemoryRateLimiter()) {
  const logger = createMemoryLogger();
  const harness = buildTestApp({
    mountRoutes: (api) => {
      api.use(writeCeiling({ limiter, logger }, (c) => c.get('userId') ?? 'test-user'));
      api.post('/w', (c) => c.json({ ok: true }));
      api.patch('/w', (c) => c.json({ ok: true }));
      api.get('/r', (c) => c.json({ ok: true }));
    },
  });
  return { ...harness, limitLogger: logger };
}

describe('writeCeiling', () => {
  it('is well above normal use', () => {
    expect(WRITE_CEILING_PER_USER.limit).toBeGreaterThanOrEqual(300);
    expect(WRITE_CEILING_PER_USER.windowSeconds).toBe(3600);
  });

  it('returns 429 with Retry-After once a user exceeds the ceiling, counting every write method', async () => {
    const limiter = createMemoryRateLimiter();
    const { app: a } = app(limiter);
    for (let i = 0; i < WRITE_CEILING_PER_USER.limit; i++) {
      const res = await a.request('/v1/w', {
        method: i % 2 ? 'POST' : 'PATCH',
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
    }
    const res = await a.request('/v1/w', { method: 'POST', headers: AUTH_HEADER });
    expect(res.status).toBe(429);
    expect((await readErrorBody(res)).error.code).toBe('too_many_requests');
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
  });

  it('never counts reads', async () => {
    const limiter = createMemoryRateLimiter();
    const { app: a } = app(limiter);
    for (let i = 0; i < WRITE_CEILING_PER_USER.limit + 5; i++) {
      expect((await a.request('/v1/r', { headers: AUTH_HEADER })).status).toBe(200);
    }
    expect((await a.request('/v1/w', { method: 'POST', headers: AUTH_HEADER })).status).toBe(200);
  });

  it('fails open when the limiter is unavailable', async () => {
    const { app: a, limitLogger } = app(createFailingRateLimiter());
    expect((await a.request('/v1/w', { method: 'POST', headers: AUTH_HEADER })).status).toBe(200);
    expect(limitLogger.lines[0]).toMatchObject({
      level: 'warn',
      msg: 'rate limiter unavailable; allowing',
    });
  });
});
