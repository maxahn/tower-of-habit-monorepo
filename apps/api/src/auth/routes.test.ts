import { verifyCodeResponseSchema } from '@tower-of-habit/shared';
import type { Context, Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../app.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import { createFailingRateLimiter, createMemoryRateLimiter } from '../rate-limit/testing.js';
import { buildTestApp, createMemoryLogger, readErrorBody } from '../testing/harness.js';
import {
  mountAuthedAuthRoutes,
  mountPublicAuthRoutes,
  REQUEST_CODE_PER_EMAIL,
  REQUEST_CODE_PER_IP,
  VERIFY_CODE_PER_EMAIL,
} from './routes.js';
import type { AuthService, AuthUser } from './service.js';
import { createSessionMiddleware } from './session-middleware.js';
import { createFakeAuthService } from './testing.js';

/*
 * 2.9 auth endpoints. GREEN from Pass 1: the handlers are real and run against
 * the in-memory fakes / vi.fn stubs here (createApp never imports db).
 */

const USER: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'me@example.com',
  timezone: 'UTC',
  displayName: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function fakeService(overrides: Partial<AuthService> = {}): AuthService {
  return {
    requestCode: vi.fn(async () => undefined),
    verifyCode: vi.fn(async () => null),
    authenticate: vi.fn(async () => null),
    revokeSession: vi.fn(async () => undefined),
    revokeAllSessions: vi.fn(async () => undefined),
    ...overrides,
  };
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Rate-limit deps for tests: an in-memory limiter on a movable clock, its own
 * memory logger, and the client IP read from an `x-test-ip` header (null when
 * absent, so the IP rule is skipped).
 */
function testRateLimit(limiter: RateLimiter = createMemoryRateLimiter()) {
  return {
    limiter,
    logger: createMemoryLogger(),
    clientIp: (c: Context) => c.req.header('x-test-ip') ?? null,
  };
}

function publicApp(authService: AuthService, rateLimit = testRateLimit()) {
  // auth stays the default test auth; public routes must bypass it entirely.
  return buildTestApp({
    mountPublicRoutes: (api) => mountPublicAuthRoutes(api, { authService, rateLimit }),
  });
}

describe('POST /auth/request-code', () => {
  it('always answers 202 with an empty body and runs no auth', async () => {
    const authService = fakeService();
    const { app, auth } = publicApp(authService);

    const res = await app.request('/v1/auth/request-code', json({ email: 'me@example.com' }));

    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    expect(authService.requestCode).toHaveBeenCalledWith('me@example.com');
    expect(auth.calls).toBe(0); // reachable without a session
  });

  it('answers 202 identically whether or not the account exists (no enumeration)', async () => {
    // The handler cannot tell the two apart: requestCode resolves either way.
    const { app } = publicApp(fakeService());
    const known = await app.request('/v1/auth/request-code', json({ email: 'known@example.com' }));
    const unknown = await app.request(
      '/v1/auth/request-code',
      json({ email: 'nobody@example.com' })
    );

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.text()).toBe('');
    expect(await unknown.text()).toBe('');
  });

  it('rejects a malformed email with 400 validation_failed', async () => {
    const { app } = publicApp(fakeService());
    const res = await app.request('/v1/auth/request-code', json({ email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect((await readErrorBody(res)).error.code).toBe('validation_failed');
  });
});

describe('POST /auth/verify-code', () => {
  it('returns 200 with { token, user } on success', async () => {
    const authService = fakeService({
      verifyCode: vi.fn(async () => ({ token: 'tok-abc', user: USER })),
    });
    const { app } = publicApp(authService);

    const res = await app.request(
      '/v1/auth/verify-code',
      json({ email: 'me@example.com', code: '123456', timezone: 'America/New_York' })
    );

    expect(res.status).toBe(200);
    const body = verifyCodeResponseSchema.parse(await res.json());
    expect(body.token).toBe('tok-abc');
    expect(body.user.email).toBe('me@example.com');
    expect(authService.verifyCode).toHaveBeenCalledWith({
      email: 'me@example.com',
      code: '123456',
      timezone: 'America/New_York',
      userAgent: null,
    });
  });

  it('defaults timezone to UTC when omitted', async () => {
    const verifyCode = vi.fn(async () => ({ token: 't', user: USER }));
    const { app } = publicApp(fakeService({ verifyCode }));

    await app.request('/v1/auth/verify-code', json({ email: 'me@example.com', code: '123456' }));

    expect(verifyCode).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'UTC' }));
  });

  // consumed / expired / unknown / wrong code are all indistinguishable to the
  // client: the service returns null and the handler maps every one to the same
  // 401 invalid_code, one body, one status.
  it.each([
    ['wrong code', '000000'],
    ['consumed code', '111111'],
    ['expired code', '222222'],
    ['unknown email', '333333'],
  ])('maps a null result (%s) to 401 invalid_code', async (_label, code) => {
    const { app } = publicApp(fakeService({ verifyCode: vi.fn(async () => null) }));

    const res = await app.request('/v1/auth/verify-code', json({ email: 'me@example.com', code }));

    expect(res.status).toBe(401);
    expect((await readErrorBody(res)).error.code).toBe('invalid_code');
  });

  it('rejects a non-six-digit code with 400 validation_failed', async () => {
    const { app } = publicApp(fakeService());
    const res = await app.request(
      '/v1/auth/verify-code',
      json({ email: 'me@example.com', code: '12345' })
    );
    expect(res.status).toBe(400);
    expect((await readErrorBody(res)).error.code).toBe('validation_failed');
  });
});

describe('authenticated auth routes', () => {
  function authedApp(authService: AuthService, authenticate: AuthService['authenticate']) {
    return buildTestApp({
      auth: createSessionMiddleware({ authenticate }),
      mountRoutes: (api: Hono<AppEnv>) => mountAuthedAuthRoutes(api, { authService }),
    }).app;
  }

  it('POST /auth/logout revokes the current session and returns 204', async () => {
    const authService = fakeService();
    const app = authedApp(
      authService,
      vi.fn(async () => ({ userId: 'u1', sessionId: 's1' }))
    );

    const res = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { authorization: 'Bearer good' },
    });

    expect(res.status).toBe(204);
    expect(authService.revokeSession).toHaveBeenCalledWith('s1');
  });

  it('POST /auth/sessions/revoke-all revokes every session for the user and returns 204', async () => {
    const authService = fakeService();
    const app = authedApp(
      authService,
      vi.fn(async () => ({ userId: 'u1', sessionId: 's1' }))
    );

    const res = await app.request('/v1/auth/sessions/revoke-all', {
      method: 'POST',
      headers: { authorization: 'Bearer good' },
    });

    expect(res.status).toBe(204);
    expect(authService.revokeAllSessions).toHaveBeenCalledWith('u1');
  });

  it('rejects logout without a session with 401 unauthenticated', async () => {
    const app = authedApp(
      fakeService(),
      vi.fn(async () => null)
    );
    const res = await app.request('/v1/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
    expect((await readErrorBody(res)).error.code).toBe('unauthenticated');
  });
});

