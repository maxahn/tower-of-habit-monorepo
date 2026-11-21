import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGracefulShutdown,
  installSignalHandlers,
  type GracefulShutdown,
} from './shutdown.js';
import { createMemoryLogger } from './testing/harness.js';

/** A promise plus its resolver. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.closeAllConnections();
});

/** A real HTTP server on an ephemeral port with a /slow route held open by a gate. */
async function startServer() {
  const gate = deferred();
  const entered = deferred();
  const app = new Hono();
  app.get('/fast', (c) => c.text('fast'));
  app.get('/slow', async (c) => {
    entered.resolve();
    await gate.promise;
    return c.text('slow done');
  });

  const listening = deferred<AddressInfo>();
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
    listening.resolve(info)
  ) as Server;
  servers.push(server);
  const { port } = await listening.promise;
  return { server, gate, entered, url: `http://127.0.0.1:${port}` };
}

function setup(server: Server, timeoutMs = 2_000) {
  const order: string[] = [];
  const logger = createMemoryLogger();
  const onDrained = vi.fn(async () => {
    order.push('drained');
  });
  const exit = vi.fn((code: number) => {
    order.push(`exit:${code}`);
  });
  const shutdown = createGracefulShutdown({ server, logger, timeoutMs, onDrained, exit });
  return { shutdown, onDrained, exit, order, logger };
}

describe('createGracefulShutdown', () => {
  it('lets an in-flight request finish, then drains, then exits 0', async () => {
    const { server, gate, entered, url } = await startServer();
    const { shutdown, onDrained, exit, order } = setup(server);

    const inFlight = fetch(`${url}/slow`).then(async (r) => {
      order.push('response');
      return { status: r.status, body: await r.text() };
    });
    await entered.promise;

    const done = shutdown.shutdown('SIGTERM');
    expect(shutdown.isDraining()).toBe(true);

    // Still waiting on the in-flight request: nothing released yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(onDrained).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    gate.resolve();
    expect(await inFlight).toEqual({ status: 200, body: 'slow done' });
    await done;

    expect(order).toEqual(['response', 'drained', 'exit:0']);
  });

  it('refuses new connections once draining', async () => {
    const { server, gate, entered, url } = await startServer();
    const { shutdown } = setup(server);

    const inFlight = fetch(`${url}/slow`);
    await entered.promise;
    const done = shutdown.shutdown('SIGTERM');

    await expect(fetch(`${url}/fast`)).rejects.toThrow();

    gate.resolve();
    await inFlight;
    await done;
  });

  it('exits 0 promptly when nothing is in flight', async () => {
    const { server } = await startServer();
    const { shutdown, exit, onDrained } = setup(server);
    await shutdown.shutdown('SIGTERM');
    expect(onDrained).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('forces connections closed and exits 1 when the drain outlasts the timeout', async () => {
    const { server, entered, url } = await startServer();
    const closeAll = vi.spyOn(server, 'closeAllConnections');
    const { shutdown, exit, logger } = setup(server, 50);

    const inFlight = fetch(`${url}/slow`).catch((e: unknown) => e);
    await entered.promise;

    await shutdown.shutdown('SIGTERM');
    expect(closeAll).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(logger.lines.some((l) => l.level === 'error')).toBe(true);
    await inFlight;
  });

  it('exits 1 when onDrained rejects', async () => {
    const { server } = await startServer();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      server,
      logger: createMemoryLogger(),
      timeoutMs: 1_000,
      onDrained: async () => {
        throw new Error('redis quit failed');
      },
      exit,
    });
    await shutdown.shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('ignores a second signal while draining', async () => {
    const { server, gate, entered, url } = await startServer();
    const { shutdown, onDrained, exit } = setup(server);

    const inFlight = fetch(`${url}/slow`);
    await entered.promise;
    const first = shutdown.shutdown('SIGTERM');
    const second = shutdown.shutdown('SIGTERM');

    gate.resolve();
    await inFlight;
    await Promise.all([first, second]);
    expect(onDrained).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('is not draining before a signal', async () => {
    const { server } = await startServer();
    expect(setup(server).shutdown.isDraining()).toBe(false);
  });
});

describe('installSignalHandlers', () => {
  function fakeShutdown(): GracefulShutdown & { signals: string[] } {
    const signals: string[] = [];
    return {
      signals,
      isDraining: () => signals.length > 0,
      shutdown: async (signal) => {
        signals.push(signal);
      },
    };
  }

  it.each(['SIGTERM', 'SIGINT'] as const)('starts shutdown on %s', (signal) => {
    const source = new EventEmitter();
    const shutdown = fakeShutdown();
    installSignalHandlers(source, shutdown);

    source.emit(signal);
    expect(shutdown.signals).toEqual([signal]);
  });

  it('does nothing until a signal arrives', () => {
    const source = new EventEmitter();
    const shutdown = fakeShutdown();
    installSignalHandlers(source, shutdown);
    expect(shutdown.signals).toEqual([]);
    expect(source.listenerCount('SIGTERM')).toBe(1);
  });
});
