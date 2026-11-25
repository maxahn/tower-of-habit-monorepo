import {
  findHabitTower,
  getUser,
  listTiers,
  qualifyingEntryForDate,
  recordEntry,
  transitionMembership,
  updateMembership,
  type Db,
  type Entry,
  type Habit,
} from '@tower-of-habit/db';
import {
  civilInZone,
  DEFAULT_GRACE_WINDOW_MINUTES,
  gapFillCandidate,
  resolveLocalDate,
  SOLO_DEADLINE_TIME,
  wallClockToInstant,
  type EntrySource,
  type LogEntryRequest,
  type LogEntryResponse,
} from '@tower-of-habit/shared';
import { HabitConfigError, qualifies, stepMembership } from '@tower-of-habit/shared/evaluator';
import { DomainError } from '../errors.js';

function sourceOf(
  entry: Pick<Entry, 'localDate' | 'loggedAt'>,
  deadlineTime: string,
  timeZone: string
): EntrySource {
  const deadline = wallClockToInstant(entry.localDate, deadlineTime, timeZone);
  return entry.loggedAt.getTime() >= deadline.getTime() ? 'grace' : 'live';
}

export async function logHabitEntry(
  tx: Db,
  habit: Habit,
  body: LogEntryRequest,
  now: Date
): Promise<LogEntryResponse & { created: boolean }> {
  const bound = await findHabitTower(tx, habit.id);
  const user = await getUser(tx, habit.ownerId);

  const timeZone = bound ? bound.tower.timezone : (body.timezone ?? user?.timezone ?? 'UTC');
  const deadlineTime = bound ? bound.tower.deadlineTime : SOLO_DEADLINE_TIME;
  const graceMinutes = bound ? bound.tower.graceWindowMinutes : DEFAULT_GRACE_WINDOW_MINUTES;
  const window = { loggedAt: now, timeZone, deadlineTime, graceMinutes };

  const today = civilInZone(now, timeZone).date;
  const candidate = gapFillCandidate(window);
  const yesterdayIsFilled =
    candidate !== null && (await qualifyingEntryForDate(tx, habit.id, candidate)) !== undefined;
  let localDate: string;
  if (body.localDate !== undefined) {
    if (body.localDate !== today && body.localDate !== candidate) {
      throw new DomainError(
        400,
        'date_out_of_window',
        'localDate must be today, or yesterday while its grace window is open'
      );
    }
    localDate = body.localDate;
  } else {
    localDate = resolveLocalDate({ ...window, yesterdayIsFilled });
  }

  let verdict: boolean;
  try {
    verdict = qualifies(
      { type: habit.type, tiers: await listTiers(tx, habit.id) },
      { numericValue: body.numericValue ?? null, tierReached: body.tierReached ?? 0 }
    );
  } catch (e) {
    if (e instanceof HabitConfigError) {
      throw new DomainError(409, 'habit_misconfigured', 'The habit has no base threshold');
    }
    throw e;
  }

  const { entry, created } = await recordEntry(tx, {
    habitId: habit.id,
    localDate,
    loggedAt: now,
    qualifies: verdict,
    ...(body.tierReached !== undefined ? { tierReached: body.tierReached } : {}),
    ...(body.numericValue !== undefined ? { numericValue: body.numericValue } : {}),
    ...(body.clientEntryId !== undefined ? { clientEntryId: body.clientEntryId } : {}),
  });

  if (created && verdict && bound) {
    const m = bound.membership;
    if (m.lastQualifyingDate === null || m.lastQualifyingDate < localDate) {
      await updateMembership(tx, m.id, { lastQualifyingDate: localDate });
    }
    const step = stepMembership(
      {
        membershipId: m.id,
        state: m.state,
        dormancyReason: m.dormancyReason,
        consecutiveMisses: m.consecutiveMissedPeriods,
        lastQualifyingDate: m.lastQualifyingDate,
        joinedOn: civilInZone(m.joinedAt, timeZone).date,
        voluntaryReturnDate: m.voluntaryReturnDate,
      },
      { kind: 'qualifying_entry', localDate, openPeriodStart: localDate }
    );
    if (step.transition?.to === 'active') {
      await transitionMembership(tx, m.id, { to: 'active' }, now);
    }
  }

  return {
    entry: {
      ...(entry as unknown as LogEntryResponse['entry']),
      source: sourceOf(entry, deadlineTime, timeZone),
    },
    qualifies: verdict,
    created,
  };
}
