import { describe, expect, it, vi } from 'vitest';
import { buildTestApp, readErrorBody } from '../testing/harness.js';
import { createSessionMiddleware } from './session-middleware.js';
import type { AuthService } from './service.js';

/*
 * 2.9 session middleware. GREEN from Pass 1 (the middleware is real); the
 * authenticate dependency is a vi.fn stub.
 */

function appWith(authenticate: AuthService['authenticate']) {
  const auth = createSessionMiddleware({ authenticate });
  return buildTestApp({
    auth,
    mountRoutes: (api) =>
      api.get('/me', (c) => c.json({ userId: c.get('userId'), sessionId: c.get('sessionId') })),
  }).app;
}

describe('session middleware', () => {
  it('attaches userId and sessionId from a valid token', async () => {
    const authenticate = vi.fn(async () => ({ userId: 'u1', sessionId: 's1' }));
    const app = appWith(authenticate);

    const res = await app.request('/v1/me', { headers: { authorization: 'Bearer good-token' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'u1', sessionId: 's1' });
    expect(authenticate).toHaveBeenCalledWith('good-token');
  });

  it.each([
    ['no Authorization header', {}],
    ['a non-Bearer header', { authorization: 'Basic abc' }],
    ['an unknown/expired/revoked token', { authorization: 'Bearer nope' }],
  ])('returns 401 unauthenticated for %s', async (_label, headers) => {
    // null = unknown, expired, or revoked — all indistinguishable here, all 401.
    const app = appWith(vi.fn(async () => null));

    const res = await app.request('/v1/me', { headers });

    expect(res.status).toBe(401);
    expect((await readErrorBody(res)).error.code).toBe('unauthenticated');
  });
});
