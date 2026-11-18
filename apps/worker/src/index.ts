import { claimDuePeriods, closeDb, db } from '@tower-of-habit/db';
import { run as runGraphile, type Runner } from 'graphile-worker';
import { config, redactedConfig } from './config.js';
import { startHealthz } from './healthz.js';
import { createJsonLogger } from './logger.js';
import { startTickLoop, type TickLoop } from './loop.js';
import { runTick } from './tick.js';

const logger = createJsonLogger();
logger.info({ config: redactedConfig(config) }, 'worker starting');

// Graphile Worker — creates its schema on first run, idles with no tasks.
// Task handlers are registered in later tickets (3.13+).
let runner: Runner | undefined;
try {
  runner = await runGraphile({
    connectionString: config.DATABASE_URL,
    taskList: {},
    noHandleSignals: true,
  });
  logger.info({}, 'graphile-worker started');
} catch (err) {
  logger.error({ err }, 'graphile-worker failed to start');
  process.exit(1);
}

const healthzServer = startHealthz(config.PORT);
logger.info({ port: config.PORT }, 'healthz listening');

let loop: TickLoop | undefined;
if (config.TICK_ENABLED) {
  loop = startTickLoop({
    intervalMs: config.TICK_INTERVAL_MS,
    tick: () =>
      runTick(new Date(), {
        claim: (now) => claimDuePeriods(db, now),
        evaluate: async (towerId, periodId, now) => {
          logger.warn(
            { towerId, periodId, now: now.toISOString() },
            'evaluate not wired yet (3.4)'
          );
        },
        logger,
      }),
    logger,
  });
  logger.info({ intervalMs: config.TICK_INTERVAL_MS }, 'tick loop started');
} else {
  logger.info({}, 'tick loop disabled (TICK_ENABLED=false)');
}

// Graceful shutdown
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown: draining');

  const hardTimeout = setTimeout(() => {
    logger.error({ signal }, 'shutdown: timed out, forcing exit');
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);

  try {
    if (loop) await loop.stop();
    if (runner) await runner.stop();
    await new Promise<void>((resolve, reject) =>
      healthzServer.close((err) => (err ? reject(err) : resolve()))
    );
    await closeDb();
    logger.info({ signal }, 'shutdown: complete');
    clearTimeout(hardTimeout);
    process.exit(0);
  } catch (err) {
    logger.error({ signal, err }, 'shutdown: failed');
    clearTimeout(hardTimeout);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
