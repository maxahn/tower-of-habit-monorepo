import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { citext, DISPLAY_VARCHAR_MAX } from '../columns.js';
import { periodUnitEnum } from '../habits/schema.js';
import { users } from '../users/schema.js';

export const towerLifecycleEnum = pgEnum('tower_lifecycle', [
  'draft',
  'active',
  'paused',
  'archived',
]);

export type TowerLifecycle = (typeof towerLifecycleEnum.enumValues)[number];

// Picker default (tickets 2.6 / 5.6), deliberately not 23:59: a 23:59
// deadline plus the 2h grace evaluates at 01:59 and drags the whole
// escalation chain into the small hours. No DB default; the client sends it.
export const DEFAULT_DEADLINE_TIME = '22:00';

export const towers = pgTable(
  'towers',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Restrict for now. Intended behaviour once tower_members exists: deleting
    // the host reassigns a random remaining member as host, or deletes the
    // tower if none remain (trigger on users, so raw SQL deletes are covered).
    hostId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: varchar({ length: DISPLAY_VARCHAR_MAX }).notNull(),
    // v1 hard-codes 1/1, but storing these keeps v2 a configuration change.
    periodUnit: periodUnitEnum().notNull().default('day'),
    periodLength: integer().notNull().default(1),
    quota: integer().notNull().default(1),
    deadlineTime: time().notNull(),
    // IANA identifier, e.g. "America/Edmonton". Validated app-side by
    // isValidTimeZone (towers.ts): Postgres would accept abbreviations like
    // "PST", and a bad value here makes every deadline for the tower wrong.
    timezone: text().notNull(),
    // v2; null for daily towers. See towers_week_reset_day_iff_week.
    weekResetDay: smallint(),
    joinCode: citext().notNull(),
    wobbleLeadMinutes: integer().notNull().default(120),
    nudgeLeadMinutes: integer().notNull().default(240),
    // DR-001. 0 reproduces the hard-cliff behaviour exactly.
    graceWindowMinutes: integer().notNull().default(120),
    lifecycle: towerLifecycleEnum().notNull().default('draft'),
    // Denormalised and evaluator-owned: written in the same transaction as the
    // period evaluation. The 1.12 recompute function derives both from entries
    // and periods and is the correctness oracle for these columns.
    height: integer().notNull().default(0),
    currentStreak: integer().notNull().default(0),
    startedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // FK columns aren't indexed automatically; restrict checks scan this.
    index('towers_host_id_idx').on(table.hostId),
    // Named explicitly: the default would be towers_joinCode_unique.
    unique('towers_join_code_unique').on(table.joinCode),
    // Also implies period_length >= 1.
    check(
      'towers_quota_range',
      sql`${table.quota} >= 1 AND ${table.quota} <= ${table.periodLength}`
    ),
    check(
      'towers_wobble_lead_range',
      sql`${table.wobbleLeadMinutes} >= 0 AND ${table.wobbleLeadMinutes} < 1440`
    ),
    check('towers_nudge_lead_range', sql`${table.nudgeLeadMinutes} < 1440`),
    // Load-bearing (§5): the private nudge must precede the public broadcast.
    check(
      'towers_nudge_before_wobble',
      sql`${table.nudgeLeadMinutes} > ${table.wobbleLeadMinutes}`
    ),
    // week_reset_day is non-null iff period_unit = 'week'
    check(
      'towers_week_reset_day_iff_week',
      sql`(${table.periodUnit} = 'week') = (${table.weekResetDay} IS NOT NULL)`
    ),
    // 0 = Sunday .. 6 = Saturday, matching Date#getUTCDay (dayOfWeek in
    // @tower-of-habit/shared).
    check(
      'towers_week_reset_day_range',
      sql`${table.weekResetDay} IS NULL OR ${table.weekResetDay} BETWEEN 0 AND 6`
    ),
    check('towers_height_nonnegative', sql`${table.height} >= 0`),
    check('towers_current_streak_nonnegative', sql`${table.currentStreak} >= 0`),
    check('towers_grace_window_range', sql`${table.graceWindowMinutes} BETWEEN 0 AND 360`),
  ]
);
