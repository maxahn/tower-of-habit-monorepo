import { and, desc, eq, ne, sql, sum } from 'drizzle-orm';
import {
  DEFAULT_GRACE_WINDOW_MINUTES,
  gapFillCandidate,
  resolveLocalDate,
  resolveSupplementalLocalDate,
  SOLO_DEADLINE_TIME,
  type LocalDateContext,
} from '@tower-of-habit/shared';
import type { db as appDb } from '../../client.js';
import { asPgError, isUniqueViolation, UNIQUE_VIOLATION } from '../../pg-errors.js';
import { InvalidTimeZoneError, isValidTimeZone } from '../../towers/towers.js';
import { memberships } from '../../towers/memberships/schema.js';
import { towers } from '../../towers/schema.js';
import { HabitNotFoundError } from '../habits.js';
import { habits } from '../schema.js';
import { entries } from './schema.js';

type Db = typeof appDb;
export type Entry = typeof entries.$inferSelect;
type HabitType = (typeof habits.$inferSelect)['type'];

/** Solo habits with no reported zone. Deterministic, if wrong for most people. */
export const FALLBACK_TIMEZONE = 'UTC';

export type LogEntryInput = {
  habitId: string;
  /**
   * TRUSTED, server-side parameter: it defaults to the server clock, and only
   * tests and backfills pass it. The API layer must NOT forward a client
   * instant — that would hand the client control of the derived local_date,
   * which is exactly what "local_date is derived, not client-supplied" forbids.
   */
  loggedAt?: Date;
  tierReached?: number;
  numericValue?: number;
  /**
   * Standalone habits only: the client's reported IANA zone, validated here and
   * falling back to UTC. The client supplies the zone, never the date. Ignored
   * when the habit is in a tower, which has its own timezone.
   */
  timezone?: string;
  /** Idempotency key. A retry resending it gets the original row back. */
  clientEntryId?: string;
};

export type EntryShapeReason =
  | 'numeric_value_not_allowed' // binary habits measure nothing
  | 'numeric_value_required' // numeric habits are the measurement
  | 'tier_not_allowed'; // only tiered habits reach a tier above 0

export class EntryShapeError extends Error {
  constructor(
    readonly reason: EntryShapeReason,
    readonly habitId: string
  ) {
    super(`Entry does not match the habit's type: ${reason} (habit ${habitId})`);
    this.name = 'EntryShapeError';
  }
}

export class AlreadyLoggedError extends Error {
  constructor(
    readonly habitId: string,
    readonly localDate: string
  ) {
    super(`Habit ${habitId} already has a qualifying entry for ${localDate}`);
    this.name = 'AlreadyLoggedError';
  }
}

export type LoggingContext = LocalDateContext & { habitType: HabitType };

/**
 * The timezone, deadline and grace window an entry's local_date is derived from:
 * the habit's tower when it has one, the solo fallback when it doesn't.
 *
 * one_active_tower_per_habit guarantees at most one membership with
 * state != 'removed', so the joins cannot fan out. Tower lifecycle is
 * deliberately NOT filtered: a paused tower's timezone is still the habit's
 * timezone, and logging into one shouldn't silently switch day boundaries.
 */
export async function resolveLoggingContext(
  db: Db,
  habitId: string,
  loggedAt: Date,
  clientTimezone?: string
): Promise<LoggingContext> {
  const [row] = await db
    .select({
      habitType: habits.type,
      timezone: towers.timezone,
      deadlineTime: towers.deadlineTime,
      graceMinutes: towers.graceWindowMinutes,
    })
    .from(habits)
    .leftJoin(
      memberships,
      and(eq(memberships.habitId, habits.id), ne(memberships.state, 'removed'))
    )
    .leftJoin(towers, eq(towers.id, memberships.towerId))
    .where(eq(habits.id, habitId));
  if (!row) throw new HabitNotFoundError(habitId);

  if (row.timezone !== null && row.deadlineTime !== null && row.graceMinutes !== null) {
    return {
      loggedAt,
      habitType: row.habitType,
      // towers.timezone -> the resolver's timeZone (Intl spelling).
      timeZone: row.timezone,
      deadlineTime: row.deadlineTime,
      graceMinutes: row.graceMinutes,
    };
  }

  // Standalone habit (DR-001 §6): the day boundary is the owner's local
  // midnight, with the same default grace. SOLO_DEADLINE_TIME is '24:00', not
  // '00:00' — see the constant's comment for why that matters.
  const timezone = clientTimezone ?? FALLBACK_TIMEZONE;
  if (!isValidTimeZone(timezone)) throw new InvalidTimeZoneError(timezone);
  return {
    loggedAt,
    habitType: row.habitType,
    timeZone: timezone,
    deadlineTime: SOLO_DEADLINE_TIME,
    graceMinutes: DEFAULT_GRACE_WINDOW_MINUTES,
  };
}

