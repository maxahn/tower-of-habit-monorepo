import {
  DEFAULT_GRACE_WINDOW_MINUTES,
  parseDeadlineMinutes,
  type LocalDate,
} from '../time/local-date.js';
import { wallClockToInstant } from '../time/wall-clock.js';
import { idGen, type IdGen } from './ids.js';
import type {
  EntryRecord,
  HabitRecord,
  HabitType,
  MembershipRecord,
  TierSpec,
  TowerRecord,
  UserRecord,
} from './plan.js';

/**
 * Must equal DEFAULT_DEADLINE_TIME in @tower-of-habit/db (towers/schema.ts).
 * Duplicated for the same reason as ROSTER_DISPLAY_NAME_MAX; persist.test.ts
 * asserts the two agree.
 */
export const FACTORY_DEADLINE_TIME = '22:00';
// Stays Edmonton through tzdata 2026c (Alberta permanent UTC-6): the zone is
// still valid, only its rules changed. See src/time/TZDATA.md.
export const FACTORY_TIMEZONE = 'America/Edmonton';
/** Not a real hash. Seed and test users can't log in until auth lands. */
export const FACTORY_PASSWORD_HASH = 'factory-not-a-real-hash';

const DISPLAY_NAMES = ['Sam', 'Alex', 'Riley', 'Jordan', 'Casey', 'Morgan', 'Quinn', 'Avery'];

const DEFAULT_TIERS: readonly TierSpec[] = [
  { tierIndex: 0, label: 'Base', thresholdValue: 1 },
  { tierIndex: 1, label: 'Strong', thresholdValue: 5 },
];

/**
 * Wall-clock time a scenario logs at on a given day: 18:00, or an hour before
 * an earlier deadline. Before the deadline matters: a log after it is a late
 * log, which is a different scenario, not a default.
 */
export function defaultLogTime(deadlineTime: string): string {
  const minutes = Math.max(0, Math.min(18 * 60, parseDeadlineMinutes(deadlineTime) - 60));
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export type MakeUserInput = Partial<UserRecord>;

export type MakeHabitInput = {
  ownerId: string;
  type?: HabitType;
  /** Tiered only. Must include tier 0; defaults to Base/Strong. */
  tiers?: readonly TierSpec[];
  name?: string;
  unit?: string;
  startedAt?: Date;
};

export type MakeTowerInput = {
  hostId: string;
  timezone?: string;
  deadline?: string;
  grace?: number;
  name?: string;
  startedAt?: Date;
};

export type MakeEntryOptions = {
  /** Zone the date is read in. The tower's, or the owner's when solo. */
  timezone?: string;
  /** Wall-clock time of the log on `date`. Defaults to 18:00. */
  at?: string;
  numericValue?: number;
  countsTowardQuota?: boolean;
};

export type Factories = {
  readonly now: Date;
  readonly id: IdGen;
  makeUser(input?: MakeUserInput): UserRecord;
  makeHabit(input: MakeHabitInput): HabitRecord;
  makeTower(input: MakeTowerInput): TowerRecord;
  makeMembership(tower: TowerRecord, user: UserRecord, habit: HabitRecord): MembershipRecord;
  /** The spec's logEntry(habit, date, tier), renamed so it never shadows the service. */
  makeEntry(
    habit: HabitRecord,
    date: LocalDate,
    tier?: number,
    opts?: MakeEntryOptions
  ): EntryRecord;
};

/**
 * Single-record builders with defaults, sharing one seeded id stream and one
 * `now`. Records are plain data; nothing is written anywhere.
 */
export function factories({ seed = 1, now }: { seed?: number; now: Date }): Factories {
  const id = idGen(seed);
  let userCount = 0;

  return {
    now,
    id,

    makeUser(input = {}) {
      const userId = input.id ?? id();
      const n = userCount++;
      return {
        id: userId,
        email: input.email ?? `user-${userId.slice(0, 8)}@factory.test`,
        passwordHash: input.passwordHash ?? FACTORY_PASSWORD_HASH,
        displayName: input.displayName ?? DISPLAY_NAMES[n % DISPLAY_NAMES.length]!,
      };
    },

    makeHabit({ ownerId, type = 'binary', tiers, name, unit, startedAt }) {
      if (type !== 'tiered' && tiers?.length) {
        throw new Error(`makeHabit: tiers given for a ${type} habit`);
      }
      const habitTiers = type === 'tiered' ? [...(tiers ?? DEFAULT_TIERS)] : [];
      if (type === 'tiered' && !habitTiers.some((t) => t.tierIndex === 0)) {
        throw new Error('makeHabit: a tiered habit needs tier 0');
      }
      return {
        id: id(),
        ownerId,
        name: name ?? 'Run',
        type,
        unit: type === 'numeric' ? (unit ?? 'minutes') : null,
        lifecycle: 'active',
        startedAt: startedAt ?? now,
        tiers: habitTiers,
      };
    },

    makeTower({ hostId, timezone, deadline, grace, name, startedAt }) {
      return {
        id: id(),
        hostId,
        name: name ?? 'Morning run',
        deadlineTime: deadline ?? FACTORY_DEADLINE_TIME,
        timezone: timezone ?? FACTORY_TIMEZONE,
        graceWindowMinutes: grace ?? DEFAULT_GRACE_WINDOW_MINUTES,
        lifecycle: 'active',
        startedAt: startedAt ?? now,
        height: 0,
        currentStreak: 0,
      };
    },

    makeMembership(tower, user, habit) {
      return {
        id: id(),
        towerId: tower.id,
        userId: user.id,
        habitId: habit.id,
        state: 'active',
        consecutiveMissedPeriods: 0,
        lastQualifyingDate: null,
        dormantSince: null,
        dormancyReason: null,
        joinedAt: tower.startedAt,
      };
    },

    makeEntry(habit, date, tier = 0, opts = {}) {
      if (tier > 0 && habit.type !== 'tiered') {
        throw new Error(`makeEntry: tier ${tier} on a ${habit.type} habit`);
      }
      const numericValue = opts.numericValue ?? (habit.type === 'numeric' ? 30 : null);
      if (numericValue !== null && habit.type === 'binary') {
        throw new Error('makeEntry: numericValue on a binary habit');
      }
      return {
        id: id(),
        habitId: habit.id,
        localDate: date,
        loggedAt: wallClockToInstant(date, opts.at ?? '18:00', opts.timezone ?? FACTORY_TIMEZONE),
        tierReached: tier,
        numericValue,
        countsTowardQuota: opts.countsTowardQuota ?? true,
      };
    },
  };
}
