import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTower,
  deleteTower,
  generateJoinCode,
  InvalidTimeZoneError,
  isValidTimeZone,
  TowerNotFoundError,
  updateTower,
  type NewTower,
} from './towers.js';
import { users } from '../users/schema.js';
import { DEFAULT_DEADLINE_TIME, towers } from './schema.js';
import { db, pgError, useTestOwner } from '../test-utils.js';

const owner = useTestOwner();

// host_id is ON DELETE RESTRICT, so towers must go before the owner. Vitest
// runs afterEach hooks in reverse registration order: this one runs first.
afterEach(async () => {
  await db.delete(towers).where(eq(towers.hostId, owner()));
});

function tower(overrides: Partial<NewTower> = {}) {
  return createTower(db, {
    hostId: owner(),
    name: 'Morning run',
    deadlineTime: DEFAULT_DEADLINE_TIME,
    timezone: 'America/Edmonton',
    ...overrides,
  });
}

/** Bypasses the service, for evaluator-owned columns it won't write. */
async function rawInsert(values: Partial<typeof towers.$inferInsert>) {
  return db
    .insert(towers)
    .values({
      hostId: owner(),
      name: 'x',
      deadlineTime: DEFAULT_DEADLINE_TIME,
      timezone: 'America/Edmonton',
      joinCode: generateJoinCode(),
      ...values,
    })
    .returning();
}

async function checkViolation(p: Promise<unknown>) {
  const e = await pgError(p);
  expect(e.code).toBe('23514');
  return e.constraint_name;
}

describe('isValidTimeZone', () => {
  it.each(['America/Edmonton', 'Asia/Kolkata', 'Europe/Kyiv', 'US/Pacific', 'UTC'])(
    'accepts %s',
    (tz) => expect(isValidTimeZone(tz)).toBe(true)
  );

  it.each(['PST', 'EST', 'MST', '', 'Not/AZone', '+05:00'])('rejects %j', (tz) =>
    expect(isValidTimeZone(tz)).toBe(false)
  );
});

describe('generateJoinCode', () => {
  it('produces 8 unambiguous characters', () => {
    expect(generateJoinCode()).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
  });
});

describe('towers CRUD', () => {
  it('inserts with spec defaults', async () => {
    const t = await tower();
    expect(t).toMatchObject({
      periodUnit: 'day',
      periodLength: 1,
      quota: 1,
      deadlineTime: '22:00:00',
      timezone: 'America/Edmonton',
      weekResetDay: null,
      wobbleLeadMinutes: 120,
      nudgeLeadMinutes: 240,
      graceWindowMinutes: 120,
      lifecycle: 'draft',
      height: 0,
      currentStreak: 0,
      startedAt: null,
    });
    expect(t.joinCode).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(t.createdAt).toBeInstanceOf(Date);
  });

  it('keeps a supplied join code', async () => {
    const joinCode = generateJoinCode();
    expect((await tower({ joinCode })).joinCode).toBe(joinCode);
  });

  it('rejects a tower added with already assigned join code', async () => {
    const joinCode = generateJoinCode();
    expect((await tower({ joinCode })).joinCode).toBe(joinCode);
    const e = await pgError(tower({ joinCode }));
    // expect(await checkViolation(secondTower)).toBe('towers_join_code_unique');
    expect(e).toMatchObject({
      code: '23505',
      constraint_name: 'towers_join_code_unique',
    });
  });

  it('updates fields', async () => {
    const t = await tower();
    const u = await updateTower(db, t.id, { name: 'Evening run', timezone: 'Asia/Kolkata' });
    expect(u).toMatchObject({ name: 'Evening run', timezone: 'Asia/Kolkata' });
  });

  it('update ignores evaluator-owned and lifecycle fields even if smuggled in untyped', async () => {
    const t = await tower();
    const u = await updateTower(db, t.id, {
      name: 'X',
      height: 99,
      currentStreak: 5,
      lifecycle: 'active',
      hostId: crypto.randomUUID(),
    } as never);
    expect(u).toMatchObject({ name: 'X', height: 0, currentStreak: 0, lifecycle: 'draft' });
    expect(u.hostId).toBe(owner());
  });

  it('update of a missing tower throws', async () => {
    await expect(updateTower(db, crypto.randomUUID(), { name: 'x' })).rejects.toBeInstanceOf(
      TowerNotFoundError
    );
  });

  it('deletes', async () => {
    const t = await tower();
    await deleteTower(db, t.id);
    expect(await db.select().from(towers).where(eq(towers.id, t.id))).toHaveLength(0);
  });
});

