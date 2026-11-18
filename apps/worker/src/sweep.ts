import type { Db } from '@tower-of-habit/db';
import type { Logger } from './logger.js';

/**
 * 3.3: find active towers whose latest period is evaluated and whose successor
 * is missing, then create it. Returns the number of periods materialised.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function materialisePeriods(db: Db, now: Date, logger: Logger): Promise<number> {
  throw new Error('not implemented');
}
