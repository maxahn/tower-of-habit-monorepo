import type { Db } from '@tower-of-habit/db';
import { describe, expect, it, vi } from 'vitest';
import { ctxOf, TEST_NOW_HEADER, withTx, type TxRunner } from './context.js';
import { AUTH_HEADER, buildTestApp, readErrorBody } from './testing/harness.js';

/*
 * 2.10: one request, one `now`. The clock is captured once per request by
 * createApp's clock middleware and read through ctxOf / withTx; a handler never
 * calls new Date() itself (eslint enforces that in apps/api/src).
 */

const FIXED = '2026-11-16T10:00:00.000Z';

function appWithNowEcho(allowTestClock: boolean) {
  return buildTestApp({
    clock: { allowTestClock },
    mountRoutes: (api) => {
      api.get('/now', (c) => {
        const ctx = ctxOf(c);
        return c.json({ now: ctx.now.toISOString(), userId: ctx.userId });
      });
      api.get('/now-twice', (c) => {
        const a = ctxOf(c).now;
        const b = ctxOf(c).now;
        return c.json({ same: a === b, equal: a.getTime() === b.getTime() });
      });
    },
  });
}

describe('ctx.now', () => {
  it('is a single instant captured for the request', async () => {
    const { app } = appWithNowEcho(false);
    const before = Date.now();
    const res = await app.request('/v1/now', { headers: AUTH_HEADER });
    const after = Date.now();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { now: string; userId: string };
    const t = Date.parse(body.now);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it('returns the same Date on every read within one request', async () => {
    const { app } = appWithNowEcho(false);
    const res = await app.request('/v1/now-twice', { headers: AUTH_HEADER });
    expect(await res.json()).toEqual({ same: true, equal: true });
  });

  it('ignores X-Test-Now when the test clock is not allowed', async () => {
    const { app } = appWithNowEcho(false);
    const res = await app.request('/v1/now', {
      headers: { ...AUTH_HEADER, [TEST_NOW_HEADER]: FIXED },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { now: string }).now).not.toBe(FIXED);
  });

  it('honours X-Test-Now when ALLOW_TEST_CLOCK is on', async () => {
    const { app } = appWithNowEcho(true);
    const res = await app.request('/v1/now', {
      headers: { ...AUTH_HEADER, [TEST_NOW_HEADER]: FIXED },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { now: string }).now).toBe(FIXED);
  });

  it('rejects a malformed X-Test-Now with 400 invalid_test_clock when allowed', async () => {
    const { app } = appWithNowEcho(true);
    const res = await app.request('/v1/now', {
      headers: { ...AUTH_HEADER, [TEST_NOW_HEADER]: 'yesterday-ish' },
    });
    expect(res.status).toBe(400);
    expect((await readErrorBody(res)).error.code).toBe('invalid_test_clock');
  });

  it('is set on public routes too', async () => {
    const { app } = buildTestApp({
      clock: { allowTestClock: true },
      mountPublicRoutes: (api) =>
        api.get('/public-now', (c) => c.json({ now: ctxOf(c).now.toISOString() })),
    });
    const res = await app.request('/v1/public-now', { headers: { [TEST_NOW_HEADER]: FIXED } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { now: string }).now).toBe(FIXED);
  });
});

/** A TxRunner that records commit/rollback by whether the callback threw. */
function fakeRunner() {
  const state = { committed: 0, rolledBack: 0 };
  const tx = { tag: 'tx' } as unknown as Db;
  const runner: TxRunner = {
    async transaction(fn) {
      try {
        const out = await fn(tx);
        state.committed += 1;
        return out;
      } catch (e) {
        state.rolledBack += 1;
        throw e;
      }
    },
  };
  return { runner, state, tx };
}

describe('withTx', () => {
  it('runs the callback with the transaction and the request context, and commits', async () => {
    const { runner, state, tx } = fakeRunner();
    const seen = vi.fn();
    const { app } = buildTestApp({
      clock: { allowTestClock: true },
      mountRoutes: (api) =>
        api.get('/tx', (c) =>
          withTx(runner, c, async (t, ctx) => {
            seen(t, ctx);
            return c.json({ ok: true });
          })
        ),
    });
    const res = await app.request('/v1/tx', {
      headers: { ...AUTH_HEADER, [TEST_NOW_HEADER]: FIXED },
    });
    expect(res.status).toBe(200);
    expect(state).toEqual({ committed: 1, rolledBack: 0 });
    expect(seen).toHaveBeenCalledOnce();
    const [t, ctx] = seen.mock.calls[0] as [Db, ReturnType<typeof ctxOf>];
    expect(t).toBe(tx);
    expect(ctx.now.toISOString()).toBe(FIXED);
    expect(typeof ctx.userId).toBe('string');
    expect(typeof ctx.requestId).toBe('string');
  });

  it('rolls back when the callback throws, and the error still reaches onError', async () => {
    const { runner, state } = fakeRunner();
    const { app } = buildTestApp({
      mountRoutes: (api) =>
        api.get('/tx-boom', (c) =>
          withTx(runner, c, async () => {
            throw new Error('nope');
          })
        ),
    });
    const res = await app.request('/v1/tx-boom', { headers: AUTH_HEADER });
    expect(res.status).toBe(500);
    expect(state).toEqual({ committed: 0, rolledBack: 1 });
  });
});
