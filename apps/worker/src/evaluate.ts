import { createEvaluator } from '@tower-of-habit/api/src/evaluation/service.js';
import type { Db } from '@tower-of-habit/db';
import type { EvaluateFn } from './tick.js';
import type { Logger } from './logger.js';

export type TxRunner = {
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
};

export function createWorkerEvaluator(db: TxRunner, logger: Logger): EvaluateFn {
  return createEvaluator(db, logger);
}
