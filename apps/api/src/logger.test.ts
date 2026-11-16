import { describe, expect, it } from 'vitest';
import { createJsonLogger } from './logger.js';
import { AUTH_HEADER, buildTestApp } from './testing/harness.js';

describe('createJsonLogger', () => {
  function capture() {
    const lines: string[] = [];
    return { lines, logger: createJsonLogger((l) => lines.push(l)) };
  }

  it('writes one parseable JSON line per call with level, time and msg', () => {
    const { lines, logger } = capture();
    logger.info({ requestId: 'r1' }, 'hello');
    logger.warn({}, 'careful');
    logger.error({ n: 1 }, 'bad');

    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.level)).toEqual(['info', 'warn', 'error']);
    expect(parsed[0]).toMatchObject({ requestId: 'r1', msg: 'hello' });
    expect(Number.isNaN(Date.parse(parsed[0].time))).toBe(false);
    for (const l of lines) expect(l).not.toContain('\n');
  });

  it('serialises an Error with name, message and stack', () => {
    const { lines, logger } = capture();
    logger.error({ err: new TypeError('nope') }, 'failed');
    const { err } = JSON.parse(lines[0]!);
    expect(err).toMatchObject({ name: 'TypeError', message: 'nope' });
    expect(err.stack).toContain('TypeError: nope');
  });
});

describe('requestLogger', () => {
  function setup() {
    return buildTestApp({
      mountRoutes: (api) => {
        api.get('/ok', (c) => c.json({ ok: true }));
        api.get('/boom', () => {
          throw new Error('kaboom');
        });
      },
    });
  }

  it('logs one line per request with requestId, method, path, status and durationMs', async () => {
    const { app, logger } = setup();
    const res = await app.request('/v1/ok?secret=1', { headers: AUTH_HEADER });

    const lines = logger.lines.filter((l) => l.path !== undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      requestId: res.headers.get('x-request-id'),
      method: 'GET',
      path: '/v1/ok',
      status: 200,
      durationMs: expect.any(Number),
    });
  });

  it.each([
    ['/v1/ok', 200, 'info'],
    ['/v1/missing', 404, 'warn'],
    ['/v1/boom', 500, 'error'],
  ])('logs %s (%i) at %s', async (path, status, level) => {
    const { app, logger } = setup();
    await app.request(path, { headers: AUTH_HEADER });
    const line = logger.lines.find((l) => l.path === path);
    expect(line).toMatchObject({ status, level });
  });
});