/**
 * The §4 shape rules. They need habits.type, which isn't a column on entries,
 * so they can't be CHECK constraints — this is the enforcement point.
 *
 * Tiered habits MAY carry numericValue: it's the measurement that determined the
 * tier, and habitTiers.thresholdValue is numeric, so keeping it makes tier
 * records and personal bests readable.
 */
function assertEntryShape(habitId: string, habitType: HabitType, input: LogEntryInput): void {
  if (input.numericValue !== undefined && habitType === 'binary') {
    throw new EntryShapeError('numeric_value_not_allowed', habitId);
  }
  if (input.numericValue === undefined && habitType === 'numeric') {
    throw new EntryShapeError('numeric_value_required', habitId);
  }
  if (input.tierReached !== undefined && input.tierReached > 0 && habitType !== 'tiered') {
    throw new EntryShapeError('tier_not_allowed', habitId);
  }
}

/** Cheap probe, served by one_qualifying_entry_per_day. */
async function hasQualifyingEntry(db: Db, habitId: string, localDate: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(entries)
    .where(
      and(
        eq(entries.habitId, habitId),
        eq(entries.localDate, localDate),
        eq(entries.countsTowardQuota, true)
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Whether the gap-filling branch applies: the date to probe, and its fill state.
 * Shared by logEntry and addSupplementalEntry, which read the same two facts and
 * then branch on them in opposite directions.
 */
async function gapFillState(
  db: Db,
  habitId: string,
  ctx: LocalDateContext
): Promise<{ yesterdayIsFilled: boolean }> {
  const candidate = gapFillCandidate(ctx);
  // No candidate means the instant is outside the overflowed grace window, and
  // neither resolver consults the flag. Skip the query.
  if (candidate === null) return { yesterdayIsFilled: false };
  return { yesterdayIsFilled: await hasQualifyingEntry(db, habitId, candidate) };
}

function valuesFor(input: LogEntryInput, localDate: string, countsTowardQuota: boolean) {
  // exactOptionalPropertyTypes: spread conditionally rather than passing
  // possibly-undefined keys.
  return {
    habitId: input.habitId,
    localDate,
    countsTowardQuota,
    loggedAt: input.loggedAt!,
    ...(input.tierReached !== undefined ? { tierReached: input.tierReached } : {}),
    ...(input.numericValue !== undefined ? { numericValue: input.numericValue } : {}),
    ...(input.clientEntryId !== undefined ? { clientEntryId: input.clientEntryId } : {}),
  };
}

/**
 * The row a retry was trying to create, if this error is that retry.
 *
 * Checked BEFORE the day rule and on any unique violation, not just on
 * entries_client_entry_id_unique: Postgres reports whichever index it validated
 * first, and for a same-day retry that is one_qualifying_entry_per_day. Keying
 * the decision off the constraint name would make idempotency depend on index
 * check order. A retry that resends its key is the same write either way.
 */
async function retriedEntry(
  db: Db,
  clientEntryId: string | undefined,
  e: unknown
): Promise<Entry | undefined> {
  if (clientEntryId === undefined) return undefined;
  if (asPgError(e).code !== UNIQUE_VIOLATION) return undefined;
  const [row] = await db.select().from(entries).where(eq(entries.clientEntryId, clientEntryId));
  return row;
}

/**
 * Logs the day's qualifying entry — the one that carries the credit (§4).
 *
 * Deliberately NOT in a transaction. The probe-then-insert race is exactly what
 * one_qualifying_entry_per_day exists for: at READ COMMITTED a transaction
 * prevents nothing, and on a violation it would only add rollback bookkeeping.
 * SERIALIZABLE would turn a clean 23505 into a 40001 to retry.
 */
export async function logEntry(db: Db, input: LogEntryInput): Promise<Entry> {
  const loggedAt = input.loggedAt ?? new Date();
  const ctx = await resolveLoggingContext(db, input.habitId, loggedAt, input.timezone);
  assertEntryShape(input.habitId, ctx.habitType, input);

  const { yesterdayIsFilled } = await gapFillState(db, input.habitId, ctx);
  const localDate = resolveLocalDate({ ...ctx, yesterdayIsFilled });

  try {
    const [row] = await db
      .insert(entries)
      .values(valuesFor({ ...input, loggedAt }, localDate, true))
      .returning();
    return row!;
  } catch (e) {
    // A flaky-signal retry (5.15): idempotent success, not an error, because the
    // original row is what the client was trying to create. Checked first — see
    // retriedEntry. This also covers the case the partial index structurally
    // cannot: a retry that resolved to a DIFFERENT local_date because the first
    // attempt had already filled yesterday.
    const retried = await retriedEntry(db, input.clientEntryId, e);
    if (retried) return retried;
    // A genuine second tap on a day that already has its credit.
    if (isUniqueViolation(e, 'one_qualifying_entry_per_day')) {
      throw new AlreadyLoggedError(input.habitId, localDate);
    }
    throw e;
  }
}

/**
 * An extra log for a day that already has its credit (§4): stored as another row
 * with counts_toward_quota = false and summed into the daily total.
 *
 * Uses resolveSupplementalLocalDate, not resolveLocalDate. A credited log fills
 * the gap; a supplemental one joins the credit. Sharing the credited resolver
 * would put a 00:30 supplemental on a different date than the 23:30 credit it
 * belongs to, undercounting that date's SUM and orphaning the row on the next.
 */
export async function addSupplementalEntry(db: Db, input: LogEntryInput): Promise<Entry> {
  const loggedAt = input.loggedAt ?? new Date();
  const ctx = await resolveLoggingContext(db, input.habitId, loggedAt, input.timezone);
  assertEntryShape(input.habitId, ctx.habitType, input);

  const { yesterdayIsFilled } = await gapFillState(db, input.habitId, ctx);
  const localDate = resolveSupplementalLocalDate({ ...ctx, yesterdayIsFilled });

  try {
    const [row] = await db
      .insert(entries)
      .values(valuesFor({ ...input, loggedAt }, localDate, false))
      .returning();
    return row!;
  } catch (e) {
    const retried = await retriedEntry(db, input.clientEntryId, e);
    if (retried) return retried;
    throw e;
  }
}

export async function getEntry(db: Db, id: string): Promise<Entry | undefined> {
  const [row] = await db.select().from(entries).where(eq(entries.id, id));
  return row;
}

export async function listEntriesForHabit(db: Db, habitId: string): Promise<Entry[]> {
  return db
    .select()
    .from(entries)
    .where(eq(entries.habitId, habitId))
    .orderBy(desc(entries.localDate));
}

export async function listEntriesForDate(
  db: Db,
  habitId: string,
  localDate: string
): Promise<Entry[]> {
  return db
    .select()
    .from(entries)
    .where(and(eq(entries.habitId, habitId), eq(entries.localDate, localDate)));
}

/** The one row the quota reads. */
export async function qualifyingEntryForDate(
  db: Db,
  habitId: string,
  localDate: string
): Promise<Entry | undefined> {
  const [row] = await db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.habitId, habitId),
        eq(entries.localDate, localDate),
        eq(entries.countsTowardQuota, true)
      )
    );
  return row;
}

