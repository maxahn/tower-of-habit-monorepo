import { asc, eq } from 'drizzle-orm';
import {
  verifyTowerState,
  type RecomputedTowerState,
  type StoredTowerState,
  type TowerDivergence,
} from '@tower-of-habit/shared/evaluator';
import type { Db } from '../client.js';
import { listBaseBlocksForTower } from './blocks/blocks.js';
import { towerPeriods } from './periods/schema.js';
import { towers } from './schema.js';
import { TowerNotFoundError, type Tower } from './towers.js';
import type { TowerPeriod } from './periods/periods.js';
import type { BaseBlock } from './blocks/blocks.js';

/**
 * 1.12 at the database edge: load a tower's ledger and run the pure recompute
 * (@tower-of-habit/shared/evaluator) over it. See recompute.ts there for what
 * is derived and what is trusted.
 */

export type TowerHistory = {
  tower: Tower;
  /** Every period, oldest first. Not listPeriodsForTower: that one is capped. */
  periods: TowerPeriod[];
  /** Oldest first: blocks[0] is ordinal 1. */
  blocks: BaseBlock[];
};

export type TowerVerificationReport = {
  ok: boolean;
  recomputed: RecomputedTowerState;
  stored: StoredTowerState;
  divergences: TowerDivergence[];
};

export async function loadTowerHistory(db: Db, towerId: string): Promise<TowerHistory> {
  const [tower] = await db.select().from(towers).where(eq(towers.id, towerId));
  if (!tower) throw new TowerNotFoundError(towerId);
  return loadLedger(db, tower);
}

async function loadLedger(db: Db, tower: Tower): Promise<TowerHistory> {
  const periods = await db
    .select()
    .from(towerPeriods)
    .where(eq(towerPeriods.towerId, tower.id))
    .orderBy(asc(towerPeriods.periodStart));
  const blocks = await listBaseBlocksForTower(db, tower.id);
  return { tower, periods, blocks };
}

function verify(history: TowerHistory): TowerVerificationReport {
  const stored: StoredTowerState = {
    height: history.tower.height,
    currentStreak: history.tower.currentStreak,
    blocks: history.blocks,
  };
  return { ...verifyTowerState(history.periods, stored), stored };
}

/**
 * Does the stored height, current_streak and block stack match what the period
 * ledger implies? The Phase 3 oracle: `expect((await verifyTower(db, id)).ok)`.
 */
export async function verifyTower(db: Db, towerId: string): Promise<TowerVerificationReport> {
  return verify(await loadTowerHistory(db, towerId));
}

export type TowerRepairReport = {
  /** True iff height or current_streak was rewritten. */
  repaired: boolean;
  before: { height: number; currentStreak: number };
  after: { height: number; currentStreak: number };
  /**
   * Block divergences, REPORTED, NEVER WRITTEN. base_blocks is append-only and
   * its rosters are frozen snapshots (§5); fixing the stack is a human call.
   */
  blockDivergences: TowerDivergence[];
  /** Ledger anomalies from the recompute. Reported, not acted on. */
  issues: string[];
};

/**
 * Rewrite a tower's height and current_streak from its period ledger.
 *
 * Locks the tower row first (FOR UPDATE), so it serialises against an
 * evaluator transaction writing the same columns rather than racing it. A
 * healthy tower is left untouched.
 *
 * Writes towers directly: updateTower refuses evaluator-owned columns, which is
 * right for application code and exactly what a repair has to get round.
 */
export async function repairTower(db: Db, towerId: string): Promise<TowerRepairReport> {
  return db.transaction(async (tx) => {
    const [tower] = await tx.select().from(towers).where(eq(towers.id, towerId)).for('update');
    if (!tower) throw new TowerNotFoundError(towerId);

    const report = verify(await loadLedger(tx, tower));
    const before = { height: tower.height, currentStreak: tower.currentStreak };
    const after = {
      height: report.recomputed.height,
      currentStreak: report.recomputed.currentStreak,
    };
    const repaired = before.height !== after.height || before.currentStreak !== after.currentStreak;
    if (repaired) await tx.update(towers).set(after).where(eq(towers.id, towerId));

    return {
      repaired,
      before,
      after,
      blockDivergences: report.divergences.filter((d) => d.field.startsWith('blocks')),
      issues: report.recomputed.issues,
    };
  });
}