describe('end-to-end: request → verify → authenticated route → logout', () => {
  function flowApp() {
    const authService = createFakeAuthService();
    const harness = buildTestApp({
      auth: createSessionMiddleware(authService),
      mountPublicRoutes: (api) =>
        mountPublicAuthRoutes(api, { authService, rateLimit: testRateLimit() }),
      mountRoutes: (api) => {
        mountAuthedAuthRoutes(api, { authService });
        api.get('/me', (c) => c.json({ userId: c.get('userId') }));
      },
    });
    return { ...harness, authService };
  }

  it('issues a code, verifies it once, authenticates, then logs out', async () => {
    const { app, authService, logger } = flowApp();

    // Request a code for a messy email; it is normalized before anything else.
    const requested = await app.request(
      '/v1/auth/request-code',
      json({ email: '  Me@Example.COM ' })
    );
    expect(requested.status).toBe(202);
    expect(authService.sender.sent).toHaveLength(1);
    const { email, code } = authService.sender.sent[0]!;
    expect(email).toBe('me@example.com');
    expect(code).toMatch(/^\d{6}$/);

    // The code must never appear in a response body or a log line.
    expect(await requested.text()).toBe('');
    expect(JSON.stringify(logger.lines)).not.toContain(code);

    // Verify creates the user with the requested timezone and returns a token.
    const verified = await app.request(
      '/v1/auth/verify-code',
      json({ email: 'me@example.com', code, timezone: 'America/New_York' })
    );
    expect(verified.status).toBe(200);
    const session = verifyCodeResponseSchema.parse(await verified.json());
    expect(session.user.email).toBe('me@example.com');
    expect(session.user.timezone).toBe('America/New_York');

    const authHeader = { authorization: `Bearer ${session.token}` };

    // The token authenticates a protected route.
    const me = await app.request('/v1/me', { headers: authHeader });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ userId: session.user.id });

    // After logout the same token is rejected — 401, never 403.
    const loggedOut = await app.request('/v1/auth/logout', { method: 'POST', headers: authHeader });
    expect(loggedOut.status).toBe(204);

    const afterLogout = await app.request('/v1/me', { headers: authHeader });
    expect(afterLogout.status).toBe(401);
    expect((await readErrorBody(afterLogout)).error.code).toBe('unauthenticated');
  });

  it('rejects reuse of a consumed code (single-use) with 401 invalid_code', async () => {
    const { app, authService } = flowApp();
    await app.request('/v1/auth/request-code', json({ email: 'me@example.com' }));
    const { code } = authService.sender.sent[0]!;

    const first = await app.request(
      '/v1/auth/verify-code',
      json({ email: 'me@example.com', code })
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      '/v1/auth/verify-code',
      json({ email: 'me@example.com', code })
    );
    expect(second.status).toBe(401);
    expect((await readErrorBody(second)).error.code).toBe('invalid_code');
  });
});

