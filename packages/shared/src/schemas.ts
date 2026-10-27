import { z } from 'zod';

/**
 * Must equal DISPLAY_VARCHAR_MAX in @tower-of-habit/db (src/columns.ts).
 *
 * Duplicated rather than imported: the eslint firewall forbids this package
 * from importing the db package, and that firewall is worth more than the
 * duplication. A test asserts the two agree.
 */
export const ROSTER_DISPLAY_NAME_MAX = 60;

/**
 * One member of the frozen roster snapshot stored in base_blocks.roster (§5).
 *
 * KEYS ARE snake_case, against the grain of the TypeScript around them, and
 * that is deliberate and permanent:
 *   - These bytes are a historical record. They outlive this code and have to
 *     read in psql, a pg_dump or Studio to someone who has never opened this
 *     file. Next to tower_id and run_start_date, `roster -> 0 ->> 'user_id'`
 *     is one language; mixing in `->> 'userId'` is where the typos live.
 *   - 1.2's account-deletion rule rewrites display_name INSIDE this jsonb with
 *     SQL (jsonb_set), not TypeScript. The key is a SQL literal there.
 *   - Drizzle's `casing: 'snake_case'` maps column keys only; it does not
 *     reach inside a jsonb value. A camelCase payload would need a mapping
 *     layer on every read and write, forever, for a shape written once.
 * The cost is that TS consumers write `member.display_name`. That is a small
 * ugliness at exactly one boundary, which is the right place to pay it.
 *
 * STRICT: unknown keys are REJECTED, not stripped. Two reasons, both about a
 * row that is written once and never updated:
 *   - A typo'd key that is silently dropped is permanent data loss.
 *   - `caused_collapse` must not be able to ride along inside the JSON either
 *     (§5 — see the header of towers/blocks/schema.ts in @tower-of-habit/db).
 *     Rejecting it is louder than dropping it.
 * Adding a field later therefore means adding it here as `.optional()` and
 * deciding what old rows mean, which is the conversation we want to be forced
 * into. The accepted cost: a rolled-back deploy reading rows written by a
 * newer one throws rather than quietly discarding the new field.
 */
export const blockRosterMemberSchema = z
  .strictObject({
    user_id: z.uuid(),
    // Snapshotted as it stood at the end of the run, never re-read from users.
    display_name: z.string().min(1).max(ROSTER_DISPLAY_NAME_MAX),
    // Days this member qualified during the run. The block's own block_height
    // is the TOWER's, so these are not expected to agree with it.
    qualifying_days: z.int().min(0),
    // Days the member was in the tower during the run: the denominator §5's
    // strata are read against. A member present for no days isn't in the
    // roster at all, so this is positive rather than non-negative.
    total_days: z.int().positive(),
    // 0 for binary and numeric habits, because tier 0 is the base tier
    // (BASE_TIER_INDEX): 0 means "met the commitment", not "did nothing".
    highest_tier: z.int().min(0),
    // §6 dormancy, as it stood at the end of the run.
    was_dormant: z.boolean(),
  })
  .refine((m) => m.qualifying_days <= m.total_days, {
    message: 'qualifying_days cannot exceed total_days',
    path: ['qualifying_days'],
  });

/** Non-empty: a block with an empty roster is a block nobody built. */
export const blockRosterSchema = z.array(blockRosterMemberSchema).min(1);

export type BlockRosterMember = z.infer<typeof blockRosterMemberSchema>;
export type BlockRoster = z.infer<typeof blockRosterSchema>;

/** A validation failure flattened to plain data, so callers need not know zod. */
export type RosterIssue = { path: string; message: string };

export type ParsedRoster = { ok: true; roster: BlockRoster } | { ok: false; issues: RosterIssue[] };

/**
 * Validate an unknown value as a roster snapshot.
 *
 * Returns a result instead of throwing, and flattens zod's issues to plain
 * objects, so @tower-of-habit/db can raise its own InvalidRosterError with a
 * block id attached. That package does not depend on zod and should not start:
 * the validator lives here, next to the evaluator that builds a roster.
 */
export function parseBlockRoster(value: unknown): ParsedRoster {
  const result = blockRosterSchema.safeParse(value);
  if (result.success) return { ok: true, roster: result.data };
  return {
    ok: false,
    // path.map(String) rather than path.join('.'): a zod path element can be a
    // symbol, and Array#join's ToString throws on one.
    issues: result.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    })),
  };
}
