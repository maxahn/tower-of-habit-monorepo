import type { Logger } from './logger.js';
import type { TickReport } from './tick.js';

export type TickLoop = {
  stop(): Promise<void>;
};

export function startTickLoop(opts: {
  intervalMs: number;
  tick: () => Promise<TickReport>;
  logger: Logger;
}): TickLoop {
  const { intervalMs, tick, logger } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<TickReport> | null = null;
  let stopped = false;

  async function fire(): Promise<void> {
    if (stopped) return;
    if (running) {
      logger.warn({}, 'tick still in progress, skipping');
      scheduleNext();
      return;
    }
    running = tick();
    try {
      const report = await running;
      if (report.claimed > 0) {
        logger.info(
          {
            claimed: report.claimed,
            evaluated: report.evaluated,
            errored: report.errored,
            durationMs: report.durationMs,
          },
          'tick complete'
        );
      }
    } catch (err) {
      logger.error({ err }, 'tick failed');
    } finally {
      running = null;
      scheduleNext();
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(fire, intervalMs);
  }

  // Start the first tick immediately
  timer = setTimeout(fire, 0);

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (running) await running.catch(() => undefined);
    },
  };
}
