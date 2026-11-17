import { describe, expect, it, vi } from 'vitest';
import { buildTestApp, readErrorBody } from '../testing/harness.js';
import { mountInternalRoutes } from './routes.js';

/*
 * 2.19: the internal router is guarded by INTERNAL_API_TOKEN and refuses to
 * mount without one. The evaluation itself is integration-tested; here the
 * guard is exercised against a stub.
 */

const TOWER = '1b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90';
const PERIOD = '4b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90';
const PATH = `/v1/internal/towers/${TOWER}/periods/${PERIOD}/evaluate`;

function app(token: string | undefined) {
  const evaluate = vi.fn(async () => ({ ok: true }));
  const harness = buildTestApp({
    clock: { allowTestClock: true },
    mountPublicRoutes: (api) => mountInternalRoutes(api, { token, evaluate }),
  });
  return { ...harness, evaluate };
}

describe('mountInternalRoutes', () => {
  it('refuses to mount when the token is unset (404 for the path)', () => {
    expect(() => app(undefined)).toThrow(/INTERNAL_API_TOKEN/);
    expect(() => app('')).toThrow(/INTERNAL_API_TOKEN/);
  });

  it('rejects a missing or wrong bearer token with 401, without running the session auth', async () => {
    const { app: a, auth, evaluate } = app('s3cret');
    for (const headers of [
      {},
      { authorization: 'Bearer wrong' },
      { authorization: 'Basic s3cret' },
    ]) {
      const res = await a.request(PATH, { method: 'POST', headers });
      expect(res.status).toBe(401);
      expect((await readErrorBody(res)).error.code).toBe('unauthenticated');
    }
    expect(evaluate).not.toHaveBeenCalled();
    expect(auth.calls).toBe(0);
  });

  it('runs the evaluation with the request instant on the right token', async () => {
    const { app: a, evaluate } = app('s3cret');
    const res = await a.request(PATH, {
      method: 'POST',
      headers: { authorization: 'Bearer s3cret', 'x-test-now': '2026-11-17T07:00:00.000Z' },
    });
    expect(res.status).toBe(200);
    expect(evaluate).toHaveBeenCalledWith(TOWER, PERIOD, new Date('2026-11-17T07:00:00.000Z'));
  });

  it('rejects malformed ids with 400 validation_failed', async () => {
    const { app: a } = app('s3cret');
    const res = await a.request('/v1/internal/towers/nope/periods/nah/evaluate', {
      method: 'POST',
      headers: { authorization: 'Bearer s3cret' },
    });
    expect(res.status).toBe(400);
  });
});
