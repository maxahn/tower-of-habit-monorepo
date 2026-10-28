import { describe, expect, it } from 'vitest';
import { blockRosterMemberSchema, parseBlockRoster, ROSTER_DISPLAY_NAME_MAX } from './schemas.js';

/** The spec's example member, verbatim. */
const SAM = {
  user_id: '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11',
  display_name: 'Sam',
  qualifying_days: 27,
  total_days: 30,
  highest_tier: 3,
  was_dormant: false,
};

describe('blockRosterMemberSchema', () => {
  it("accepts the spec's example member verbatim", () => {
    expect(blockRosterMemberSchema.parse(SAM)).toEqual(SAM);
  });

  it('rejects qualifying_days above total_days', () => {
    const r = blockRosterMemberSchema.safeParse({ ...SAM, qualifying_days: 31 });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['qualifying_days']);
  });

  it('accepts qualifying_days equal to total_days', () => {
    expect(
      blockRosterMemberSchema.safeParse({ ...SAM, qualifying_days: 30, total_days: 30 }).success
    ).toBe(true);
  });

  // Tier 0 is the base tier: "met the commitment", not "did nothing".
  it('accepts highest_tier 0 and qualifying_days 0', () => {
    expect(
      blockRosterMemberSchema.safeParse({ ...SAM, highest_tier: 0, qualifying_days: 0 }).success
    ).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN])('rejects a qualifying_days of %p', (qualifying_days) => {
    expect(blockRosterMemberSchema.safeParse({ ...SAM, qualifying_days }).success).toBe(false);
  });

  it.each([0, -1, 2.5, Number.NaN])('rejects a total_days of %p', (total_days) => {
    expect(blockRosterMemberSchema.safeParse({ ...SAM, total_days }).success).toBe(false);
  });

  it.each([-1, 0.5])('rejects a highest_tier of %p', (highest_tier) => {
    expect(blockRosterMemberSchema.safeParse({ ...SAM, highest_tier }).success).toBe(false);
  });

  it.each([
    'sam',
    '',
    '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c1',
    'not-a-uuid-but-36-chars-long-aaaaaa',
  ])('rejects a user_id of %p', (user_id) => {
    expect(blockRosterMemberSchema.safeParse({ ...SAM, user_id }).success).toBe(false);
  });

  it('accepts a display_name at the limit and rejects one past it', () => {
    const at = 'x'.repeat(ROSTER_DISPLAY_NAME_MAX);
    expect(blockRosterMemberSchema.safeParse({ ...SAM, display_name: at }).success).toBe(true);
    expect(blockRosterMemberSchema.safeParse({ ...SAM, display_name: at + 'x' }).success).toBe(
      false
    );
  });

  it('rejects an empty display_name', () => {
    expect(blockRosterMemberSchema.safeParse({ ...SAM, display_name: '' }).success).toBe(false);
  });

  // jsonb would happily store the string, so the schema is the only guard.
  it('rejects a was_dormant that is a string, not a boolean', () => {
    expect(blockRosterMemberSchema.safeParse({ ...SAM, was_dormant: 'false' }).success).toBe(false);
  });

  // §5 at the JSON boundary: blame cannot ride along inside the roster either.
  it('rejects a caused_collapse key (§5)', () => {
    expect(blockRosterMemberSchema.safeParse({ ...SAM, caused_collapse: true }).success).toBe(
      false
    );
  });

  // Pins the snake_case decision: a camelCase payload is a bug, not a variant.
  it('rejects camelCase keys', () => {
    const { display_name, ...rest } = SAM;
    void display_name;
    expect(blockRosterMemberSchema.safeParse({ ...rest, displayName: 'Sam' }).success).toBe(false);
  });

  it.each(Object.keys(SAM))('requires %s', (key) => {
    const partial: Record<string, unknown> = { ...SAM };
    delete partial[key];
    expect(blockRosterMemberSchema.safeParse(partial).success).toBe(false);
  });
});

describe('parseBlockRoster', () => {
  it('accepts a single-member roster', () => {
    const r = parseBlockRoster([SAM]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.roster).toEqual([SAM]);
  });

  it('accepts a twelve-member roster', () => {
    const roster = Array.from({ length: 12 }, (_, i) => ({ ...SAM, display_name: `M${i}` }));
    const r = parseBlockRoster(roster);
    expect(r.ok && r.roster).toHaveLength(12);
  });

  it.each([[[]], [{}], [null], ['sam'], [3], [undefined], [[SAM, 'sam']]])(
    'rejects %p',
    (value) => {
      expect(parseBlockRoster(value).ok).toBe(false);
    }
  );

  it('reports the offending index in the issue path', () => {
    const r = parseBlockRoster([SAM, { ...SAM, total_days: 1 }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]!.path).toBe('1.qualifying_days');
  });

  // The flattening is what keeps zod out of @tower-of-habit/db's error types.
  it('returns issues as plain {path, message} objects', () => {
    const r = parseBlockRoster([{ ...SAM, user_id: 'sam' }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.issues[0]!).sort()).toEqual(['message', 'path']);
    expect(typeof r.issues[0]!.message).toBe('string');
    expect(r.issues[0]!.path).toBe('0.user_id');
  });
});
