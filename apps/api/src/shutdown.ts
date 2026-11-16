import type { Logger } from './logger.js';

/**
 * 2.8: graceful shutdown. On SIGTERM:
 *   1. isDraining() flips to true (readyz → 503, so Caddy stops routing here);
 *   2. server.close(): stop accepting connections, let in-flight requests finish;
 *   3. onDrained(): close Postgres and Redis;
 *   4. exit(0).
 * If 2–3 haven't finished within timeoutMs: server.closeAllConnections(),
 * log it, exit(1). A second signal while draining is ignored.
 */

/** The slice of node:http Server this needs, so tests can pass a real one. */
export type ClosableServer = {
  close(callback?: (err?: Error) => void): unknown;
  closeAllConnections(): void;
  /** Keep-alive sockets idle after their last response would hold close() open. */
  closeIdleConnections?(): void;
};

export type GracefulShutdownOptions = {
  server: ClosableServer;
  logger: Logger;
  timeoutMs: number;
  /** Release external resources once no request can use them. */
  onDrained: () => Promise<void>;
  /** process.exit in production; a spy in tests. */
  exit: (code: number) => void;
};

export type GracefulShutdown = {
  /** Resolves after exit has been called. Idempotent. */
  shutdown(signal: string): Promise<void>;
  isDraining(): boolean;
};

const IDLE_SWEEP_MS = 100;

export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const { server, logger, timeoutMs, onDrained, exit } = options;
  let running: Promise<void> | undefined;

  async function run(signal: string): Promise<void> {
    logger.info({ signal, timeoutMs }, 'shutdown: draining');
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sweep = server.closeIdleConnections
      ? setInterval(() => server.closeIdleConnections?.(), IDLE_SWEEP_MS)
      : undefined;

    const drain = (async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
      if (timedOut) return 'timeout' as const;
      await onDrained();
      return 'drained' as const;
    })();
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
      const outcome = await Promise.race([drain, timeout]);
      if (outcome === 'timeout') {
        timedOut = true;
        logger.error(
          { signal, timeoutMs },
          'shutdown: drain timed out, forcing connections closed'
        );
        server.closeAllConnections();
        exit(1);
        return;
      }
      logger.info({ signal }, 'shutdown: drained');
      exit(0);
    } catch (err) {
      logger.error({ signal, err }, 'shutdown: failed');
      exit(1);
    } finally {
      clearTimeout(timer);
      clearInterval(sweep);
      // A drain that loses the race may still reject later; it is already handled.
      drain.catch(() => undefined);
    }
  }

  return {
    shutdown(signal) {
      running ??= run(signal);
      return running;
    },
    isDraining: () => running !== undefined,
  };
}

export type SignalSource = {
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
};

/** Wires SIGTERM and SIGINT to shutdown. `source` is process in production. */
export function installSignalHandlers(source: SignalSource, shutdown: GracefulShutdown): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    source.on(signal, () => void shutdown.shutdown(signal));
  }
}
