import {
  countQualifyingDays,
  listMembershipsForTower,
  listTowerMembers,
  loadTowerHistory,
  type Db,
  type Membership,
  type Tower,
  type TowerPeriod,
} from '@tower-of-habit/db';
import type { PeriodSchedule } from '@tower-of-habit/shared';
import {
  currentRunStart,
  type EvaluationInput,
  type MemberPeriodState,
} from '@tower-of-habit/shared/evaluator';
import { periodWindowFor } from '../towers/periods.js';

/**
 * 2.17/2.19: everything evaluatePeriod needs about a period, read from the
 * database once. The preview and the evaluation job build their input HERE,
 * so no rule about "who counts" or "how many days" is written twice.
 *
 * Members are every non-removed membership (dormant ones included: the
 * evaluator excludes them itself). `excused` is always false in Phase 2:
 * voluntary dormancy endpoints are Phase 3.
 */
export type LoadedEvaluation = {
  input: EvaluationInput;
  window: PeriodSchedule;
  memberships: Membership[];
  /** displayName per membership id, for responses. */
  names: Map<string, string | null>;
  /** Oldest first: the whole ledger, for run bounds and the base block. */
  periods: TowerPeriod[];
};

export async function loadEvaluationInput(
  tx: Db,
  tower: Tower,
  period: TowerPeriod,
  now: Date
): Promise<LoadedEvaluation> {
  const window = periodWindowFor(tower, period.periodStart);
  const { periods } = await loadTowerHistory(tx, tower.id);
  const memberships = (await listMembershipsForTower(tx, tower.id)).filter(
    (m) => m.state !== 'removed'
  );
  const roster = await listTowerMembers(tx, tower.id);
  const names = new Map(roster.map((m) => [m.membershipId, m.displayName]));
  // Roster order (host first) for stable responses.
  const order = new Map(roster.map((m, i) => [m.membershipId, i]));
  memberships.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const members: MemberPeriodState[] = [];
  for (const m of memberships) {
    members.push({
      membershipId: m.id,
      state: m.state,
      qualifyingDays: await countQualifyingDays(
        tx,
        m.habitId,
        period.periodStart,
        period.periodEnd
      ),
      excused: false,
      consecutiveMisses: m.consecutiveMissedPeriods,
    });
  }

  const input: EvaluationInput = {
    now: now.toISOString(),
    tower: {
      periodUnit: tower.periodUnit,
      timezone: tower.timezone,
      deadlineTime: tower.deadlineTime,
      graceWindowMinutes: tower.graceWindowMinutes,
      wobbleLeadMinutes: tower.wobbleLeadMinutes,
      nudgeLeadMinutes: tower.nudgeLeadMinutes,
      weekResetDay: tower.weekResetDay,
      quota: tower.quota,
      height: tower.height,
      runStartDate: currentRunStart(periods),
    },
    window,
    members,
  };
  return { input, window, memberships, names, periods };
}
