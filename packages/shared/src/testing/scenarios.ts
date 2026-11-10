import { addDays, civilInZone, type LocalDate } from '../time/local-date.js';
import { resolvePeriodWindow } from '../time/period-window.js';
import { wallClockToInstant } from '../time/wall-clock.js';
import { deriveTowerState } from './derive.js';
import {
  defaultLogTime,
  factories,
  FACTORY_DEADLINE_TIME,
  FACTORY_TIMEZONE,
  type Factories,
} from './factories.js';
import type {
  HabitType,
  PeriodRecord,
  ScenarioMember,
  ScenarioPlan,
  TierSpec,
  UserRecord,
} from './plan.js';

/** What a trait gets to edit before deriveTowerState runs. */
export type ScenarioDraft = {
  plan: ScenarioPlan;
  f: Factories;
  /** dates[0] is day 1; the last element is today, whose period is open. */
  dates: LocalDate[];
  timezone: string;
};

/** A modifier applied to a scenario's inputs (entries, mostly) before derivation. */
export type Trait = (draft: ScenarioDraft) => void;

export type TowerScenarioOptions = {
  now: Date;
  seed?: number;
  /** A head count, or existing users to reuse (the seed shares them across towers). */
  members?: number | readonly UserRecord[];
  timezone?: string;
  deadline?: string;
  grace?: number;
  name?: string;
  habitType?: HabitType;
  tiers?: readonly TierSpec[];
  traits?: readonly Trait[];
};

/**
 * A daily tower on day `days`, as if the evaluator had kept up with it.
 *
 * Day N means today's civil date in the tower's zone is the Nth since it
 * started. Days 1..N-1 have periods, and every member logged each of them, so
 * by default the tower stands at height N-1 (fewer if `now` is still inside
 * yesterday's grace window: that period is pending, exactly as it would be).
 * Day N's period exists and is open, and nobody has logged it yet. Traits edit
 * those entries; deriveTowerState then computes outcomes, height, membership
 * state and base blocks from what is left.
 */
export function towerRunningFor(days: number, opts: TowerScenarioOptions): ScenarioPlan {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`towerRunningFor: days must be a positive integer, got ${days}`);
  }
  const { now, seed = 1 } = opts;
  const timezone = opts.timezone ?? FACTORY_TIMEZONE;
  const deadline = opts.deadline ?? FACTORY_DEADLINE_TIME;
  const f = factories({ seed, now });

  const today = civilInZone(now, timezone).date;
  const day1 = addDays(today, -(days - 1));
  const dates = Array.from({ length: days }, (_, i) => addDays(day1, i));
  const startedAt = wallClockToInstant(day1, '00:00', timezone);

  const users =
    typeof opts.members === 'object'
      ? [...opts.members]
      : Array.from({ length: opts.members ?? 1 }, () => f.makeUser());
  if (users.length === 0) throw new Error('towerRunningFor: a tower needs at least one member');

  const tower = f.makeTower({
    hostId: users[0]!.id,
    timezone,
    deadline,
    ...(opts.grace !== undefined ? { grace: opts.grace } : {}),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    startedAt,
  });

  const members: ScenarioMember[] = users.map((user) => {
    const habit = f.makeHabit({
      ownerId: user.id,
      name: tower.name,
      type: opts.habitType ?? 'binary',
      ...(opts.tiers ? { tiers: opts.tiers } : {}),
      startedAt,
    });
    return { user, habit, membership: f.makeMembership(tower, user, habit) };
  });

  const periods: PeriodRecord[] = dates.map((date) => {
    const w = resolvePeriodWindow({
      periodUnit: 'day',
      periodLength: 1,
      weekResetDay: null,
      anchorDate: day1,
      on: date,
      deadlineTime: deadline,
      timeZone: timezone,
      graceMinutes: tower.graceWindowMinutes,
    });
    return {
      id: f.id(),
      towerId: tower.id,
      periodStart: w.periodStart,
      periodEnd: w.periodEnd,
      deadlineAt: w.deadlineAt,
      evaluateAt: w.evaluateAt,
      state: 'pending',
      outcome: null,
      evaluatedAt: null,
      claimedAt: null,
      attempts: 0,
    };
  });
  if (periods.at(-1)!.evaluateAt.getTime() <= now.getTime()) {
    throw new Error(
      `towerRunningFor: now (${now.toISOString()}) is past day ${days}'s evaluate_at, ` +
        'so today would not be open. Pick an earlier `now`.'
    );
  }

  const at = defaultLogTime(deadline);
  const entries = members.flatMap(({ habit }) =>
    dates.slice(0, -1).map((date) => f.makeEntry(habit, date, 0, { timezone, at }))
  );

  const plan: ScenarioPlan = {
    now,
    seed,
    users,
    habits: members.map((m) => m.habit),
    tower,
    memberships: members.map((m) => m.membership),
    periods,
    entries,
    blocks: [],
    members,
  };
  const draft: ScenarioDraft = { plan, f, dates, timezone };
  for (const trait of opts.traits ?? []) trait(draft);
  return deriveTowerState(plan);
}

/**
 * `n` base blocks under the current run: towerRunningFor with withBaseBlocks(n)
 * applied first, and enough days for it.
 */
export function towerWithBaseBlocks(
  n: number,
  opts: TowerScenarioOptions & { days?: number }
): ScenarioPlan {
  const { days, traits = [], ...rest } = opts;
  // +3: two survived days on top of the last block, plus today.
  return towerRunningFor(Math.max(days ?? 0, minDaysForBlocks(n) + 3), {
    ...rest,
    traits: [withBaseBlocks(n), ...traits],
  });
}

