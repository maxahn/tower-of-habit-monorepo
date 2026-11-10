import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  allMembersDormant,
  memberMissedPeriods,
  membersLoggedToday,
} from '@tower-of-habit/shared/testing';
import { db } from '../test-utils.js';
import { useScenarios } from '../testing/vitest.js';
import type { Scenario } from '../testing/persist.js';
import { towerPeriods } from './periods/schema.js';
import { repairTower, verifyTower } from './recompute.js';
import { towers } from './schema.js';
import { TowerNotFoundError } from './towers.js';

const scenarios = useScenarios();

const storedTower = async (id: string) =>
  (await db.select().from(towers).where(eq(towers.id, id)))[0]!;

// The 1.12 done-when, against what persist() actually wrote.
describe('verifyTower over persisted 1.11 scenarios', () => {
  const cases: [string, () => Promise<Scenario>][] = [
    ['30 healthy days', () => scenarios.towerRunningFor(30, { members: 2 })],
    [
      '3 members, day 12, one missed',
      () => scenarios.towerRunningFor(12, { members: 3, traits: [memberMissedPeriods(1)] }),
    ],
    [
      'two misses: dormant',
      () => scenarios.towerRunningFor(8, { members: 2, traits: [memberMissedPeriods(2)] }),
    ],
    [
      'all dormant: hibernating',
      () => scenarios.towerRunningFor(10, { members: 2, traits: [allMembersDormant()] }),
    ],
    ['3 base blocks', () => scenarios.towerWithBaseBlocks(3, { members: 2 })],
    [
      'members logged today',
      () => scenarios.towerRunningFor(6, { members: 2, traits: [membersLoggedToday()] }),
    ],
  ];

  it.each(cases)('agrees with stored: %s', async (_, build) => {
    const s = await build();
    const report = await verifyTower(db, s.tower!.id);
    expect(report.divergences).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('reads the whole ledger, past the 30-period page of listPeriodsForTower', async () => {
    const s = await scenarios.towerRunningFor(45, { members: 1 });
    const report = await verifyTower(db, s.tower!.id);
    expect(report.recomputed.height).toBe(44);
    expect(report.ok).toBe(true);
  });

  it('throws for an unknown tower', async () => {
    await expect(verifyTower(db, crypto.randomUUID())).rejects.toBeInstanceOf(TowerNotFoundError);
  });
});

describe('corruption and repair', () => {
  it('a corrupted height fails verification, and repairTower restores it', async () => {
    const s = await scenarios.towerRunningFor(12, { members: 3 });
    const id = s.tower!.id;
    await db.update(towers).set({ height: 99 }).where(eq(towers.id, id));

    const broken = await verifyTower(db, id);
    expect(broken.ok).toBe(false);
    expect(broken.divergences).toEqual([{ field: 'height', expected: 11, actual: 99 }]);

    const repair = await repairTower(db, id);
    expect(repair).toEqual({
      repaired: true,
      before: { height: 99, currentStreak: 11 },
      after: { height: 11, currentStreak: 11 },
      blockDivergences: [],
      issues: [],
    });
    expect(await storedTower(id)).toMatchObject({ height: 11, currentStreak: 11 });
    expect((await verifyTower(db, id)).ok).toBe(true);
  });

  it('repairs a corrupted current_streak too', async () => {
    const s = await scenarios.towerRunningFor(5);
    await db.update(towers).set({ currentStreak: 0 }).where(eq(towers.id, s.tower!.id));
    expect((await repairTower(db, s.tower!.id)).after).toEqual({ height: 4, currentStreak: 4 });
    expect((await verifyTower(db, s.tower!.id)).ok).toBe(true);
  });

  it('leaves a healthy tower untouched', async () => {
    const s = await scenarios.towerWithBaseBlocks(2, { members: 2 });
    const repair = await repairTower(db, s.tower!.id);
    expect(repair.repaired).toBe(false);
    expect(repair.before).toEqual(repair.after);
  });

  it('reports block divergences but never writes blocks', async () => {
    // Flip a survived period to collapsed mid-run: the ledger now implies an
    // extra block that was never appended, and a shorter current run.
    const s = await scenarios.towerRunningFor(10, { members: 1 });
    const id = s.tower!.id;
    await db
      .update(towerPeriods)
      .set({ outcome: 'collapsed' })
      .where(eq(towerPeriods.id, s.periods[4]!.id));

    const repair = await repairTower(db, id);
    expect(repair.repaired).toBe(true);
    expect(repair.after).toEqual({ height: 4, currentStreak: 4 });
    expect(repair.blockDivergences).toContainEqual({
      field: 'blocks.length',
      expected: 1,
      actual: 0,
    });

    const after = await verifyTower(db, id);
    expect(after.ok).toBe(false);
    expect(after.stored.blocks).toEqual([]);
    expect(after.divergences.every((d) => d.field.startsWith('blocks'))).toBe(true);
  });

  it('throws for an unknown tower', async () => {
    await expect(repairTower(db, crypto.randomUUID())).rejects.toBeInstanceOf(TowerNotFoundError);
  });
});