describe('towers timezone validation', () => {
  it('rejects "PST" on create and writes nothing', async () => {
    await expect(tower({ timezone: 'PST' })).rejects.toBeInstanceOf(InvalidTimeZoneError);
    expect(await db.select().from(towers).where(eq(towers.hostId, owner()))).toEqual([]);
  });

  it('accepts "America/Edmonton" on create', async () => {
    expect((await tower({ timezone: 'America/Edmonton' })).timezone).toBe('America/Edmonton');
  });

  it('rejects "PST" on update and leaves the row unchanged', async () => {
    const t = await tower();
    await expect(updateTower(db, t.id, { timezone: 'PST' })).rejects.toBeInstanceOf(
      InvalidTimeZoneError
    );
    const [row] = await db.select().from(towers).where(eq(towers.id, t.id));
    expect(row!.timezone).toBe('America/Edmonton');
  });
});

describe('towers constraints', () => {
  it.each([
    { nudgeLeadMinutes: 120, wobbleLeadMinutes: 120 },
    { nudgeLeadMinutes: 60, wobbleLeadMinutes: 120 },
  ])(
    'enforces nudge > wobble (nudge=$nudgeLeadMinutes, wobble=$wobbleLeadMinutes)',
    async (leads) => {
      expect(await checkViolation(tower(leads))).toBe('towers_nudge_before_wobble');
    }
  );

  it('enforces nudge > wobble on update too', async () => {
    const t = await tower();
    expect(await checkViolation(updateTower(db, t.id, { wobbleLeadMinutes: 300 }))).toBe(
      'towers_nudge_before_wobble'
    );
  });

  it.each([400, 361, -1])('rejects grace window %i', async (graceWindowMinutes) => {
    expect(await checkViolation(tower({ graceWindowMinutes }))).toBe('towers_grace_window_range');
  });

  it.each([0, 360])('accepts grace window %i', async (graceWindowMinutes) => {
    expect((await tower({ graceWindowMinutes })).graceWindowMinutes).toBe(graceWindowMinutes);
  });

  it.each([{ quota: 0 }, { quota: 2, periodLength: 1 }, { quota: 1, periodLength: 0 }])(
    'rejects quota/period_length %j',
    async (values) => {
      expect(await checkViolation(tower(values))).toBe('towers_quota_range');
    }
  );

  it('accepts quota = period_length > 1', async () => {
    expect(await tower({ quota: 3, periodLength: 3 })).toMatchObject({ quota: 3, periodLength: 3 });
  });

  // wobble >= 1440 can't be isolated: any valid nudge (< 1440) also breaks
  // nudge > wobble, and Postgres reports whichever check it evaluates first.
  it('rejects wobble lead 1440', async () => {
    const name = await checkViolation(tower({ wobbleLeadMinutes: 1440, nudgeLeadMinutes: 1439 }));
    expect(['towers_wobble_lead_range', 'towers_nudge_before_wobble']).toContain(name);
  });

  it.each([
    { values: { wobbleLeadMinutes: -1 }, name: 'towers_wobble_lead_range' },
    { values: { nudgeLeadMinutes: 1440 }, name: 'towers_nudge_lead_range' },
  ])('rejects lead times $values', async ({ values, name }) => {
    expect(await checkViolation(tower(values))).toBe(name);
  });

  it.each([
    { periodUnit: 'week' as const, weekResetDay: null },
    { periodUnit: 'day' as const, weekResetDay: 1 },
  ])('requires week_reset_day iff weekly ($periodUnit, $weekResetDay)', async (values) => {
    expect(await checkViolation(tower(values))).toBe('towers_week_reset_day_iff_week');
  });

  it('accepts a weekly tower with a reset day', async () => {
    expect(await tower({ periodUnit: 'week', weekResetDay: 1 })).toMatchObject({
      periodUnit: 'week',
      weekResetDay: 1,
    });
  });

  it.each([
    { values: { height: -1 }, name: 'towers_height_nonnegative' },
    { values: { currentStreak: -1 }, name: 'towers_current_streak_nonnegative' },
  ])('rejects $values', async ({ values, name }) => {
    expect(await checkViolation(rawInsert(values))).toBe(name);
  });

  it('rejects a join code differing only by case', async () => {
    await tower({ joinCode: 'abcd2345' });
    const e = await pgError(tower({ joinCode: 'ABCD2345' }));
    expect(e).toMatchObject({ code: '23505', constraint_name: 'towers_join_code_unique' });
  });

  it('requires deadline_time', async () => {
    const e = await pgError(tower({ deadlineTime: null } as never));
    expect(e).toMatchObject({ code: '23502', column_name: 'deadline_time' });
  });

  it('rejects a nonexistent host', async () => {
    const e = await pgError(tower({ hostId: crypto.randomUUID() }));
    expect(e).toMatchObject({ code: '23503' });
  });

  // Interim: host reassignment lands with tower_members. Until then deleting
  // a host must fail rather than cascade or orphan the tower.
  it('blocks deleting a user who hosts a tower', async () => {
    const t = await tower();
    const e = await pgError(db.delete(users).where(eq(users.id, owner())));
    expect(e).toMatchObject({ code: '23503', constraint_name: 'towers_host_id_users_id_fk' });
    expect(await db.select().from(towers).where(eq(towers.id, t.id))).toHaveLength(1);
  });
});
