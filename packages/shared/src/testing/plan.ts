import type { BlockRoster } from '../schemas/index.js';
import type { LocalDate } from '../time/local-date.js';

/**
 * A scenario as plain data: every row a test needs, with no database and no
 * clock behind it.
 *
 * These mirror the insert shapes in @tower-of-habit/db, restated here because
 * this package may not import that one (eslint firewall). The db side's
 * persist() checks each record against `typeof table.$inferInsert` with
 * `satisfies`, so a drifted column fails typecheck there rather than at
 * runtime.
 *
 * Unlike the services, a plan carries the evaluator- and lifecycle-owned
 * columns (period outcomes, tower height, membership state). That is the
 * point: see derive.ts.
 */

export type HabitType = 'binary' | 'numeric' | 'tiered';
export type MembershipState = 'active' | 'at_risk' | 'dormant' | 'removed';
export type DormancyReason = 'consecutive_miss' | 'backstop' | 'voluntary';
export type PeriodState = 'pending' | 'evaluating' | 'evaluated';
export type PeriodOutcome = 'survived' | 'collapsed' | 'hibernated' | 'freebie';

export type UserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
};

export type TierSpec = { tierIndex: number; label: string; thresholdValue: number | null };

export type HabitRecord = {
  id: string;
  ownerId: string;
  name: string;
  type: HabitType;
  unit: string | null;
  lifecycle: 'active';
  startedAt: Date;
  /** Empty unless type is 'tiered', which always includes tier 0. */
  tiers: TierSpec[];
};

export type TowerRecord = {
  id: string;
  hostId: string;
  name: string;
  deadlineTime: string;
  timezone: string;
  graceWindowMinutes: number;
  lifecycle: 'active';
  startedAt: Date;
  height: number;
  currentStreak: number;
};

export type MembershipRecord = {
  id: string;
  towerId: string;
  userId: string;
  habitId: string;
  state: MembershipState;
  consecutiveMissedPeriods: number;
  lastQualifyingDate: LocalDate | null;
  dormantSince: Date | null;
  dormancyReason: DormancyReason | null;
  joinedAt: Date;
};

export type PeriodRecord = {
  id: string;
  towerId: string;
  periodStart: LocalDate;
  periodEnd: LocalDate;
  deadlineAt: Date;
  evaluateAt: Date;
  state: PeriodState;
  outcome: PeriodOutcome | null;
  evaluatedAt: Date | null;
  claimedAt: Date | null;
  attempts: number;
};

export type EntryRecord = {
  id: string;
  habitId: string;
  localDate: LocalDate;
  loggedAt: Date;
  tierReached: number;
  numericValue: number | null;
  countsTowardQuota: boolean;
};

/** No ordinal: array order is stack order, and the db allocates ordinals. */
export type BlockRecord = {
  towerId: string;
  runStartDate: LocalDate;
  runEndDate: LocalDate;
  blockHeight: number;
  roster: BlockRoster;
};

/** One member of a tower scenario, by role. The records are the plan's own. */
export type ScenarioMember = {
  user: UserRecord;
  habit: HabitRecord;
  membership: MembershipRecord;
};

export type ScenarioPlan = {
  /** The instant the scenario describes. Pass it on to anything under test. */
  now: Date;
  seed: number;
  /** May include users another plan also lists; persist() tolerates that. */
  users: UserRecord[];
  habits: HabitRecord[];
  tower: TowerRecord | null;
  /** Same order as `members`. */
  memberships: MembershipRecord[];
  /** Oldest first. */
  periods: PeriodRecord[];
  entries: EntryRecord[];
  /** Oldest first: blocks[0] is ordinal 1. */
  blocks: BlockRecord[];
  members: ScenarioMember[];
};
