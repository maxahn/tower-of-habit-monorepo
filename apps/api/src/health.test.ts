import { describe, expect, it, vi } from 'vitest';
import type { ReadinessCheck } from './health.js';
import { buildTestApp, readErrorBody } from './testing/harness.js';

const up: ReadinessCheck = async () => undefined;
const down: ReadinessCheck = async () => {
  throw new Error('ECONNREFUSED');
};
const hangs: ReadinessCheck = () => new Promise(() => {});

describe('GET /healthz (liveness)', () => {
  it('returns 200 without touching Postgres or Redis', async () => {
    const postgres = vi.fn(down);
    const redis = vi.fn(down);
    const { app } = buildTestApp({ readiness: { postgres, redis } });

    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(postgres).not.toHaveBeenCalled();
    expect(redis).not.toHaveBeenCalled();
  });

  it('stays 200 while draining (the process is alive; readiness is what changes)', async () => {
    const { app } = buildTestApp({ isDraining: () => true });
    expect((await app.request('/healthz')).status).toBe(200);
  });

  it('needs no credentials', async () => {
    const { app, auth } = buildTestApp();
    expect((await app.request('/healthz')).status).toBe(200);
    expect(auth.calls).toBe(0);
  });
});

describe('GET /readyz (readiness)', () => {
  it('returns 200 when Postgres and Redis are both up', async () => {
    const { app } = buildTestApp({ readiness: { postgres: up, redis: up } });
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready', checks: { postgres: 'up', redis: 'up' } });
  });

  it.each([
    ['Postgres down', down, up, { postgres: 'down', redis: 'up' }],
    ['Redis down', up, down, { postgres: 'up', redis: 'down' }],
    ['both down', down, down, { postgres: 'down', redis: 'down' }],
    ['Postgres hanging', hangs, up, { postgres: 'down', redis: 'up' }],
    ['Redis hanging', up, hangs, { postgres: 'up', redis: 'down' }],
  ])('returns 503 not_ready when %s', async (_label, postgres, redis, details) => {
    const { app } = buildTestApp({ readiness: { postgres, redis }, readinessTimeoutMs: 20 });
    const res = await app.request('/readyz');
    expect(res.status).toBe(503);
    expect(await readErrorBody(res)).toEqual({
      error: { code: 'not_ready', message: expect.any(String), details },
    });
  });

  it('runs the checks in parallel', async () => {
    const slow = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
    const { app } = buildTestApp({
      readiness: { postgres: slow, redis: slow },
      readinessTimeoutMs: 45,
    });
    // Sequential would take ~60ms and the second check would blow the 45ms budget.
    expect((await app.request('/readyz')).status).toBe(200);
  });

  it('does not leak the dependency error message', async () => {
    const { app } = buildTestApp({
      readiness: {
        postgres: async () => {
          throw new Error('password authentication failed for user "tower"');
        },
        redis: up,
      },
    });
    const text = await (await app.request('/readyz')).text();
    expect(text).not.toContain('password');
  });

  it('returns 503 shutting_down while draining, without running the checks', async () => {
    const postgres = vi.fn(up);
    const redis = vi.fn(up);
    const { app } = buildTestApp({ readiness: { postgres, redis }, isDraining: () => true });

    const res = await app.request('/readyz');
    expect(res.status).toBe(503);
    expect((await readErrorBody(res)).error.code).toBe('shutting_down');
    expect(postgres).not.toHaveBeenCalled();
    expect(redis).not.toHaveBeenCalled();
  });

  it('needs no credentials', async () => {
    const { app, auth } = buildTestApp();
    expect((await app.request('/readyz')).status).toBe(200);
    expect(auth.calls).toBe(0);
  });
});
