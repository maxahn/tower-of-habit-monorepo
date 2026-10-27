import { asc, desc, eq, sql } from 'drizzle-orm';
import { parseBlockRoster, type RosterIssue } from '@tower-of-habit/shared';
import type { db as appDb } from '../../client.js';
import { towers } from '../schema.js';
import { TowerNotFoundError } from '../towers.js';
import { baseBlocks } from './schema.js';

type Db = typeof appDb;
export type BaseBlock = typeof baseBlocks.$inferSelect;
// ordinal is allocated server-side (see appendBaseBlock); id and createdAt come
// from defaults. There is deliberately no BaseBlockPatch and no
// updateBaseBlock: the snapshot is frozen (§5), so there is nothing to patch.
export type NewBaseBlock = Omit<typeof baseBlocks.$inferInsert, 'id' | 'ordinal' | 'createdAt'>;

/** 1 = deepest/oldest. */
export const FIRST_ORDINAL = 1;

export class InvalidRosterError extends Error {
  constructor(
    readonly issues: readonly RosterIssue[],
    readonly blockId?: string
  ) {
    super(
      `Invalid base block roster${blockId ? ` (block ${blockId})` : ''}: ` +
        issues.map((i) => `${i.path || '(roster)'}: ${i.message}`).join('; ')
    );
    this.name = 'InvalidRosterError';
  }
}

/**
 * Re-validate roster on the way out of the database.
 *
 * $type<BlockRoster>() is a compile-time assertion with no runtime force, and
 * base_blocks_roster_nonempty_array only guarantees a non-empty array. Parsing
 * on read is what stops a row written by Studio, a psql session or a future
 * migration from escaping into the app typed as a valid snapshot. One parse per
 * row per read; if a hot path ever appears, add an explicit opt-out rather than
 * dropping this quietly.
 */
function hydrate(row: BaseBlock): BaseBlock {
  const parsed = parseBlockRoster(row.roster);
  if (!parsed.ok) throw new InvalidRosterError(parsed.issues, row.id);
  return { ...row, roster: parsed.roster };
}

/**
 * Append a block to the top of a tower's stack, allocating its ordinal.
 *
 * ORDINAL IS NEVER ACCEPTED FROM THE CALLER. It is a POSITION in the stack —
 * `coalesce(max(ordinal), 0) + 1` for this tower — not a count of runs
 * attempted. That is the entire mechanism by which a skipped short run (§5's
 * ~3-day floor, owned by 3.9) leaves no gap: the evaluator simply doesn't call
 * this, and the next real block takes the next position.
 *
 * The towers row lock is what makes the allocation safe, under READ COMMITTED:
 *   - `coalesce(max(ordinal), 0) + 1` is a read-modify-write. max() takes no
 *     locks and cannot see a concurrent appender's uncommitted row, and the
 *     unique index doesn't block that appender until it reaches the index — so
 *     two appends for one tower would compute the same ordinal and one would
 *     die on base_blocks_tower_id_ordinal_unique.
 *   - Concurrent appends for a single tower are rare but real: claimDuePeriods
 *     hands different due periods of the same tower to different workers
 *     during catch-up.
 *   - The lock REMOVES that race rather than detecting it, and it costs
 *     nothing the caller wasn't already paying: the evaluator writes this block
 *     in the same transaction as towers.height and currentStreak (see
 *     towers/schema.ts), so it holds this exact row lock anyway.
 *   - Retry-on-23505 was the alternative and is strictly worse here. Inside the
 *     caller's transaction a unique violation aborts the whole transaction, and
 *     every statement after it fails with 25P02 until rollback — so the retry
 *     could not run in the one case that matters. Locking composes; retrying
 *     does not.
 * The unique index therefore stays a backstop, never the decider.
 */
export async function appendBaseBlock(db: Db, input: NewBaseBlock): Promise<BaseBlock> {
  // Runtime guard: the type forbids these keys, but callers may pass untyped
  // data — and a caller-supplied ordinal is precisely the bug this function
  // exists to prevent.
  const { id, ordinal, createdAt, ...rest } = input as Record<string, unknown>;
  void [id, ordinal, createdAt];
  const values = rest as NewBaseBlock;

  // Before the database, so a bad roster never reaches a row the CHECK would
  // accept. @tower-of-habit/shared owns the shape; this package has no zod.
  const parsed = parseBlockRoster(values.roster);
  if (!parsed.ok) throw new InvalidRosterError(parsed.issues);

  // Nests as a savepoint when the caller is already in a transaction, so the
  // lock is held until the caller's own commit either way.
  return db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`select 1 from ${towers} where ${towers.id} = ${values.towerId} for update`
    );
    // Without this the insert would fail with a bare 23503 instead.
    if (locked.length === 0) throw new TowerNotFoundError(values.towerId);
    const [row] = await tx
      .insert(baseBlocks)
      .values({
        ...values,
        roster: parsed.roster,
        ordinal: sql`(select coalesce(max(${baseBlocks.ordinal}), 0) + 1
                      from ${baseBlocks}
                      where ${baseBlocks.towerId} = ${values.towerId})`,
      })
      .returning();
    return row!;
  });
}

export async function getBaseBlock(db: Db, id: string): Promise<BaseBlock | undefined> {
  const [row] = await db.select().from(baseBlocks).where(eq(baseBlocks.id, id));
  return row ? hydrate(row) : undefined;
}

/** Oldest first: ordinal 1 is the deepest block, which is how §5 renders the stack. */
export async function listBaseBlocksForTower(db: Db, towerId: string): Promise<BaseBlock[]> {
  const rows = await db
    .select()
    .from(baseBlocks)
    .where(eq(baseBlocks.towerId, towerId))
    .orderBy(asc(baseBlocks.ordinal));
  return rows.map((row) => hydrate(row));
}

/** The top of the stack: the most recent completed run. */
export async function latestBaseBlock(db: Db, towerId: string): Promise<BaseBlock | undefined> {
  const [row] = await db
    .select()
    .from(baseBlocks)
    .where(eq(baseBlocks.towerId, towerId))
    .orderBy(desc(baseBlocks.ordinal))
    .limit(1);
  return row ? hydrate(row) : undefined;
}

/**
 * Towers whose ordinals aren't 1..n. Should always be empty.
 *
 * Gaplessness isn't expressible as a constraint — it would need a deferred
 * constraint trigger, which drizzle has no DSL for, which every later
 * `generate` would be blind to because the snapshot wouldn't know it exists,
 * and which would add a per-statement aggregate to the evaluator's hot path to
 * catch a bug that server-side allocation and the absence of any delete already
 * make unreachable. So this is the assertion instead, same shape as
 * findTieredHabitsMissingBaseTier.
 *
 * `count(*) <> max(ordinal)` is sufficient on its own: the unique index makes
 * the ordinals distinct and base_blocks_ordinal_positive makes them >= 1, and n
 * distinct positive integers with max = n are exactly 1..n.
 */
export async function findOrdinalGaps(db: Db): Promise<string[]> {
  const rows = await db
    .select({ towerId: baseBlocks.towerId })
    .from(baseBlocks)
    .groupBy(baseBlocks.towerId)
    .having(sql`count(*) <> max(${baseBlocks.ordinal})`);
  return rows.map((r) => r.towerId);
}
