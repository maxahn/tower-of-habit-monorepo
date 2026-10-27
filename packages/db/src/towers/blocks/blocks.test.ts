import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ROSTER_DISPLAY_NAME_MAX, type BlockRosterMember } from '@tower-of-habit/shared';
import { DISPLAY_VARCHAR_MAX } from '../../columns.js';
import { db, pgError, useTestOwner } from '../../test-utils.js';
import { DEFAULT_DEADLINE_TIME, towers } from '../schema.js';
import { createTower, deleteTower, TowerNotFoundError } from '../towers.js';
import {
  appendBaseBlock,
  findOrdinalGaps,
  getBaseBlock,
  InvalidRosterError,
  latestBaseBlock,
  listBaseBlocksForTower,
  type NewBaseBlock,
} from './blocks.js';
import { baseBlocks } from './schema.js';

// 10 qualifying days out of 10.
const RUN_A = { runStartDate: '2026-01-01', runEndDate: '2026-01-10', blockHeight: 10 };
// Two days: below §5's ~3-day floor, so 3.9 produces NO block for it. Present
// only so the gapless test has something concrete to skip.
const RUN_SHORT = { runStartDate: '2026-01-12', runEndDate: '2026-01-13', blockHeight: 2 };
// The spec's example: 27 qualifying days in a 30-day run.
const RUN_C = { runStartDate: '2026-01-15', runEndDate: '2026-02-13', blockHeight: 27 };

const owner = useTestOwner();

// base_blocks cascades from towers, so it needs no cleanup of its own. Towers
// must go before the owner (host_id is ON DELETE RESTRICT). Vitest runs
// afterEach hooks in reverse registration order: this one runs first.
afterEach(async () => {
  await db.delete(towers).where(eq(towers.hostId, owner()));
});

function tower() {
  return createTower(db, {
    hostId: owner(),
    name: 'Morning run',
    deadlineTime: DEFAULT_DEADLINE_TIME,
    timezone: 'America/Edmonton',
  });
}

function member(overrides: Partial<BlockRosterMember> = {}): BlockRosterMember {
  return {
    user_id: crypto.randomUUID(),
    display_name: 'Sam',
    qualifying_days: 27,
    total_days: 30,
    highest_tier: 3,
    was_dormant: false,
    ...overrides,
  };
}

function append(towerId: string, run = RUN_A, overrides: Partial<NewBaseBlock> = {}) {
  return appendBaseBlock(db, { towerId, ...run, roster: [member()], ...overrides });
}

/** Bypasses the service, for ordinals and rosters it won't write. */
function rawInsert(values: Partial<typeof baseBlocks.$inferInsert> & { towerId: string }) {
  return db
    .insert(baseBlocks)
    .values({ ordinal: 1, ...RUN_A, roster: [member()], ...values })
    .returning();
}

/** Raw SQL, for roster values TS can't express. */
function rawSqlInsert(towerId: string, rosterLiteral: string, ordinal = 1) {
  return db.execute(sql`
    insert into ${baseBlocks} (tower_id, ordinal, run_start_date, run_end_date, block_height, roster)
    values (${towerId}, ${ordinal}, '2026-01-01', '2026-01-10', 10, ${rosterLiteral}::jsonb)`);
}

async function checkViolation(p: Promise<unknown>) {
  const e = await pgError(p);
  expect(e.code).toBe('23514');
  return e.constraint_name;
}

async function ordinalsFor(towerId: string) {
  return (await listBaseBlocksForTower(db, towerId)).map((b) => b.ordinal);
}

