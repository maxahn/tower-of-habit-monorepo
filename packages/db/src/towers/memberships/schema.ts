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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { habits } from '../../habits/schema.js';
import { users } from '../../users/schema.js';
import { towers } from '../schema.js';

// 'removed' is terminal: leaving, being removed, or the tower ending. It frees
// the habit for another tower (see one_active_tower_per_habit).
export const membershipStateEnum = pgEnum('membership_state', [
  'active',
  'at_risk',
  'dormant',
  'removed',
]);

export const dormancyReasonEnum = pgEnum('dormancy_reason', [
  'consecutive_miss',
  'backstop',
  'voluntary',
]);

export type MembershipState = (typeof membershipStateEnum.enumValues)[number];
export type DormancyReason = (typeof dormancyReasonEnum.enumValues)[number];

export const memberships = pgTable(
  'memberships',
  {
    id: uuid().primaryKey().defaultRandom(),
    towerId: uuid()
      .notNull()
      .references(() => towers.id, { onDelete: 'cascade' }),
    // No on-delete action: deleting a user or habit with a membership fails.
    userId: uuid()
      .notNull()
      .references(() => users.id),
    habitId: uuid()
      .notNull()
      .references(() => habits.id),
    // Changes only through transitionMembership (memberships.ts).
    state: membershipStateEnum().notNull().default('active'),
    // Drives the §6 dormancy ladder: 1 → collapse + at_risk, 2 → dormant
    // instead of collapsing. Stored, not derived, so the evaluator's dormancy
    // step is O(1).
    consecutiveMissedPeriods: integer().notNull().default(0),
    lastQualifyingDate: date({ mode: 'string' }),
    // Set iff state = 'dormant'. See memberships_dormancy_iff_dormant.
    dormantSince: timestamp({ withTimezone: true }),
    dormancyReason: dormancyReasonEnum(),
    // v1.1. Added now: a nullable column is free, a migration on a live table isn't.
    voluntaryReturnDate: date({ mode: 'string' }),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Leading tower_id also serves FK lookups and cascades.
    unique('memberships_tower_id_user_id_unique').on(table.towerId, table.userId),
    // One active tower per habit (§2). An index rather than app logic, and
    // droppable: the rule is reversible (open decision #6), so relaxing it is
    // a one-line migration.
    uniqueIndex('one_active_tower_per_habit')
      .on(table.habitId)
      .where(sql`${table.state} != 'removed'`),
    index('memberships_user_id_idx').on(table.userId),
    check('memberships_missed_periods_nonnegative', sql`${table.consecutiveMissedPeriods} >= 0`),
    check(
      'memberships_dormancy_iff_dormant',
      sql`(${table.state} = 'dormant') = (${table.dormantSince} IS NOT NULL AND ${table.dormancyReason} IS NOT NULL)`
    ),
  ]
);
