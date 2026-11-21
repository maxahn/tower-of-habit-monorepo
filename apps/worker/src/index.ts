import { claimDuePeriods, closeDb, db, oldestPendingPeriodAge } from '@tower-of-habit/db';
import { run as runGraphile, type CronItem, type Runner, type TaskList } from 'graphile-worker';
import { sweepBackstop } from './backstop.js';
import { config, redactedConfig } from './config.js';
import { deliverLoginEmail } from './email.js';
import { createWorkerEvaluator } from './evaluate.js';
import { createExpoPushService } from './expo-push-service.js';
import { createResendEmailService } from './resend-email-service.js';
import { startHealthz } from './healthz.js';
import { createHealthchecksHeartbeat, createNoopHeartbeat } from './heartbeat.js';
import { createJsonLogger } from './logger.js';
import { startTickLoop, type TickLoop } from './loop.js';
import { collectAndLogMetrics, failedJobCount } from './metrics.js';
import { processNudge } from './nudge.js';
import { checkPushReceipts, deliverPush } from './push.js';
import { materialisePeriods } from './sweep.js';
import { runTick } from './tick.js';
import { processWobble } from './wobble.js';

const logger = createJsonLogger();
logger.info({ config: redactedConfig(config) }, 'worker starting');

const pushService = createExpoPushService(config.EXPO_ACCESS_TOKEN);
const emailService = config.RESEND_API_KEY
  ? createResendEmailService(config.RESEND_API_KEY)
  : undefined;

const RECEIPT_CHECK_DELAY_MS = 15 * 60 * 1000;

const taskList: TaskList = {
  async send_email(payload, helpers) {
    const { email, code } = payload as { email: string; code: string };
    if (!emailService) throw new Error('RESEND_API_KEY not configured');
    if (!config.EMAIL_FROM) throw new Error('EMAIL_FROM not configured');
    await deliverLoginEmail(emailService, { email, code }, config.EMAIL_FROM);
    helpers.logger.info(`send_email: ${email} → sent`);
  },
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
  async backstop_sweep(_payload, helpers) {
    const count = await sweepBackstop(db, new Date());
    if (count > 0) helpers.logger.info(`backstop_sweep: ${count} transitions`);
  },
};

const cronItems: CronItem[] = [
  { task: 'backstop_sweep', match: '17 * * * *', options: { backfillPeriod: 0 } },
];

let runner: Runner | undefined;
try {
  runner = await runGraphile({
    connectionString: config.DATABASE_URL,
    taskList,
    parsedCronItems: (await import('graphile-worker')).parseCronItems(cronItems),
    noHandleSignals: true,
  });
  logger.info({}, 'graphile-worker started');
} catch (err) {
  logger.error({ err }, 'graphile-worker failed to start');
  process.exit(1);
}

const healthzServer = startHealthz(config.PORT);
logger.info({ port: config.PORT }, 'healthz listening');

const heartbeat = config.HEALTHCHECKS_URL
  ? createHealthchecksHeartbeat(config.HEALTHCHECKS_URL)
  : createNoopHeartbeat();

const metricsDeps = { oldestPendingPeriodAge, failedJobCount, logger };

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
    heartbeat,
    onSuccess: async (report) => {
      logger.info({ report }, 'tick metrics');
      await collectAndLogMetrics(db, new Date(), metricsDeps);
    },
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