// "Done when" #1: a block can be written and read back.
describe('base_blocks write and read back', () => {
  it('writes a block and reads it back unchanged', async () => {
    const t = await tower();
    const written = await append(t.id);
    expect(written).toMatchObject({ towerId: t.id, ordinal: 1, ...RUN_A });
    expect(written.createdAt).toBeInstanceOf(Date);
    expect(await getBaseBlock(db, written.id)).toEqual(written);
    expect(await listBaseBlocksForTower(db, t.id)).toEqual([written]);
  });

  it('reads dates back as plain YYYY-MM-DD strings, not Dates', async () => {
    const t = await tower();
    const b = await append(t.id, RUN_C);
    expect(b.runStartDate).toBe('2026-01-15');
    expect(b.runEndDate).toBe('2026-02-13');
  });

  it('returns undefined for an unknown id and [] for a tower with no blocks', async () => {
    const t = await tower();
    expect(await getBaseBlock(db, crypto.randomUUID())).toBeUndefined();
    expect(await listBaseBlocksForTower(db, t.id)).toEqual([]);
    expect(await latestBaseBlock(db, t.id)).toBeUndefined();
  });

  it('orders the stack deepest-first and exposes the top block', async () => {
    const t = await tower();
    const first = await append(t.id, RUN_A);
    const second = await append(t.id, RUN_C);
    expect(await ordinalsFor(t.id)).toEqual([1, 2]);
    expect((await listBaseBlocksForTower(db, t.id))[0]!.id).toBe(first.id);
    expect(await latestBaseBlock(db, t.id)).toMatchObject({ id: second.id, ordinal: 2 });
  });

  it('cascades on tower delete', async () => {
    const t = await tower();
    const b = await append(t.id);
    await deleteTower(db, t.id);
    expect(await getBaseBlock(db, b.id)).toBeUndefined();
  });
});

