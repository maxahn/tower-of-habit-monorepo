import { sql } from 'drizzle-orm';
import { check, numeric, pgTable, smallint, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { DISPLAY_VARCHAR_MAX } from '../../columns.js';
import { habits } from '../schema.js';

// No user_id here on purpose: a habit has exactly one owner, so its tiers are
// already per-person through habits.owner_id. Don't add a redundant column.
//
// Invariant (service layer, not DB): every type = 'tiered' habit has a
// tier_index = 0 row, and only tiered habits have tiers. See tiers.ts.
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
