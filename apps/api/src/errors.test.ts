import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { DomainError, INTERNAL_ERROR_MESSAGE } from './errors.js';
import { AUTH_HEADER, buildTestApp, readErrorBody } from './testing/harness.js';

const SECRET = 'connection to db-internal-7 refused: password=hunter2';

/** An app whose /v1 routes throw whatever the test asks for. */
function appThrowing(thrown: () => unknown) {
  return buildTestApp({
    mountRoutes: (api) => {
      api.get('/boom', () => {
        throw thrown();
      });
    },
  });
}

describe('DomainError', () => {
  it('carries status, code, message and details', () => {
    const err = new DomainError(409, 'already_logged', 'Already logged today', {
      day: '2026-11-16',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DomainError');
    expect(err.status).toBe(409);
    expect(err.code).toBe('already_logged');
    expect(err.message).toBe('Already logged today');
    expect(err.details).toEqual({ day: '2026-11-16' });
  });
});

describe('error envelope: DomainError', () => {
  it.each([
    [400, 'bad_input'],
    [403, 'forbidden'],
    [404, 'tower_not_found'],
    [409, 'already_logged'],
    [422, 'tier_out_of_range'],
  ] as const)('maps a thrown DomainError to its own status %i', async (status, code) => {
    const { app } = appThrowing(() => new DomainError(status, code, 'Something specific'));
    const res = await app.request('/v1/boom', { headers: AUTH_HEADER });

    expect(res.status).toBe(status);
    expect(await readErrorBody(res)).toEqual({ error: { code, message: 'Something specific' } });
  });

  it('includes details when given and omits the key when not', async () => {
    const withDetails = appThrowing(
      () => new DomainError(409, 'already_logged', 'Already logged', { entryId: 'e1' })
    );
    const res1 = await withDetails.app.request('/v1/boom', { headers: AUTH_HEADER });
    expect((await readErrorBody(res1)).error.details).toEqual({ entryId: 'e1' });

    const without = appThrowing(() => new DomainError(409, 'already_logged', 'Already logged'));
    const res2 = await without.app.request('/v1/boom', { headers: AUTH_HEADER });
    expect((await readErrorBody(res2)).error).not.toHaveProperty('details');
  });

  it('sends the DomainError headers on the response (e.g. Retry-After on 429)', async () => {
    const { app } = appThrowing(
      () =>
        new DomainError(429, 'too_many_requests', 'Slow down', undefined, { 'Retry-After': '42' })
    );
    const res = await app.request('/v1/boom', { headers: AUTH_HEADER });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect((await readErrorBody(res)).error.code).toBe('too_many_requests');
  });

  it('does not log a DomainError at error level (it is expected behaviour)', async () => {
    const { app, logger } = appThrowing(() => new DomainError(409, 'already_logged', 'nope'));
    await app.request('/v1/boom', { headers: AUTH_HEADER });
    expect(logger.lines.filter((l) => l.level === 'error')).toEqual([]);
  });
});

describe('error envelope: unhandled throws', () => {
  it.each([
    ['an Error', () => new Error(SECRET)],
    ['a TypeError', () => new TypeError(SECRET)],
    ['a string', () => SECRET],
    ['a plain object', () => ({ reason: SECRET })],
    ['undefined', () => undefined],
  ])('maps %s to 500 internal_error without leaking the message', async (_label, thrown) => {
    const { app } = appThrowing(thrown);
    const res = await app.request('/v1/boom', { headers: AUTH_HEADER });

    expect(res.status).toBe(500);
    const raw = await res.clone().text();
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('db-internal-7');
    expect(await readErrorBody(res)).toEqual({
      error: { code: 'internal_error', message: INTERNAL_ERROR_MESSAGE },
    });
  });

  it('logs the real error once at error level with the request ID and stack', async () => {
    const { app, logger } = appThrowing(() => new Error(SECRET));
    const res = await app.request('/v1/boom', { headers: AUTH_HEADER });
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toBeTruthy();

    const errorLines = logger.lines.filter((l) => l.level === 'error' && 'err' in l);
    expect(errorLines).toHaveLength(1);
    const line = errorLines[0]!;
    expect(line.requestId).toBe(requestId);
    expect(line.err).toBeInstanceOf(Error);
    expect((line.err as Error).message).toBe(SECRET);
    expect((line.err as { stack?: string }).stack).toMatch(/Error: /);
  });

  it('does not let a DomainError subclass-lookalike through (duck typing is not enough)', async () => {
    const lookalike = Object.assign(new Error(SECRET), { status: 400, code: 'bad_input' });
    const { app } = appThrowing(() => lookalike);
    const res = await app.request('/v1/boom', { headers: AUTH_HEADER });
    expect(res.status).toBe(500);
    expect((await readErrorBody(res)).error.code).toBe('internal_error');
  });
});

describe('error envelope: Hono HTTPException', () => {
  it('keeps the status and replaces the body with the envelope', async () => {
    const { app } = appThrowing(() => new HTTPException(413, { message: 'too big' }));
    const res = await app.request('/v1/boom', { headers: AUTH_HEADER });
    expect(res.status).toBe(413);
    expect((await readErrorBody(res)).error.code).toBe('payload_too_large');
  });

  it('maps a 400 HTTPException to bad_request', async () => {
    const { app } = appThrowing(() => new HTTPException(400, { message: 'bad' }));
    const res = await app.request('/v1/boom', { headers: AUTH_HEADER });
    expect(res.status).toBe(400);
    expect((await readErrorBody(res)).error.code).toBe('bad_request');
  });
});

describe('error envelope: not found', () => {
  it.each(['/nope', '/v1/nope'])('%s → 404 not_found envelope', async (path) => {
    const { app } = buildTestApp();
    const res = await app.request(path, { headers: AUTH_HEADER });
    expect(res.status).toBe(404);
    expect((await readErrorBody(res)).error.code).toBe('not_found');
  });
});
