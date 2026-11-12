import { describe, expect, it } from 'vitest';
// The package entry (package.json "." points here). Resolving the bare
// specifier from a separate consumer is covered by test/package-surface.test.ts.
import * as root from './index.js';
import * as schemas from './schemas/index.js';

const ENUM_EXPORTS = [
  'HABIT_TYPES',
  'habitTypeSchema',
  'HABIT_STATUSES',
  'habitStatusSchema',
  'PERIOD_TYPES',
  'periodTypeSchema',
  'TOWER_STATUSES',
  'towerStatusSchema',
  'MEMBERSHIP_STATES',
  'membershipStateSchema',
  'DORMANCY_REASONS',
  'dormancyReasonSchema',
  'PERIOD_STATUSES',
  'periodStatusSchema',
  'PERIOD_OUTCOMES',
  'periodOutcomeSchema',
  'FREEBIE_SOURCES',
  'freebieSourceSchema',
  'PUSH_PLATFORMS',
  'pushPlatformSchema',
  'NOTIFICATION_STATUSES',
  'notificationStatusSchema',
  'NOTIFICATION_TYPES',
  'notificationTypeSchema',
];

const API_EXPORTS = [
  'createHabitRequestSchema',
  'updateHabitRequestSchema',
  'habitResponseSchema',
  'createHabitTierRequestSchema',
  'updateHabitTierRequestSchema',
  'habitTierResponseSchema',
  'logEntryRequestSchema',
  'entryResponseSchema',
  'createTowerRequestSchema',
  'updateTowerRequestSchema',
  'joinTowerRequestSchema',
  'towerResponseSchema',
  'membershipResponseSchema',
  'towerPeriodResponseSchema',
  'baseBlockResponseSchema',
  'registerPushTokenRequestSchema',
];

// Already shipped before 2.1; moving into the barrel must not drop them.
const EXISTING_EXPORTS = [
  'blockRosterMemberSchema',
  'blockRosterSchema',
  'parseBlockRoster',
  'ROSTER_DISPLAY_NAME_MAX',
];

describe('schemas barrel', () => {
  it.each([...ENUM_EXPORTS, ...API_EXPORTS, ...EXISTING_EXPORTS])(
    'exports %s from ./schemas',
    (name) => {
      expect(schemas).toHaveProperty(name);
      expect((schemas as Record<string, unknown>)[name]).toBeDefined();
    }
  );

  it.each([...ENUM_EXPORTS, ...API_EXPORTS, ...EXISTING_EXPORTS])(
    'exports %s from the package root',
    (name) => {
      expect((root as Record<string, unknown>)[name]).toBeDefined();
    }
  );

  // One barrel, re-exported: the root hands out the very same objects, so
  // nothing reachable through ./schemas needs a deep import.
  it('re-exports every schemas export from the root, by identity', () => {
    for (const [name, value] of Object.entries(schemas)) {
      expect((root as Record<string, unknown>)[name], name).toBe(value);
    }
  });

  it('exposes every *Schema export as a zod schema', () => {
    for (const [name, value] of Object.entries(schemas)) {
      if (!name.endsWith('Schema')) continue;
      expect(typeof (value as { safeParse?: unknown }).safeParse, name).toBe('function');
    }
  });
});
