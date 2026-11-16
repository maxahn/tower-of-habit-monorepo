import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_HEADER,
  buildTestApp,
  readErrorBody,
  TEST_BODY_LIMIT,
  TEST_ORIGIN,
} from './testing/harness.js';

/**
 * 2.8 acceptance: request ID → structured logger → CORS → body limit → auth →
 * route. Order is asserted by behaviour: each layer must already have acted on
 * responses that a later layer rejected, and a later layer must not run when an
 * earlier one rejected.
 */

const OVERSIZED = 'x'.repeat(TEST_BODY_LIMIT + 1);

function setup() {
  const handler = vi.fn();
  const harness = buildTestApp({
    mountRoutes: (api) => {
      api.post('/echo', async (c) => {
        handler();
        return c.json({ length: (await c.req.text()).length });
      });
      api.get('/boom', () => {
        throw new Error('kaboom');
      });
    },
  });
  return { ...harness, handler };
}

function oversized(headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      'content-length': String(OVERSIZED.length),
      origin: TEST_ORIGIN,
      ...headers,
    },
    body: OVERSIZED,
  };
}

describe('request ID (first)', () => {
  it.each([
    ['401 from auth', '/v1/echo', { method: 'POST', body: 'hi' }],
    ['413 from body limit', '/v1/echo', oversized(AUTH_HEADER)],
    ['500 from the route', '/v1/boom', { headers: AUTH_HEADER }],
    ['404 not found', '/v1/missing', { headers: AUTH_HEADER }],
    ['200 healthz', '/healthz', {}],
  ])('is set on a %s', async (_label, path, init) => {
    const { app } = setup();
    const res = await app.request(path, init as RequestInit);
    expect(res.headers.get('x-request-id')).toMatch(/\S+/);
  });

  it('honours a well-formed incoming X-Request-Id', async () => {
    const { app } = setup();
    const res = await app.request('/healthz', { headers: { 'x-request-id': 'caddy-abc-123' } });
    expect(res.headers.get('x-request-id')).toBe('caddy-abc-123');
  });

  it('replaces a malformed incoming X-Request-Id', async () => {
    const { app } = setup();
    const res = await app.request('/healthz', { headers: { 'x-request-id': 'bad id\twith junk' } });
    expect(res.headers.get('x-request-id')).not.toBe('bad id\twith junk');
    expect(res.headers.get('x-request-id')).toMatch(/\S+/);
  });

  it('is visible to auth', async () => {
    const { app, auth } = setup();
    await app.request('/v1/echo', { method: 'POST', headers: AUTH_HEADER, body: 'hi' });
    expect(auth.sawRequestId).toEqual([true]);
  });
});

describe('structured logger (after request ID, before CORS/body limit/auth)', () => {
  it.each([
    ['auth', 401, '/v1/echo', { method: 'POST', body: 'hi' }],
    ['body limit', 413, '/v1/echo', oversized(AUTH_HEADER)],
  ])(
    'logs a request rejected by %s with its request ID and status',
    async (_label, status, path, init) => {
      const { app, logger } = setup();
      const res = await app.request(path, init as RequestInit);
      expect(res.status).toBe(status);

      const requestLines = logger.lines.filter((l) => l.path === path);
      expect(requestLines).toHaveLength(1);
      expect(requestLines[0]).toMatchObject({
        level: 'warn',
        requestId: res.headers.get('x-request-id'),
        method: 'POST',
        status,
      });
    }
  );
});

describe('CORS (before body limit and auth)', () => {
  it('adds CORS headers to a 401 from auth', async () => {
    const { app } = setup();
    const res = await app.request('/v1/echo', {
      method: 'POST',
      headers: { origin: TEST_ORIGIN },
      body: 'hi',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
  });

  it('adds CORS headers to a 413 from body limit', async () => {
    const { app } = setup();
    const res = await app.request('/v1/echo', oversized(AUTH_HEADER));
    expect(res.status).toBe(413);
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
  });

  it('answers a preflight without running auth', async () => {
    const { app, auth } = setup();
    const res = await app.request('/v1/echo', {
      method: 'OPTIONS',
      headers: {
        origin: TEST_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    expect(auth.calls).toBe(0);
  });

  it('does not allow an unknown origin', async () => {
    const { app } = setup();
    const res = await app.request('/healthz', { headers: { origin: 'https://evil.test' } });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.test');
  });
});

describe('body limit (before auth)', () => {
  it('rejects an oversized unauthenticated request with 413, not 401, and never runs auth', async () => {
    const { app, auth, handler } = setup();
    const res = await app.request('/v1/echo', oversized());
    expect(res.status).toBe(413);
    expect((await readErrorBody(res)).error.code).toBe('payload_too_large');
    expect(auth.calls).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an oversized streamed body (no Content-Length) before auth', async () => {
    const { app, auth, handler } = setup();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(OVERSIZED));
        controller.close();
      },
    });
    const res = await app.request('/v1/echo', {
      method: 'POST',
      headers: AUTH_HEADER,
      body: stream,
      // undici needs this for a streamed request body.
      duplex: 'half',
    });
    expect(res.status).toBe(413);
    expect((await readErrorBody(res)).error.code).toBe('payload_too_large');
    expect(auth.calls).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a body at the limit through', async () => {
    const { app } = setup();
    const res = await app.request('/v1/echo', {
      method: 'POST',
      headers: AUTH_HEADER,
      body: 'x'.repeat(TEST_BODY_LIMIT),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: TEST_BODY_LIMIT });
  });
});

describe('auth (before route)', () => {
  it('rejects with 401 unauthorized and never runs the handler', async () => {
    const { app, handler } = setup();
    const res = await app.request('/v1/echo', { method: 'POST', body: 'hi' });
    expect(res.status).toBe(401);
    expect((await readErrorBody(res)).error.code).toBe('unauthorized');
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs exactly once and then the handler on an authenticated request', async () => {
    const { app, auth, handler } = setup();
    const res = await app.request('/v1/echo', { method: 'POST', headers: AUTH_HEADER, body: 'hi' });
    expect(res.status).toBe(200);
    expect(auth.calls).toBe(1);
    expect(handler).toHaveBeenCalledOnce();
  });
});