/**
 * The §4 numeric roll-up: SUM over every row for the date, credited or not.
 *
 * drizzle's sum() is typed SQL<string | null> whatever the column's mode, so the
 * parse is explicit. The aggregation itself is exact numeric inside Postgres;
 * only this final conversion is floating point.
 */
export async function dailyNumericTotal(
  db: Db,
  habitId: string,
  localDate: string
): Promise<number> {
  const [row] = await db
    .select({ total: sum(entries.numericValue) })
    .from(entries)
    .where(and(eq(entries.habitId, habitId), eq(entries.localDate, localDate)));
  return Number(row?.total ?? 0);
}

/** The streak read: qualifying rows only, newest first. */
export async function listQualifyingDates(
  db: Db,
  habitId: string,
  limit: number
): Promise<string[]> {
  const rows = await db
    .select({ localDate: entries.localDate })
    .from(entries)
    .where(and(eq(entries.habitId, habitId), eq(entries.countsTowardQuota, true)))
    .orderBy(desc(entries.localDate))
    .limit(limit);
  return rows.map((r) => r.localDate);
}

/**
 * Entries are append-only, so there is no updateEntry: a mistake is deleted and
 * re-logged. Deleting the qualifying row frees the day (the unique index is
 * partial) and leaves any supplementals for it without a credit.
 */
export async function deleteEntry(db: Db, id: string): Promise<void> {
  await db.delete(entries).where(eq(entries.id, id));
}