describe('rate limiting (2.18)', () => {
  const FIFTEEN_MIN_MS = 15 * 60 * 1000;

  function limitedApp(authService: AuthService = fakeService()) {
    let now = Date.parse('2026-11-16T12:00:00.000Z');
    const rateLimit = testRateLimit(createMemoryRateLimiter(() => now));
    const { app } = publicApp(authService, rateLimit);
    return { app, authService, advance: (ms: number) => (now += ms) };
  }

  const requestCode = (app: Hono<AppEnv>, email: string, ip?: string) =>
    app.request('/v1/auth/request-code', {
      ...json({ email }),
      headers: { 'content-type': 'application/json', ...(ip && { 'x-test-ip': ip }) },
    });

  const verify = (app: Hono<AppEnv>, email: string) =>
    app.request('/v1/auth/verify-code', json({ email, code: '000000' }));

  it('uses the spec limits: 3/15m per email and 10/15m per IP on request-code, 10/15m per email on verify-code', () => {
    expect(REQUEST_CODE_PER_EMAIL).toMatchObject({ limit: 3, windowSeconds: 900 });
    expect(REQUEST_CODE_PER_IP).toMatchObject({ limit: 10, windowSeconds: 900 });
    expect(VERIFY_CODE_PER_EMAIL).toMatchObject({ limit: 10, windowSeconds: 900 });
  });

  it('answers the 4th request-code for one email with 429 and Retry-After, without sending', async () => {
    const { app, authService } = limitedApp();
    for (let i = 0; i < 3; i++) {
      expect((await requestCode(app, 'me@example.com')).status).toBe(202);
    }

    const res = await requestCode(app, 'me@example.com');

    expect(res.status).toBe(429);
    expect((await readErrorBody(res)).error.code).toBe('too_many_requests');
    expect(Number(res.headers.get('retry-after'))).toBe(900);
    expect(authService.requestCode).toHaveBeenCalledTimes(3);
  });

  it('counts the per-email limit on the normalised address', async () => {
    const { app } = limitedApp();
    await requestCode(app, 'me@example.com');
    await requestCode(app, ' ME@example.com');
    await requestCode(app, 'Me@Example.com ');
    expect((await requestCode(app, 'me@EXAMPLE.com')).status).toBe(429);
  });

  it('keeps emails independent', async () => {
    const { app } = limitedApp();
    for (let i = 0; i < 4; i++) await requestCode(app, 'me@example.com');
    expect((await requestCode(app, 'other@example.com')).status).toBe(202);
  });

  it('limits request-code to 10 per IP across different emails', async () => {
    const { app } = limitedApp();
    for (let i = 0; i < 10; i++) {
      expect((await requestCode(app, `u${i}@example.com`, '203.0.113.7')).status).toBe(202);
    }
    expect((await requestCode(app, 'u10@example.com', '203.0.113.7')).status).toBe(429);
    expect((await requestCode(app, 'u10@example.com', '198.51.100.1')).status).toBe(202);
  });

  it('skips the IP rule when the client IP is unknown', async () => {
    const { app } = limitedApp();
    for (let i = 0; i < 11; i++) {
      expect((await requestCode(app, `u${i}@example.com`)).status).toBe(202);
    }
  });

  it('allows requests again once the window has passed', async () => {
    const { app, advance } = limitedApp();
    for (let i = 0; i < 4; i++) await requestCode(app, 'me@example.com');

    advance(FIFTEEN_MIN_MS - 1000);
    const limited = await requestCode(app, 'me@example.com');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');

    advance(1000);
    expect((await requestCode(app, 'me@example.com')).status).toBe(202);
  });

  it('answers the 11th verify-code for one email with 429, without verifying', async () => {
    const { app, authService } = limitedApp();
    for (let i = 0; i < 10; i++) {
      expect((await verify(app, 'me@example.com')).status).toBe(401);
    }

    const res = await verify(app, 'me@example.com');

    expect(res.status).toBe(429);
    expect((await readErrorBody(res)).error.code).toBe('too_many_requests');
    expect(res.headers.get('retry-after')).toBe('900');
    expect(authService.verifyCode).toHaveBeenCalledTimes(10);
  });

  it('fails open when the limiter is unavailable, logging a warning', async () => {
    const authService = fakeService();
    const rateLimit = testRateLimit(createFailingRateLimiter());
    const { app } = publicApp(authService, rateLimit);

    for (let i = 0; i < 5; i++) {
      expect((await requestCode(app, 'me@example.com', '203.0.113.7')).status).toBe(202);
    }
    expect((await verify(app, 'me@example.com')).status).toBe(401);

    expect(authService.requestCode).toHaveBeenCalledTimes(5);
    const warns = rateLimit.logger.lines.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(11); // 5 × (ip + email) + 1 verify
    expect(warns[0]).toMatchObject({ msg: 'rate limiter unavailable; allowing' });
  });
});
