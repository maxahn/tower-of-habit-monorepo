import type { Db } from '@tower-of-habit/db';
import type { Logger } from './logger.js';

export type TickMetrics = {
  oldestPendingAge: number | null;
  failedJobCount: number;
};

export type MetricsDeps = {
  oldestPendingPeriodAge: (db: Db, now: Date) => Promise<number | null>;
  failedJobCount: (db: Db) => Promise<number>;
  logger: Logger;
};

export async function failedJobCount(db: Db): Promise<number> {
  void db;
  throw new Error('not implemented');
}

export async function collectAndLogMetrics(
  db: Db,
  now: Date,
  deps: MetricsDeps
): Promise<TickMetrics> {
  void db;
  void now;
  void deps;
  throw new Error('not implemented');
}
