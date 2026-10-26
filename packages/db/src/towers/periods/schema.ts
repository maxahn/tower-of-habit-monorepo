import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '../../users/schema.js';
import { towers } from '../schema.js';

// pending -> evaluating -> evaluated. Changes only through claimDuePeriods and
// transitionPeriod (periods.ts). 'evaluating' is the lease: a worker that
// crashes holding it is reclaimed once claimed_at is older than the lease.
export const periodStateEnum = pgEnum('period_state', ['pending', 'evaluating', 'evaluated']);

export const periodOutcomeEnum = pgEnum('period_outcome', [
  'survived',
  'collapsed',
  'hibernated',
  'freebie',
]);

// Provisional vocabulary, unused in v1: the freebie design hasn't landed. The
// check constraints below are what matter.
export const freebieSourceEnum = pgEnum('freebie_source', ['earned', 'host_granted', 'system']);

export type PeriodState = (typeof periodStateEnum.enumValues)[number];
export type PeriodOutcome = (typeof periodOutcomeEnum.enumValues)[number];
export type FreebieSource = (typeof freebieSourceEnum.enumValues)[number];

// Materialising periods is what makes the evaluator idempotent (3.5) and what
// makes weekly a configuration change rather than a rewrite.
//
// Invariants the service layer owns (periods.ts), none expressible here:
//   - deadline_at and evaluate_at are DERIVED from the tower's deadline_time,
//     timezone and grace_window_minutes, and RESOLVED ONCE at creation. See
//     resolvePeriodWindow in @tower-of-habit/shared. A concrete instant makes
//     the claim a plain indexed range scan rather than per-row timezone maths
//     across every tower, and pins DST behaviour to a decision made once, in
//     tested code, rather than re-derived under load at 2am on the night the
//     clocks change.
//   - evaluate_at is deadline_at plus a REAL interval, never grace minutes
//     added to a local wall-clock hour. On a spring-forward night those differ
//     by an hour.
//   - Editing a tower's deadline_time, timezone or grace does NOT reach
//     periods already materialised. Known gap; see updateTower.
export const towerPeriods = pgTable(
  'tower_periods',
  {
    id: uuid().primaryKey().defaultRandom(),
    towerId: uuid()
      .notNull()
      .references(() => towers.id, { onDelete: 'cascade' }),
    periodStart: date({ mode: 'string' }).notNull(),
    // Inclusive. Equal to period_start for a daily tower.
    periodEnd: date({ mode: 'string' }).notNull(),
    // DISPLAYED. The commitment, and the only instant a member ever sees:
    // countdown (5.8), nudge anchor (3.6), wobble anchor (3.7).
    deadlineAt: timestamp({ withTimezone: true }).notNull(),
    // INTERNAL, never displayed. When the outcome is decided: scheduler claim
    // (3.4), collapse decision (3.8). Deciding at the deadline and reopening on
    // a late log would let a tower be declared collapsed and then un-collapsed.
    evaluateAt: timestamp({ withTimezone: true }).notNull(),
    state: periodStateEnum().notNull().default('pending'),
    outcome: periodOutcomeEnum(),
    evaluatedAt: timestamp({ withTimezone: true }),
    claimedAt: timestamp({ withTimezone: true }),
    // Claims so far, including reclaims. Bounds the reclaim loop so a poison
    // period stops being retried (MAX_CLAIM_ATTEMPTS).
    attempts: integer().notNull().default(0),
    // Unused in v1. Nullable now because a nullable column is free and a
    // migration on a live table isn't.
    freebieSource: freebieSourceEnum(),
    // Null for system-granted freebies. No on-delete action, like memberships.
    freebieGrantedBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // What makes creation idempotent: two workers racing to create tomorrow's
    // period produce one row and one loser, not duplicates. Leading tower_id
    // also serves the FK cascade and "latest period for tower" reads.
    unique('tower_periods_tower_id_period_start_unique').on(table.towerId, table.periodStart),
    // The scheduler's claim (3.4). Keyed on evaluate_at, NEVER deadline_at:
    // claiming on the deadline would evaluate before the grace window closed.
    index('periods_due')
      .on(table.state, table.evaluateAt)
      .where(sql`${table.state} = 'pending'`),
    // The claim's reclaim arm: leases abandoned by crashed workers. Separate
    // from periods_due so that index keeps the spec's shape.
    index('periods_stale_claims')
      .on(table.claimedAt)
      .where(sql`${table.state} = 'evaluating'`),
    // Not a column of its own, and FK checks on user delete scan this.
    index('tower_periods_freebie_granted_by_idx')
      .on(table.freebieGrantedBy)
      .where(sql`${table.freebieGrantedBy} IS NOT NULL`),
    check('tower_periods_end_after_start', sql`${table.periodEnd} >= ${table.periodStart}`),
    // DR-001. >= rather than >: grace 0 reproduces the hard cliff exactly.
    check('tower_periods_evaluate_after_deadline', sql`${table.evaluateAt} >= ${table.deadlineAt}`),
    // The outcome is decided exactly once, on reaching 'evaluated'. Two iffs,
    // not `(state = 'evaluated') = (outcome IS NOT NULL AND evaluated_at IS NOT
    // NULL)`: that form accepts a pending row carrying an outcome but no
    // evaluated_at, since false = (true AND false).
    check(
      'tower_periods_outcome_iff_evaluated',
      sql`(${table.state} = 'evaluated') = (${table.outcome} IS NOT NULL) AND (${table.state} = 'evaluated') = (${table.evaluatedAt} IS NOT NULL)`
    ),
    // One-directional, NOT an iff: a period released back to 'pending' after a
    // failed attempt keeps claimed_at as the record of when that attempt began.
    check(
      'tower_periods_claimed_unless_pending',
      sql`${table.state} = 'pending' OR ${table.claimedAt} IS NOT NULL`
    ),
    check('tower_periods_attempts_nonnegative', sql`${table.attempts} >= 0`),
    // IS NOT DISTINCT FROM, not =: outcome is nullable, and `NULL = 'freebie'`
    // is NULL, which a CHECK lets through. With = this would be vacuous on
    // every pending row.
    check(
      'tower_periods_freebie_fields_iff_freebie',
      sql`(${table.outcome} IS NOT DISTINCT FROM 'freebie') = (${table.freebieSource} IS NOT NULL)`
    ),
    check(
      'tower_periods_freebie_granted_by_requires_source',
      sql`${table.freebieGrantedBy} IS NULL OR ${table.freebieSource} IS NOT NULL`
    ),
  ]
);
