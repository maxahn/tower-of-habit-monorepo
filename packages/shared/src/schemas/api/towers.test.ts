import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createTowerRequestSchema,
  joinTowerRequestSchema,
  ROSTER_DISPLAY_NAME_MAX,
  towerResponseSchema,
  updateTowerRequestSchema,
  type CreateTowerRequest,
  type JoinTowerRequest,
  type TowerResponse,
  type UpdateTowerRequest,
} from '../index.js';

// Mirrors NewTower / TowerPatch / Tower (towers/towers.ts) and the check
// constraints on towers/schema.ts. hostId comes from auth; lifecycle, height,
// currentStreak and joinCode are server-owned.

const BODY = { name: 'Morning crew', deadlineTime: '22:00', timezone: 'America/Edmonton' };

describe('createTowerRequestSchema', () => {
  it('accepts a minimal daily tower', () => {
    expect(createTowerRequestSchema.parse(BODY)).toMatchObject(BODY);
  });

  it('accepts every optional field', () => {
    const body = {
      ...BODY,
      periodUnit: 'week',
      periodLength: 7,
      quota: 3,
      weekResetDay: 1,
      wobbleLeadMinutes: 60,
      nudgeLeadMinutes: 180,
      graceWindowMinutes: 0,
    };
    expect(createTowerRequestSchema.safeParse(body).success).toBe(true);
  });

  it.each(['00:00', '09:30', '23:59'])('accepts a deadlineTime of %p', (deadlineTime) => {
    expect(createTowerRequestSchema.safeParse({ ...BODY, deadlineTime }).success).toBe(true);
  });

  it.each(['24:00', '9:30', '22:60', '22', '22:00:00', '', '10pm'])(
    'rejects a deadlineTime of %p',
    (deadlineTime) => {
      expect(createTowerRequestSchema.safeParse({ ...BODY, deadlineTime }).success).toBe(false);
    }
  );

  // Postgres would store an abbreviation, and every deadline for the tower
  // would then be wrong. Same rule as isValidTimeZone in @tower-of-habit/db.
  it.each(['', 'PST', 'EST', 'Not/AZone', 'america/edmonton '])(
    'rejects a timezone of %p',
    (timezone) => {
      expect(createTowerRequestSchema.safeParse({ ...BODY, timezone }).success).toBe(false);
    }
  );

  // towers_grace_window_range
  it.each([0, 360])('accepts a graceWindowMinutes of %p', (graceWindowMinutes) => {
    expect(createTowerRequestSchema.safeParse({ ...BODY, graceWindowMinutes }).success).toBe(true);
  });

  it.each([-1, 361, 1.5])('rejects a graceWindowMinutes of %p', (graceWindowMinutes) => {
    expect(createTowerRequestSchema.safeParse({ ...BODY, graceWindowMinutes }).success).toBe(false);
  });

  // towers_wobble_lead_range + towers_nudge_before_wobble (§5: the private
  // nudge must precede the public broadcast).
  it.each([
    [-1, 240],
    [1440, 1441],
    [120, 120],
    [240, 120],
  ])('rejects wobble %p with nudge %p', (wobbleLeadMinutes, nudgeLeadMinutes) => {
    const body = { ...BODY, wobbleLeadMinutes, nudgeLeadMinutes };
    expect(createTowerRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a nudgeLeadMinutes of a full day', () => {
    const body = { ...BODY, wobbleLeadMinutes: 60, nudgeLeadMinutes: 1440 };
    expect(createTowerRequestSchema.safeParse(body).success).toBe(false);
  });

  // The defaults are 120/240, so a lone wobble that overtakes the default
  // nudge must be rejected too.
  it('checks a lone wobble against the default nudge', () => {
    expect(createTowerRequestSchema.safeParse({ ...BODY, wobbleLeadMinutes: 300 }).success).toBe(
      false
    );
  });

  // towers_quota_range
  it('rejects a quota above periodLength', () => {
    const body = { ...BODY, periodUnit: 'week', weekResetDay: 1, periodLength: 7, quota: 8 };
    expect(createTowerRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each([0, -1, 1.5])('rejects a quota of %p', (quota) => {
    expect(createTowerRequestSchema.safeParse({ ...BODY, quota }).success).toBe(false);
  });

  // towers_week_reset_day_iff_week + towers_week_reset_day_range
  it('requires weekResetDay for a weekly tower', () => {
    const body = { ...BODY, periodUnit: 'week', periodLength: 7, quota: 3 };
    expect(createTowerRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects weekResetDay on a daily tower', () => {
    expect(createTowerRequestSchema.safeParse({ ...BODY, weekResetDay: 1 }).success).toBe(false);
  });

  it.each([-1, 7, 1.5])('rejects a weekResetDay of %p', (weekResetDay) => {
    const body = { ...BODY, periodUnit: 'week', periodLength: 7, quota: 3, weekResetDay };
    expect(createTowerRequestSchema.safeParse(body).success).toBe(false);
  });

  it('bounds the name', () => {
    const at = 'x'.repeat(ROSTER_DISPLAY_NAME_MAX);
    expect(createTowerRequestSchema.safeParse({ ...BODY, name: at }).success).toBe(true);
    expect(createTowerRequestSchema.safeParse({ ...BODY, name: `${at}x` }).success).toBe(false);
    expect(createTowerRequestSchema.safeParse({ ...BODY, name: '' }).success).toBe(false);
  });

  it.each([
    ['hostId', '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11'],
    ['joinCode', 'ABCD2345'],
    ['lifecycle', 'active'],
    ['height', 10],
    ['currentStreak', 3],
    ['startedAt', '2026-01-01T00:00:00.000Z'],
  ])('rejects a client-supplied %s', (key, value) => {
    expect(createTowerRequestSchema.safeParse({ ...BODY, [key]: value }).success).toBe(false);
  });

  it('infers a non-any type', () => {
    expectTypeOf<CreateTowerRequest>().not.toBeAny();
    expectTypeOf<CreateTowerRequest>().not.toHaveProperty('hostId');
    expectTypeOf<CreateTowerRequest['deadlineTime']>().toEqualTypeOf<string>();
  });
});

describe('updateTowerRequestSchema', () => {
  it.each([{}, { name: 'Renamed' }, { graceWindowMinutes: 30 }, { timezone: 'UTC' }])(
    'accepts %o',
    (patch) => {
      expect(updateTowerRequestSchema.safeParse(patch).success).toBe(true);
    }
  );

  // Pairwise rules can only be checked when both sides are in the patch; the
  // db constraint is the backstop for the rest.
  it('rejects a patch whose own wobble and nudge are out of order', () => {
    const patch = { wobbleLeadMinutes: 240, nudgeLeadMinutes: 120 };
    expect(updateTowerRequestSchema.safeParse(patch).success).toBe(false);
  });

  it.each([
    { hostId: '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11' },
    { joinCode: 'ABCD2345' },
    { lifecycle: 'archived' },
    { timezone: 'PST' },
    { deadlineTime: '25:00' },
    { graceWindowMinutes: 361 },
  ])('rejects %o', (patch) => {
    expect(updateTowerRequestSchema.safeParse(patch).success).toBe(false);
  });

  it('infers an all-optional type', () => {
    expectTypeOf<UpdateTowerRequest>().not.toBeAny();
    expectTypeOf({}).toExtend<UpdateTowerRequest>();
  });
});

describe('joinTowerRequestSchema', () => {
  const JOIN = { joinCode: 'ABCD2345', habitId: '9b2e4c1a-0d6f-4f7e-8a3b-2c5d6e7f8a90' };

  it('accepts a join code and habit', () => {
    expect(joinTowerRequestSchema.safeParse(JOIN).success).toBe(true);
  });

  // join_code is citext: case never matters.
  it('accepts a lower-case join code', () => {
    expect(joinTowerRequestSchema.safeParse({ ...JOIN, joinCode: 'abcd2345' }).success).toBe(true);
  });

  // generateJoinCode: 8 characters, no 0/O/1/I/L.
  it.each(['', 'ABCD234', 'ABCD23456', 'ABCD234O', 'ABCD2340', 'ABCD234I', 'ABCD234L', 'ABCD-234'])(
    'rejects a joinCode of %p',
    (joinCode) => {
      expect(joinTowerRequestSchema.safeParse({ ...JOIN, joinCode }).success).toBe(false);
    }
  );

  it('rejects a non-uuid habitId', () => {
    expect(joinTowerRequestSchema.safeParse({ ...JOIN, habitId: 'h1' }).success).toBe(false);
  });

  it('rejects a client-supplied userId', () => {
    const body = { ...JOIN, userId: '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11' };
    expect(joinTowerRequestSchema.safeParse(body).success).toBe(false);
  });

  it('infers a non-any type', () => {
    expectTypeOf<JoinTowerRequest>().not.toBeAny();
    expectTypeOf<JoinTowerRequest>().toEqualTypeOf<{ joinCode: string; habitId: string }>();
  });
});

describe('towerResponseSchema', () => {
  // Postgres `time` serializes with seconds.
  const ROW = {
    id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    hostId: '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11',
    name: 'Morning crew',
    periodUnit: 'day',
    periodLength: 1,
    quota: 1,
    deadlineTime: '22:00:00',
    timezone: 'America/Edmonton',
    weekResetDay: null,
    joinCode: 'ABCD2345',
    wobbleLeadMinutes: 120,
    nudgeLeadMinutes: 240,
    graceWindowMinutes: 120,
    lifecycle: 'active',
    height: 12,
    currentStreak: 4,
    startedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2025-12-31T18:00:00.000Z',
  };

  it('accepts a serialized tower row', () => {
    expect(towerResponseSchema.parse(ROW)).toEqual(ROW);
  });

  it.each([
    ['lifecycle', 'deleted'],
    ['periodUnit', 'month'],
    ['height', -1],
    ['currentStreak', -1],
    ['deadlineTime', 'ten'],
  ])('rejects a %s of %p', (key, value) => {
    expect(towerResponseSchema.safeParse({ ...ROW, [key]: value }).success).toBe(false);
  });

  it.each(['id', 'hostId', 'joinCode', 'lifecycle', 'height', 'deadlineTime'])(
    'requires %s',
    (key) => {
      const partial: Record<string, unknown> = { ...ROW };
      delete partial[key];
      expect(towerResponseSchema.safeParse(partial).success).toBe(false);
    }
  );

  it('infers the shared enums', () => {
    expectTypeOf<TowerResponse>().not.toBeAny();
    expectTypeOf<TowerResponse['lifecycle']>().toEqualTypeOf<
      'draft' | 'active' | 'paused' | 'archived'
    >();
    expectTypeOf<TowerResponse['periodUnit']>().toEqualTypeOf<'day' | 'week'>();
    expectTypeOf<TowerResponse['weekResetDay']>().toEqualTypeOf<number | null>();
  });
});
