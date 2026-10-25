import {
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  timestamp,
  uuid,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const DISPLAY_VARCHAR_MAX = 60;

// Column names are derived from these keys by `casing: 'snake_case'`, set in
// BOTH drizzle.config.ts (governs generated DDL) and src/client.ts (governs
// runtime queries). Those two must always agree.
export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  // Stored already-lowercased; normalize at the write boundary in app code.
  // A plain unique index then gives case-insensitive uniqueness without a
  // lower(email) functional index that every query would have to opt into.
  // 320 = 64-char local part + '@' + 255-char domain.
  email: varchar({ length: 320 }).notNull().unique(),
  // 255 covers bcrypt (60) and argon2id (~100) with headroom.
  passwordHash: varchar({ length: 255 }).notNull(),
  displayName: varchar({ length: DISPLAY_VARCHAR_MAX }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  // ORM-side only: fires on db.update(users), not on raw SQL or Studio edits.
  // Needs a Postgres trigger if direct SQL writes ever land.
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Enum type names are NOT affected by `casing`, so they're snake_case here.
export const habitTypeEnum = pgEnum('habit_type', ['binary', 'numeric', 'tiered']);

export const habitLifecycleEnum = pgEnum('habit_lifecycle', [
  'draft',
  'active',
  'paused',
  'archived',
]);

export const periodUnitEnum = pgEnum('period_unit', ['day', 'week']);

export type HabitLifecycle = (typeof habitLifecycleEnum.enumValues)[number];

export const habits = pgTable(
  'habits',
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerId: uuid()
      .notNull()
      .references(() => users.id, {
        onDelete: 'cascade',
      }),
    name: varchar({ length: DISPLAY_VARCHAR_MAX }).notNull(),
    type: habitTypeEnum().notNull(),
    // Numeric habits only, e.g. "minutes". See habits_unit_iff_numeric.
    unit: varchar({ length: DISPLAY_VARCHAR_MAX }),
    periodUnit: periodUnitEnum().notNull().default('day'),
    periodLength: integer().notNull().default(1),
    quota: integer().notNull().default(1),
    lifecycle: habitLifecycleEnum().notNull().default('draft'),
    startedAt: timestamp({ withTimezone: true }),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // ORM-side only: fires on db.update(habits), not on raw SQL or Studio edits.
    // Needs a Postgres trigger if direct SQL writes ever land.
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('habits_owner_id_idx').on(table.ownerId),
    // unit is non-null iff type = 'numeric'
    check(
      'habits_unit_iff_numeric',
      sql`(${table.type} = 'numeric') = (${table.unit} IS NOT NULL)`
    ),
    check('habits_quota_positive', sql`${table.quota} >= 1`),
    check('habits_period_length_positive', sql`${table.periodLength} >= 1`),
  ]
);

// No user_id here on purpose: a habit has exactly one owner, so its tiers are
// already per-person through habits.owner_id. Don't add a redundant column.
//
// Invariant (service layer, not DB): every type = 'tiered' habit has a
// tier_index = 0 row, and only tiered habits have tiers. See habitTiers.ts.
// tier_index gaps (0, 1, 3) are fine; reordering never renumbers.
export const habitTiers = pgTable(
  'habit_tiers',
  {
    id: uuid().primaryKey().defaultRandom(),
    habitId: uuid()
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    // 0 = base tier, the one the tower checks.
    tierIndex: smallint().notNull(),
    label: varchar({ length: DISPLAY_VARCHAR_MAX }).notNull(),
    thresholdValue: numeric({ mode: 'number' }),
  },
  (table) => [
    // Leading habit_id also serves FK lookups and cascades; no separate index.
    unique('habit_tiers_habit_id_tier_index_unique').on(table.habitId, table.tierIndex),
    check('habit_tiers_tier_index_nonnegative', sql`${table.tierIndex} >= 0`),
  ]
);