// "Done when" #2: ordinal sequencing is gapless across a skipped short run.
describe('ordinal allocation', () => {
  it('allocates 1, 2, 3 on successive appends', async () => {
    const t = await tower();
    expect((await append(t.id)).ordinal).toBe(1);
    expect((await append(t.id)).ordinal).toBe(2);
    expect((await append(t.id)).ordinal).toBe(3);
  });

  // The ticket's core sequencing requirement. RUN_SHORT is below §5's floor, so
  // 3.9 writes nothing for it — and because ordinal is a position in the stack
  // rather than a run counter, it consumes no number.
  it('stays gapless when a short run is skipped', async () => {
    const t = await tower();
    const first = await append(t.id, RUN_A);
    // RUN_SHORT happens here and is deliberately NOT appended.
    void RUN_SHORT;
    const second = await append(t.id, RUN_C);
    expect([first.ordinal, second.ordinal]).toEqual([1, 2]);
    const stack = await listBaseBlocksForTower(db, t.id);
    expect(stack.map((b) => b.ordinal)).toEqual([1, 2]);
    // The gap is visible in the dates and absent from the ordinals.
    expect(stack.map((b) => b.runStartDate)).toEqual([RUN_A.runStartDate, RUN_C.runStartDate]);
    expect(await findOrdinalGaps(db)).toEqual([]);
  });

  it('allocates per tower, not globally', async () => {
    const [a, b] = await Promise.all([tower(), tower()]);
    expect((await append(a.id)).ordinal).toBe(1);
    expect((await append(b.id)).ordinal).toBe(1);
  });

  it('ignores a caller-supplied ordinal, id and createdAt', async () => {
    const t = await tower();
    const b = await appendBaseBlock(db, {
      towerId: t.id,
      ...RUN_A,
      roster: [member()],
      ordinal: 7,
      id: crypto.randomUUID(),
      createdAt: new Date(0),
    } as never);
    expect(b.ordinal).toBe(1);
    expect(b.createdAt.getFullYear()).toBeGreaterThan(2000);
  });

  it('throws TowerNotFoundError for an unknown tower', async () => {
    await expect(append(crypto.randomUUID())).rejects.toBeInstanceOf(TowerNotFoundError);
  });

  // The towers row lock, not the unique index, is what serialises these: each
  // append runs in its own transaction on its own pooled connection.
  it('serialises five concurrent appends into 1..5 with no duplicates or gaps', async () => {
    const t = await tower();
    const blocks = await Promise.all(Array.from({ length: 5 }, () => append(t.id)));
    expect(blocks.map((b) => b.ordinal).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
    expect(await ordinalsFor(t.id)).toEqual([1, 2, 3, 4, 5]);
    expect(await findOrdinalGaps(db)).toEqual([]);
  });

  // Proves the lock is actually taken: an append cannot proceed while someone
  // else holds the tower's row, and completes once they let go.
  it('waits on a held towers row lock, then allocates', async () => {
    const t = await tower();
    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });

    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from ${towers} where ${towers.id} = ${t.id} for update`);
      locked();
      await released;
    });
    await isLocked;

    let done = false;
    const appended = append(t.id).then((b) => {
      done = true;
      return b;
    });
    // Long enough for the append to reach the lock and park on it.
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);

    release();
    await holder;
    expect(await appended).toMatchObject({ ordinal: 1 });
  });
});

// "Done when" #3: roster JSONB round-trips with a typed schema.
describe('roster jsonb round-trip', () => {
  it('round-trips a multi-member roster through write and read', async () => {
    const t = await tower();
    const roster = [
      member({ display_name: 'Sam', qualifying_days: 27, total_days: 30, highest_tier: 3 }),
      member({
        display_name: 'Ada',
        qualifying_days: 0,
        total_days: 30,
        highest_tier: 0,
        was_dormant: true,
      }),
      member({ display_name: 'Lee', qualifying_days: 30, total_days: 30, highest_tier: 1 }),
    ];
    const written = await append(t.id, RUN_C, { roster });
    const read = await getBaseBlock(db, written.id);
    expect(read!.roster).toEqual(roster);
    // What jsonb could plausibly mangle: arrayness, number/string, boolean.
    expect(Array.isArray(read!.roster)).toBe(true);
    expect(typeof read!.roster[0]!.qualifying_days).toBe('number');
    expect(read!.roster[1]!.was_dormant).toBe(true);
    expect(read!.roster[1]!.highest_tier).toBe(0);
    // Order is part of the snapshot.
    expect(read!.roster.map((m) => m.display_name)).toEqual(['Sam', 'Ada', 'Lee']);
    expect((await listBaseBlocksForTower(db, t.id))[0]!.roster).toEqual(roster);
  });

  // The keys are stored bytes and permanent; this is the test that pins them.
  it('stores snake_case keys, as the spec writes them', async () => {
    const t = await tower();
    const m = member();
    await append(t.id, RUN_A, { roster: [m] });
    const rows = (await db.execute(sql`
      select ${baseBlocks.roster} -> 0 ->> 'user_id' as user_id,
             ${baseBlocks.roster} -> 0 ->> 'display_name' as display_name,
             ${baseBlocks.roster} -> 0 -> 'was_dormant' as was_dormant,
             jsonb_object_keys_count.keys as keys
        from ${baseBlocks},
             lateral (select count(*) as keys
                        from jsonb_object_keys(${baseBlocks.roster} -> 0)) jsonb_object_keys_count
       where ${baseBlocks.towerId} = ${t.id}`)) as unknown as {
      user_id: string;
      display_name: string;
      was_dormant: boolean;
      keys: string;
    }[];
    expect(rows[0]).toMatchObject({ user_id: m.user_id, display_name: 'Sam' });
    // Six keys, so nothing extra rode along into the snapshot.
    expect(Number(rows[0]!.keys)).toBe(6);
  });

  it('round-trips a display_name with quotes, a backslash and emoji', async () => {
    const t = await tower();
    const display_name = 'Sam "the \\ hammer" 🧱';
    const b = await append(t.id, RUN_A, { roster: [member({ display_name })] });
    expect((await getBaseBlock(db, b.id))!.roster[0]!.display_name).toBe(display_name);
  });

  it('accepts a display_name at the DISPLAY_VARCHAR_MAX boundary', async () => {
    const t = await tower();
    const display_name = 'x'.repeat(ROSTER_DISPLAY_NAME_MAX);
    const b = await append(t.id, RUN_A, { roster: [member({ display_name })] });
    expect((await getBaseBlock(db, b.id))!.roster[0]!.display_name).toHaveLength(60);
  });

  // The duplicated constant the eslint firewall forces on packages/shared.
  it('keeps the roster name limit in step with DISPLAY_VARCHAR_MAX', () => {
    expect(ROSTER_DISPLAY_NAME_MAX).toBe(DISPLAY_VARCHAR_MAX);
  });

  it('rejects an invalid roster before touching the database', async () => {
    const t = await tower();
    const err = await append(t.id, RUN_A, {
      roster: [member({ qualifying_days: 31, total_days: 30 })],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidRosterError);
    expect((err as InvalidRosterError).issues[0]).toMatchObject({ path: '0.qualifying_days' });
    expect(await listBaseBlocksForTower(db, t.id)).toEqual([]);
  });

  it('rejects an empty roster in the service', async () => {
    const t = await tower();
    await expect(append(t.id, RUN_A, { roster: [] })).rejects.toBeInstanceOf(InvalidRosterError);
  });

  it('rejects a roster carrying caused_collapse (§5), even inside the JSON', async () => {
    const t = await tower();
    const err = await append(t.id, RUN_A, {
      roster: [{ ...member(), caused_collapse: true }],
    } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidRosterError);
    expect(await listBaseBlocksForTower(db, t.id)).toEqual([]);
  });

  // Proves the read path parses: this roster satisfies the CHECK (a non-empty
  // array) but not the typed schema, so a hand-edited row cannot escape as
  // valid just because $type<> says it is.
  it('rejects a hand-written row whose roster fails the typed schema', async () => {
    const t = await tower();
    await rawSqlInsert(t.id, '[{"user_id": "not-a-uuid"}]');
    const [row] = await db.select().from(baseBlocks).where(eq(baseBlocks.towerId, t.id));
    const err = await getBaseBlock(db, row!.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidRosterError);
    expect(err).toMatchObject({ blockId: row!.id });
    await expect(listBaseBlocksForTower(db, t.id)).rejects.toBeInstanceOf(InvalidRosterError);
  });
});

describe('base_blocks constraints', () => {
  it.each([0, -1])('rejects ordinal %i', async (ordinal) => {
    const t = await tower();
    expect(await checkViolation(rawInsert({ towerId: t.id, ordinal }))).toBe(
      'base_blocks_ordinal_positive'
    );
  });

  it('accepts ordinal 1', async () => {
    const t = await tower();
    const [b] = await rawInsert({ towerId: t.id, ordinal: 1 });
    expect(b!.ordinal).toBe(1);
  });

  // Either constraint may name itself here, and the row is rejected regardless.
  // A reversed range cannot trip run_end_after_start alone: the span goes
  // negative, so block_height_within_run (height >= 1 > span) is violated too,
  // and Postgres is free to evaluate the two in either order.
  it('rejects a run ending before it starts', async () => {
    const t = await tower();
    expect(['base_blocks_run_end_after_start', 'base_blocks_block_height_within_run']).toContain(
      await checkViolation(
        rawInsert({
          towerId: t.id,
          runStartDate: '2026-01-10',
          runEndDate: '2026-01-01',
          blockHeight: 1,
        })
      )
    );
  });

  // Shorter than §5's ~3-day floor, and the database accepts it on purpose:
  // 3.9 owns that rule, not a constraint.
  it('accepts a single-day run with height 1', async () => {
    const t = await tower();
    const [b] = await rawInsert({
      towerId: t.id,
      runStartDate: '2026-01-01',
      runEndDate: '2026-01-01',
      blockHeight: 1,
    });
    expect(b).toMatchObject({ runStartDate: '2026-01-01', blockHeight: 1 });
  });

  it.each([0, -1])('rejects block_height %i', async (blockHeight) => {
    const t = await tower();
    expect(await checkViolation(rawInsert({ towerId: t.id, blockHeight }))).toBe(
      'base_blocks_block_height_positive'
    );
  });

  it('rejects more qualifying days than days in the run', async () => {
    const t = await tower();
    expect(await checkViolation(rawInsert({ towerId: t.id, ...RUN_A, blockHeight: 11 }))).toBe(
      'base_blocks_block_height_within_run'
    );
  });

  it('accepts a block_height equal to the days in the run', async () => {
    const t = await tower();
    const [b] = await rawInsert({ towerId: t.id, ...RUN_A, blockHeight: 10 });
    expect(b!.blockHeight).toBe(10);
  });

  // Values TS can't express. One CHECK, not two, so the error is always a named
  // 23514 and never a raw 22023 from jsonb_array_length on a non-array.
  it.each(['{}', '"sam"', '3', 'null', 'true', '[]'])('rejects a roster of %s', async (literal) => {
    const t = await tower();
    expect(await pgError(rawSqlInsert(t.id, literal))).toMatchObject({
      code: '23514',
      constraint_name: 'base_blocks_roster_nonempty_array',
    });
  });

  it('rejects a duplicate (tower_id, ordinal)', async () => {
    const t = await tower();
    await rawInsert({ towerId: t.id, ordinal: 1 });
    expect(await pgError(rawInsert({ towerId: t.id, ordinal: 1 }))).toMatchObject({
      code: '23505',
      constraint_name: 'base_blocks_tower_id_ordinal_unique',
    });
  });

  it('allows the same ordinal in two different towers', async () => {
    const [a, b] = await Promise.all([tower(), tower()]);
    await rawInsert({ towerId: a.id, ordinal: 1 });
    const [second] = await rawInsert({ towerId: b.id, ordinal: 1 });
    expect(second!.ordinal).toBe(1);
  });

  it.each(['ordinal', 'runStartDate', 'runEndDate', 'blockHeight', 'roster'])(
    'requires %s',
    async (key) => {
      const t = await tower();
      expect(await pgError(rawInsert({ towerId: t.id, [key]: null }))).toMatchObject({
        code: '23502',
      });
    }
  );

  it('rejects a block for a tower that does not exist', async () => {
    expect(await pgError(rawInsert({ towerId: crypto.randomUUID() }))).toMatchObject({
      code: '23503',
      constraint_name: 'base_blocks_tower_id_towers_id_fk',
    });
  });

  // The §5 product decision, with a regression guard: a future migration adding
  // ANY column to this table has to come through this list deliberately.
  it('has exactly the specified columns, and no caused_collapse (§5)', async () => {
    const rows = (await db.execute(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'base_blocks'
       order by column_name`)) as unknown as { column_name: string }[];
    expect(rows.map((r) => r.column_name)).toEqual([
      'block_height',
      'created_at',
      'id',
      'ordinal',
      'roster',
      'run_end_date',
      'run_start_date',
      'tower_id',
    ]);
  });
});

describe('findOrdinalGaps', () => {
  it('is empty after appends and a skipped run', async () => {
    const t = await tower();
    await append(t.id, RUN_A);
    await append(t.id, RUN_C);
    await append(t.id, RUN_C);
    expect(await findOrdinalGaps(db)).toEqual([]);
  });

  // Why there is no deleteBaseBlock(id): this is the state it would allow.
  it('reports a tower whose middle block was removed by raw SQL', async () => {
    const t = await tower();
    await rawInsert({ towerId: t.id, ordinal: 1 });
    await rawInsert({ towerId: t.id, ordinal: 2 });
    await rawInsert({ towerId: t.id, ordinal: 3 });
    await db.execute(sql`delete from ${baseBlocks}
                          where ${baseBlocks.towerId} = ${t.id} and ${baseBlocks.ordinal} = 2`);
    expect(await findOrdinalGaps(db)).toContain(t.id);
  });
});