export type StandaloneHabitOptions = {
  now: Date;
  seed?: number;
  /** Reuse an existing user; otherwise one is made. */
  owner?: UserRecord;
  type?: HabitType;
  tiers?: readonly TierSpec[];
  name?: string;
  unit?: string;
  /** Past days logged, ending yesterday. Today is left open. */
  loggedDays?: number;
  /** The owner's reported zone. Solo habits fall back to UTC (entries.ts). */
  timezone?: string;
};

/** A habit in no tower, logged for the last `loggedDays` days. */
export function standaloneHabit(opts: StandaloneHabitOptions): ScenarioPlan {
  const { now, seed = 1, loggedDays = 5 } = opts;
  const timezone = opts.timezone ?? 'UTC';
  const f = factories({ seed, now });
  const owner = opts.owner ?? f.makeUser();
  const today = civilInZone(now, timezone).date;
  const habit = f.makeHabit({
    ownerId: owner.id,
    type: opts.type ?? 'binary',
    ...(opts.tiers ? { tiers: opts.tiers } : {}),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.unit !== undefined ? { unit: opts.unit } : {}),
    startedAt: wallClockToInstant(addDays(today, -loggedDays), '00:00', timezone),
  });
  // Noon: clear of the solo grace window, which spills past local midnight.
  const entries = Array.from({ length: loggedDays }, (_, i) =>
    f.makeEntry(habit, addDays(today, i - loggedDays), 0, { timezone, at: '12:00' })
  );
  return {
    now,
    seed,
    users: [owner],
    habits: [habit],
    tower: null,
    memberships: [],
    periods: [],
    entries,
    blocks: [],
    members: [],
  };
}

// ---------------------------------------------------------------------------
// Traits
// ---------------------------------------------------------------------------

function memberAt(draft: ScenarioDraft, index: number | undefined): ScenarioMember {
  const { members } = draft.plan;
  const i = index ?? members.length - 1;
  const m = members[i];
  if (!m) throw new Error(`trait: no member at index ${i} (tower has ${members.length})`);
  return m;
}

/** Past days, oldest first: every date but today's. */
function pastDates(draft: ScenarioDraft): LocalDate[] {
  return draft.dates.slice(0, -1);
}

function removeQualifyingEntry(draft: ScenarioDraft, habitId: string, date: LocalDate): void {
  draft.plan.entries = draft.plan.entries.filter(
    (e) => !(e.habitId === habitId && e.localDate === date)
  );
}

/**
 * The member (default: the last) logged nothing for the most recent `n` past
 * periods. Under the §6 ladder 1 miss leaves them at_risk and collapses the
 * tower, and 2 make them dormant.
 */
export function memberMissedPeriods(n: number, opts: { member?: number } = {}): Trait {
  return (draft) => {
    const past = pastDates(draft);
    if (n < 1 || n > past.length) {
      throw new Error(`memberMissedPeriods(${n}): the tower has ${past.length} past periods`);
    }
    const { habit } = memberAt(draft, opts.member);
    for (const date of past.slice(-n)) removeQualifyingEntry(draft, habit.id, date);
  };
}

/** Everyone missed the last two past periods: all dormant, the tower hibernating. */
export function allMembersDormant(): Trait {
  return (draft) => {
    const past = pastDates(draft);
    if (past.length < 2) {
      throw new Error('allMembersDormant: needs at least 2 past periods (days >= 3)');
    }
    for (const { habit } of draft.plan.members) {
      for (const date of past.slice(-2)) removeQualifyingEntry(draft, habit.id, date);
    }
  };
}

/** Each block is MIN_BLOCK_DAYS (3) qualifying days plus the collapse day that closes it. */
const DAYS_PER_BLOCK = 4;
function minDaysForBlocks(n: number): number {
  return DAYS_PER_BLOCK * n;
}

/**
 * `n` completed runs under the current one, each closed by a single miss from
 * the first member. Runs of 3 survived days, collapses on day 4, 8, ... and the
 * member is back to active the next day.
 */
export function withBaseBlocks(n: number): Trait {
  return (draft) => {
    const past = pastDates(draft);
    if (n < 1) throw new Error(`withBaseBlocks(${n}): n must be >= 1`);
    if (past.length < minDaysForBlocks(n)) {
      throw new Error(
        `withBaseBlocks(${n}): needs ${minDaysForBlocks(n)} past periods, the tower has ` +
          `${past.length}. Use towerWithBaseBlocks, which sizes the tower for you.`
      );
    }
    const { habit } = memberAt(draft, 0);
    for (let k = 1; k <= n; k++) {
      removeQualifyingEntry(draft, habit.id, past[DAYS_PER_BLOCK * k - 1]!);
    }
  };
}

/** The first `k` members (default: all) have already logged today, at `now`. */
export function membersLoggedToday(k?: number): Trait {
  return (draft) => {
    const today = draft.dates.at(-1)!;
    for (const { habit } of draft.plan.members.slice(0, k ?? draft.plan.members.length)) {
      const entry = draft.f.makeEntry(habit, today, 0, { timezone: draft.timezone });
      // Logged right now, not at the default evening time, which may be ahead of `now`.
      entry.loggedAt = draft.plan.now;
      draft.plan.entries.push(entry);
    }
  };
}
