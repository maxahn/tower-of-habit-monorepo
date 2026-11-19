import { claimDuePeriods, closeDb, db } from '@tower-of-habit/db';
import { run as runGraphile, type Runner, type TaskList } from 'graphile-worker';
import { config, redactedConfig } from './config.js';
import { createWorkerEvaluator } from './evaluate.js';
import { createExpoPushService } from './expo-push-service.js';
import { startHealthz } from './healthz.js';
import { createJsonLogger } from './logger.js';
import { startTickLoop, type TickLoop } from './loop.js';
import { processNudge } from './nudge.js';
import { checkPushReceipts, deliverPush } from './push.js';
import { materialisePeriods } from './sweep.js';
import { runTick } from './tick.js';
import { processWobble } from './wobble.js';

const logger = createJsonLogger();
logger.info({ config: redactedConfig(config) }, 'worker starting');

const pushService = createExpoPushService(config.EXPO_ACCESS_TOKEN);

const RECEIPT_CHECK_DELAY_MS = 15 * 60 * 1000;

const taskList: TaskList = {
  async send_push(payload, helpers) {
    const { notificationId } = payload as { notificationId: string };
    const result = await deliverPush(db, notificationId, pushService);
    helpers.logger.info(`send_push: ${notificationId} → ${result.outcome}`);
    if (result.receiptMap && Object.keys(result.receiptMap).length > 0) {
      await helpers.addJob(
        'check_push_receipts',
        { receiptMap: result.receiptMap },
        { runAt: new Date(Date.now() + RECEIPT_CHECK_DELAY_MS), maxAttempts: 5 }
      );
    }
  },
  async check_push_receipts(payload, helpers) {
    const { receiptMap } = payload as { receiptMap: Record<string, string> };
    const result = await checkPushReceipts(db, receiptMap, pushService);
    helpers.logger.info(
      `check_push_receipts: checked=${result.checked} invalidated=${result.invalidated}`
    );
  },
  async nudge(payload, helpers) {
    const { periodId } = payload as { periodId: string };
    const count = await processNudge(db, periodId, new Date());
    helpers.logger.info(`nudge: ${periodId} → ${count} notifications`);
  },
  async wobble(payload, helpers) {
    const { periodId } = payload as { periodId: string };
    const count = await processWobble(db, periodId, new Date());
    helpers.logger.info(`wobble: ${periodId} → ${count} notifications`);
  },
};

let runner: Runner | undefined;
try {
  runner = await runGraphile({
    connectionString: config.DATABASE_URL,
    taskList,
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
  const evaluate = createWorkerEvaluator(db, logger);
  loop = startTickLoop({
    intervalMs: config.TICK_INTERVAL_MS,
    tick: () =>
      runTick(new Date(), {
        materialise: (now) => materialisePeriods(db, now, logger),
        claim: (now) => claimDuePeriods(db, now),
        evaluate,
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
