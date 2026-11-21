import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '../schema.js';
import { db } from '../test-utils.js';
import { useScenarios } from '../testing/vitest.js';
import { listQualifyingDaysInRange } from '../habits/entries/entries.js';
import { entries } from '../habits/entries/schema.js';
import { lockPeriodForEvaluation } from './periods/periods.js';
import { towers } from './schema.js';
import { closeTowerRun, extendTowerRun, lockTower } from './towers.js';

/*
 * 2.19: the claim and the counters the evaluation job writes.
 */

const scenarios = useScenarios();

// A second connection, so two transactions can really contend.
const other = postgres(process.env.DATABASE_URL!, { max: 1 });
const db2 = drizzle(other, { schema, casing: 'snake_case' }) as unknown as typeof db;
afterAll(async () => {
  await other.end();
});

describe('lockPeriodForEvaluation (FOR UPDATE SKIP LOCKED)', () => {
  it('returns the row to the first claimant and undefined to a concurrent one', async () => {
    const s = await scenarios.towerRunningFor(2, { members: 1 });
    const period = s.periods.at(-1)!;
    await db.transaction(async (tx) => {
      const mine = await lockPeriodForEvaluation(tx, period.id, s.tower!.id);
      expect(mine?.id).toBe(period.id);
      const theirs = await db2.transaction((tx2) =>
        lockPeriodForEvaluation(tx2, period.id, s.tower!.id)
      );
      expect(theirs).toBeUndefined();
    });
    // Released with the transaction.
    const again = await db.transaction((tx) => lockPeriodForEvaluation(tx, period.id, s.tower!.id));
    expect(again?.id).toBe(period.id);
  });

  it('is undefined for a period of another tower or an unknown id', async () => {
    const s = await scenarios.towerRunningFor(2, { members: 1 });
    const period = s.periods.at(-1)!;
    expect(await lockPeriodForEvaluation(db, period.id, crypto.randomUUID())).toBeUndefined();
    expect(await lockPeriodForEvaluation(db, crypto.randomUUID(), s.tower!.id)).toBeUndefined();
  });
});

describe('tower run counters', () => {
  it('extendTowerRun adds one to height and streak; closeTowerRun resets both', async () => {
    const s = await scenarios.towerRunningFor(3, { members: 1 }); // height 2
    const id = s.tower!.id;
    expect(await extendTowerRun(db, id)).toMatchObject({ height: 3, currentStreak: 3 });
    expect(await closeTowerRun(db, id)).toMatchObject({ height: 0, currentStreak: 0 });
    const [row] = await db.select().from(towers).where(eq(towers.id, id));
    expect(row).toMatchObject({ height: 0, currentStreak: 0 });
  });

  it('lockTower returns the locked row, or undefined for an unknown id', async () => {
    const s = await scenarios.towerRunningFor(1, { members: 1 });
    await db.transaction(async (tx) => {
      expect((await lockTower(tx, s.tower!.id))?.id).toBe(s.tower!.id);
    });
    expect(await lockTower(db, crypto.randomUUID())).toBeUndefined();
  });
});

describe('listQualifyingDaysInRange', () => {
  it('returns each credited day with the tier reached, inside the range only', async () => {
    const s = await scenarios.standaloneHabit({ loggedDays: 4, type: 'tiered' });
    const h = s.habits[0]!;
    const dates = s.entries.map((e) => e.localDate).sort();
    await db.update(entries).set({ tierReached: 1 }).where(eq(entries.id, s.entries[1]!.id));
    const rows = await listQualifyingDaysInRange(db, h.id, dates[1]!, dates[2]!);
    expect(rows.map((r) => r.localDate)).toEqual([dates[1], dates[2]]);
    expect(rows.find((r) => r.localDate === s.entries[1]!.localDate)?.tierIndex).toBe(1);
  });
});
