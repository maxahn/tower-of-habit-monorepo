import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { habits } from '../schema.js';

// The parent is the habit, not the membership: a habit logs the same way whether
// it sits in a tower or runs solo (§2), and its tower can change without
// rewriting history. No user_id either — a habit has exactly one owner, so
// entries are already per-person through habits.owner_id. Don't add one.
//
// Invariants the service layer owns (entries.ts), none of them expressible here:
//   - local_date is DERIVED from logged_at, the tower's timezone, deadline and
//     grace window, never client-supplied. See resolveLocalDate in
//     @tower-of-habit/shared.
//   - The shape rules need habits.type, which isn't a column on this table:
//     binary habits reject numeric_value, numeric habits require it, tiered
//     habits may carry the measurement that set the tier.
//   - The table is append-only. There is no updateEntry; a mistake is deleted
//     and re-logged, which frees the day because the unique index is partial.
export const entries = pgTable(
  'entries',
  {
    id: uuid().primaryKey().defaultRandom(),
    habitId: uuid()
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    // Tower-time, or habit-owner-time when solo. Derived, see above.
    localDate: date({ mode: 'string' }).notNull(),
    // 0 for binary and numeric habits; the tier index for tiered ones. Not an FK
    // to habit_tiers on purpose: deleting a tier leaves past entries as the
    // historical record of what was actually reached.
    tierReached: smallint().notNull().default(0),
    // mode: 'number' to match habitTiers.thresholdValue, so tiered evaluation
    // compares number to number rather than string to number.
    numericValue: numeric({ mode: 'number' }),
    // Always written explicitly by logEntry, with the same instant used to
    // derive local_date. The default is only a backstop for raw inserts: if the
    // two ever disagree the entry lands on the wrong day.
    loggedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // §4: only the first qualifying log of a day carries the credit. Extra logs
    // are additional rows with false, summed into the daily total.
    countsTowardQuota: boolean().notNull().default(false),
    // Idempotency, not identity. A flaky-signal retry (5.15) resends the same
    // key, so it collides here regardless of which local_date the grace branch
    // resolved to — one_qualifying_entry_per_day cannot catch that case, because
    // the retry and the original resolve to DIFFERENT dates (gap-fill, then
    // midnight run once the first attempt has filled yesterday). Nullable, and
    // NULLs never conflict in a Postgres unique index, so server-side inserts
    // and backfills are unaffected.
    clientEntryId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The one-credit-per-day rule (§4), in the database rather than the
    // application. A concurrent double-tap surfaces as a constraint violation
    // that logEntry translates into "already logged today"; application-level
    // checking cannot make that guarantee. The grace branch in resolveLocalDate
    // decides WHICH day, so this index stays a backstop, never the decider.
    uniqueIndex('one_qualifying_entry_per_day')
      .on(table.habitId, table.localDate)
      .where(sql`${table.countsTowardQuota}`),
    uniqueIndex('entries_client_entry_id_unique').on(table.clientEntryId),
    // Serves the ALL-ROWS reads: the SUM(numeric_value) roll-up, personal bests
    // and tier records. The streak read is qualifying-rows-only
    // (WHERE counts_toward_quota ORDER BY local_date DESC) and is served by the
    // partial unique above, so don't drop that one in favour of this.
    // The DESC documents read order rather than enabling anything: with habit_id
    // pinned by equality, Postgres scans the btree backward at identical cost.
    index('entries_habit_id_local_date_idx').on(table.habitId, table.localDate.desc()),
    check('entries_tier_reached_nonnegative', sql`${table.tierReached} >= 0`),
    // Postgres numeric accepts 'NaN', 'Infinity' and '-Infinity', and a single
    // NaN row would make every roll-up for that date NaN forever. A BETWEEN
    // rejects all three (none compares inside a range) plus absurd magnitudes.
    check(
      'entries_numeric_value_finite',
      sql`${table.numericValue} IS NULL OR ${table.numericValue} BETWEEN -1000000000 AND 1000000000`
    ),
  ]
);
