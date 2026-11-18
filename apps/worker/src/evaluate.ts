import type { EvaluateFn } from './tick.js';
import type { Logger } from './logger.js';

export type TxRunner = {
  transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createWorkerEvaluator(db: TxRunner, logger: Logger): EvaluateFn {
  throw new Error('not implemented');
}
