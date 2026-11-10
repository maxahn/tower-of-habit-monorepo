import { inArray } from 'drizzle-orm';
import { afterEach } from 'vitest';
import {
  standaloneHabit,
  towerRunningFor,
  towerWithBaseBlocks,
  type ScenarioPlan,
  type StandaloneHabitOptions,
  type TowerScenarioOptions,
} from '@tower-of-habit/shared/testing';
import { users } from '../schema.js';
import { towers } from '../towers/schema.js';
import { db } from '../test-utils.js';
import { persist, type Scenario } from './persist.js';

/**
 * The default instant scenarios describe: noon in Edmonton (MDT), a Tuesday.
 * Fixed, so a test that names a date can rely on it.
 */
export const SCENARIO_NOW = new Date('2026-10-27T18:00:00Z');

type WithNow<T extends { now: Date }> = Omit<T, 'now'> & { now?: Date };

/** A fresh random seed per scenario, so reruns against one database never share ids. */
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

/**
 * Scenario builders that persist, with cleanup after each test.
 *
 *   const scenarios = useScenarios();
 *   const s = await scenarios.towerRunningFor(12, { members: 3, traits: [memberMissedPeriods(1)] });
 *
 * Call it at module or describe scope, like useTestOwner. afterEach deletes the
 * towers it created first (cascading memberships, periods, blocks and tower
 * notifications), then the users (cascading habits, tiers, entries, push
 * tokens). That order matters: memberships have no on-delete action on users
 * or habits, so a user can't go while a membership points at it.
 */
export function useScenarios(defaults: { now?: Date } = {}) {
  const now = defaults.now ?? SCENARIO_NOW;
  const towerIds = new Set<string>();
  const userIds = new Set<string>();

  afterEach(async () => {
    if (towerIds.size) await db.delete(towers).where(inArray(towers.id, [...towerIds]));
    if (userIds.size) await db.delete(users).where(inArray(users.id, [...userIds]));
    towerIds.clear();
    userIds.clear();
  });

  async function save(plan: ScenarioPlan): Promise<Scenario> {
    if (plan.tower) towerIds.add(plan.tower.id);
    for (const u of plan.users) userIds.add(u.id);
    return persist(db, plan);
  }

  return {
    now,
    persist: save,
    towerRunningFor: (days: number, opts: WithNow<TowerScenarioOptions> = {}) =>
      save(towerRunningFor(days, { seed: randomSeed(), ...opts, now: opts.now ?? now })),
    towerWithBaseBlocks: (
      n: number,
      opts: WithNow<TowerScenarioOptions & { days?: number }> = {}
    ) => save(towerWithBaseBlocks(n, { seed: randomSeed(), ...opts, now: opts.now ?? now })),
    standaloneHabit: (opts: WithNow<StandaloneHabitOptions> = {}) =>
      save(standaloneHabit({ seed: randomSeed(), ...opts, now: opts.now ?? now })),
  };
}
