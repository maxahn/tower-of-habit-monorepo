import { sql } from 'drizzle-orm';
import { check, date, integer, jsonb, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { BlockRoster } from '@tower-of-habit/shared';
import { towers } from '../schema.js';

// The §5 strata: one row per completed qualifying run of a tower, stacked
// oldest-first. A block is written once, by the evaluator, and never updated.
//
// THERE IS NO caused_collapse COLUMN, AND THERE MUST NEVER BE ONE (§5). This is
// a product decision expressed as a schema constraint, not an oversight. A
// tower's history records what the group built, not who broke it; with no
// column there is nothing for a future feature, admin screen, export or debug
// log to casually surface as blame. Adding it later would be a migration
// someone has to defend in review — which is the point. The column set is
// pinned by a test in blocks.test.ts so it cannot arrive by accident.
//
// What else is deliberately NOT a column:
//   - No period or entry ids. A block summarises a run, not the rows that
//     produced it. Keeping them would make the snapshot a view onto live data,
//     which is exactly what it must not be: it has to stay readable once the
//     tower_periods rows it was computed from have been pruned.
//   - No member foreign keys. roster carries user_id INSIDE the jsonb, where a
//     foreign key is impossible — on purpose. Deleting a user must not delete,
//     null out or renumber the history of the towers they were part of.
//   - No minimum run length. The ~3-day floor (§5) is evaluator logic (3.9): a
//     run shorter than it simply produces no row. The database accepts a
//     one-day block, and base_blocks_block_height_within_run is written with
//     that in mind.
//
// Invariants the service layer owns (blocks.ts), none expressible here:
//   - ordinal is GAPLESS per tower: 1..n, no holes. It is a POSITION in the
//     stack, never a count of runs attempted, so a skipped short run must not
//     consume one. appendBaseBlock allocates it server-side and never takes it
//     from a caller, and there is no update and no delete, so the only way to
//     punch a hole is raw SQL. findOrdinalGaps is the assertion.
//   - roster matches blockRosterSchema (@tower-of-habit/shared). The CHECK
//     below only pins it to a non-empty JSON array; encoding the member shape
//     in SQL as well would be the same rule written twice, in two languages,
//     drifting apart on the first change to either.
//   - roster is FROZEN. It records the roster as it was, which is what keeps
//     the strata legible to someone who joined for the fifth attempt. It is
//     also why 1.2's account-deletion rule must REWRITE display_name inside
//     this jsonb in place (a jsonb_set across the tower's blocks) rather than
//     lean on a join that was deliberately never built. No helper for that
//     here; it lands with 1.2.
export const baseBlocks = pgTable(
  'base_blocks',
  {
    id: uuid().primaryKey().defaultRandom(),
    towerId: uuid()
      .notNull()
      .references(() => towers.id, { onDelete: 'cascade' }),
    // 1 = deepest/oldest. Allocated by appendBaseBlock; see above. A plain
    // integer and NOT serial/identity: a sequence burns its value on a
    // rolled-back insert, leaving a permanent hole in the stack.
    ordinal: integer().notNull(),
    runStartDate: date({ mode: 'string' }).notNull(),
    // Inclusive, like tower_periods.period_end.
    runEndDate: date({ mode: 'string' }).notNull(),
    // Qualifying days within the run, NOT its calendar length: a run can
    // contain non-qualifying days that didn't collapse the tower (grace,
    // freebies, §6 dormancy). Hence <= the day count, not equal to it.
    blockHeight: integer().notNull(),
    // Snapshotted and deliberately denormalised. NEVER joined back to users,
    // memberships or habits — see the header. snake_case keys inside, which
    // `casing: 'snake_case'` does NOT do for you: it maps column keys only and
    // never reaches inside a jsonb value, so the service writes them as-is.
    roster: jsonb().$type<BlockRoster>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The gaplessness backstop, and the arbiter the ordinal allocator relies
    // on. Leading tower_id also serves FK lookups, the cascade and "the stack
    // for this tower" reads, so there is no separate index on tower_id.
    unique('base_blocks_tower_id_ordinal_unique').on(table.towerId, table.ordinal),
    // Without this, ordinal 0 or -1 would sit below the "deepest" block and
    // every stack render and gap check would have to special-case it.
    check('base_blocks_ordinal_positive', sql`${table.ordinal} >= 1`),
    // A run that ends before it starts has a negative length. Strictly this is
    // subsumed by the two checks below — a negative span can't be >= a
    // block_height of 1 — so a reversed range is rejected either way and
    // Postgres may name either constraint. Kept anyway: it states the
    // invariant directly instead of leaving it as a corollary of the height
    // rule, and it still holds if that rule ever changes.
    check('base_blocks_run_end_after_start', sql`${table.runEndDate} >= ${table.runStartDate}`),
    // A block with no qualifying days isn't a block; it's a run that should
    // have produced no row at all (3.9).
    check('base_blocks_block_height_positive', sql`${table.blockHeight} >= 1`),
    // Qualifying days cannot outnumber the days in the run. +1 because
    // run_end_date is inclusive, which is also what lets a legitimate
    // single-day block (height 1, end = start) through. `date - date` yields
    // integer days in Postgres; this would be wrong against a timestamp.
    check(
      'base_blocks_block_height_within_run',
      sql`${table.blockHeight} <= (${table.runEndDate} - ${table.runStartDate}) + 1`
    ),
    // $type<> is a compile-time claim about a column Postgres will happily
    // fill with `"sam"`, `42` or `{}`. A roster of [], {} or a scalar would
    // render as a block nobody built.
    //
    // Written as `<> '[]'::jsonb` rather than jsonb_array_length(...) >= 1 on
    // purpose: jsonb_array_length ERRORS on a non-array (22023), and CHECK
    // conjuncts have no guaranteed evaluation order, so the pair could surface
    // as a raw 22023 instead of a named 23514 depending on which ran first.
    // Both operands here are safe against any jsonb value.
    check(
      'base_blocks_roster_nonempty_array',
      sql`jsonb_typeof(${table.roster}) = 'array' AND ${table.roster} <> '[]'::jsonb`
    ),
  ]
);
