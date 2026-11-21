import type { Db } from '@tower-of-habit/db';
import { sql } from 'drizzle-orm';
import type { Logger } from './logger.js';

export type TickMetrics = {
  oldestPendingAge: number | null;
  failedJobCount: number;
};

const STALE_THRESHOLD_SECONDS = 15 * 60;

export type MetricsDeps = {
  oldestPendingPeriodAge: (db: Db, now: Date) => Promise<number | null>;
  failedJobCount: (db: Db) => Promise<number>;
  logger: Logger;
};

export async function failedJobCount(db: Db): Promise<number> {
  try {
    const rows = await db.execute(
      sql`SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE attempts >= max_attempts AND last_error IS NOT NULL`
    );
    return (rows[0] as { count: number } | undefined)?.count ?? 0;
  } catch {
    return 0;
  }
}

export async function collectAndLogMetrics(
  db: Db,
  now: Date,
  deps: MetricsDeps
): Promise<TickMetrics> {
  const [oldestPendingAge, failed] = await Promise.all([
    deps.oldestPendingPeriodAge(db, now),
    deps.failedJobCount(db),
  ]);

  const metrics: TickMetrics = { oldestPendingAge, failedJobCount: failed };

  if (oldestPendingAge != null && oldestPendingAge > STALE_THRESHOLD_SECONDS) {
    deps.logger.warn(
      { oldestPendingAge },
      `oldest pending period is ${Math.round(oldestPendingAge / 60)}m behind`
    );
  }

  if (failed > 0) {
    deps.logger.warn({ failedJobCount: failed }, `${failed} permanently failed graphile jobs`);
  }

  return metrics;
}
