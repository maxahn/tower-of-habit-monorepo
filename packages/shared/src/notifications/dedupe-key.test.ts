import { describe, expect, it } from 'vitest';
import {
  buildDedupeKey,
  dedupeEventRecipient,
  InvalidDedupeKeyInputError,
  NOTIFICATION_TYPES,
  type NotificationEvent,
  type NotificationType,
} from './dedupe-key.js';

const PERIOD = '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11';
const OTHER_PERIOD = '11111111-2222-4333-8444-555555555555';
const USER = '8f0f5a4f-2c11-4a9e-bb1f-3f1c6d326a4e';
const OTHER_USER = '99999999-8888-4777-8666-555555555555';
const MEMBERSHIP = 'a94b1d7e-5c33-4f81-9e2a-6b0d8c4f1e55';
const TOWER = 'c0ffee00-dead-4bee-8f00-1234567890ab';
const BLOCK = 'b10c0000-1111-4222-8333-444455556666';

/**
 * One event per notification type. Doubles as the coverage source below, so a
 * new type that nobody gave a scope fails to compile HERE as well as in the
 * builder's own switch.
 */
const SAMPLES: Record<NotificationType, NotificationEvent> = {
  nudge: { type: 'nudge', periodId: PERIOD, userId: USER },
  wobble: { type: 'wobble', periodId: PERIOD, userId: USER },
  collapse: { type: 'collapse', periodId: PERIOD, userId: USER },
  dormant: { type: 'dormant', membershipId: MEMBERSHIP },
  returned: { type: 'returned', membershipId: MEMBERSHIP },
  member_joined: { type: 'member_joined', membershipId: MEMBERSHIP, userId: USER },
  tower_started: { type: 'tower_started', towerId: TOWER, userId: USER },
  tower_archived: { type: 'tower_archived', towerId: TOWER, userId: USER },
  block_completed: { type: 'block_completed', blockId: BLOCK, userId: USER },
  host_transferred: { type: 'host_transferred', periodId: PERIOD, userId: USER },
};

/**
 * THE FROZEN FORMAT, spelled out. These are literals and not built from the
 * constants above on purpose: a format change re-sends every notification in
 * the retention window and does so SILENTLY, so the only useful guard is a test
 * that states the old format in full and fails when it moves.
 */
const GOLDEN: ReadonlyArray<readonly [NotificationType, string]> = [
  ['nudge', 'nudge:3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11:8f0f5a4f-2c11-4a9e-bb1f-3f1c6d326a4e'],
  ['wobble', 'wobble:3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11:8f0f5a4f-2c11-4a9e-bb1f-3f1c6d326a4e'],
  [
    'collapse',
    'collapse:3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11:8f0f5a4f-2c11-4a9e-bb1f-3f1c6d326a4e',
  ],
  ['dormant', 'dormant:a94b1d7e-5c33-4f81-9e2a-6b0d8c4f1e55'],
  ['returned', 'returned:a94b1d7e-5c33-4f81-9e2a-6b0d8c4f1e55'],
  [
    'member_joined',
    'member_joined:a94b1d7e-5c33-4f81-9e2a-6b0d8c4f1e55:8f0f5a4f-2c11-4a9e-bb1f-3f1c6d326a4e',
  ],
  [
    'tower_started',
    'tower_started:c0ffee00-dead-4bee-8f00-1234567890ab:8f0f5a4f-2c11-4a9e-bb1f-3f1c6d326a4e',
  ],
  [
    'tower_archived',
    'tower_archived:c0ffee00-dead-4bee-8f00-1234567890ab:8f0f5a4f-2c11-4a9e-bb1f-3f1c6d326a4e',
  ],
  [
    'block_completed',
    'block_completed:b10c0000-1111-4222-8333-444455556666:8f0f5a4f-2c11-4a9e-bb1f-3f1c6d326a4e',
  ],
  [
    'host_transferred',
    'host_transferred:3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11:8f0f5a4f-2c11-4a9e-bb1f-3f1c6d326a4e',
  ],
];

describe('buildDedupeKey — the frozen format', () => {
  it.each(GOLDEN)('builds the documented key for %s', (type, expected) => {
    expect(buildDedupeKey(SAMPLES[type])).toBe(expected);
  });

  it('states a golden key for every notification type', () => {
    expect(GOLDEN.map(([type]) => type).sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it('is deterministic', () => {
    expect(buildDedupeKey(SAMPLES.wobble)).toBe(buildDedupeKey(SAMPLES.wobble));
  });

  it('accepts every notification type', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(buildDedupeKey(SAMPLES[type])).toContain(type);
    }
  });
});

describe('buildDedupeKey — scopes', () => {
  it('keys the escalation types per period and per user', () => {
    const base = buildDedupeKey({ type: 'wobble', periodId: PERIOD, userId: USER });
    expect(buildDedupeKey({ type: 'wobble', periodId: PERIOD, userId: OTHER_USER })).not.toBe(base);
    expect(buildDedupeKey({ type: 'wobble', periodId: OTHER_PERIOD, userId: USER })).not.toBe(base);
  });

  // A wobble must not suppress that period's collapse.
  it('keys each escalation stage separately for one period and user', () => {
    const keys = (['nudge', 'wobble', 'collapse'] as const).map((type) =>
      buildDedupeKey({ type, periodId: PERIOD, userId: USER })
    );
    expect(new Set(keys).size).toBe(3);
  });

  // The membership IS the (tower, user) pair, so naming the user as well would
  // let a key claim a user the membership does not have.
  it('keys dormancy per membership, with no tower or user in the key', () => {
    const key = buildDedupeKey({ type: 'dormant', membershipId: MEMBERSHIP });
    expect(key).toBe(`dormant:${MEMBERSHIP}`);
    expect(key).not.toContain(USER);
    expect(key).not.toContain(TOWER);
  });

  it('keys dormant and returned separately for one membership', () => {
    expect(buildDedupeKey({ type: 'dormant', membershipId: MEMBERSHIP })).not.toBe(
      buildDedupeKey({ type: 'returned', membershipId: MEMBERSHIP })
    );
  });

  it('keys member_joined per joining membership and per recipient', () => {
    const base = buildDedupeKey({ type: 'member_joined', membershipId: MEMBERSHIP, userId: USER });
    expect(
      buildDedupeKey({ type: 'member_joined', membershipId: MEMBERSHIP, userId: OTHER_USER })
    ).not.toBe(base);
  });

  it('keys block_completed per block and per recipient', () => {
    const base = buildDedupeKey({ type: 'block_completed', blockId: BLOCK, userId: USER });
    expect(
      buildDedupeKey({ type: 'block_completed', blockId: BLOCK, userId: OTHER_USER })
    ).not.toBe(base);
  });
});

/**
 * The pair that justifies keying a REPEATABLE event on the period rather than
 * on the tower. Tested together because either one alone looks arbitrary.
 */
describe('buildDedupeKey — host_transferred is per period', () => {
  it('gives two transfers in the same period the same key', () => {
    expect(buildDedupeKey({ type: 'host_transferred', periodId: PERIOD, userId: USER })).toBe(
      buildDedupeKey({ type: 'host_transferred', periodId: PERIOD, userId: USER })
    );
  });

  it('gives a transfer in a later period a different key', () => {
    expect(buildDedupeKey({ type: 'host_transferred', periodId: PERIOD, userId: USER })).not.toBe(
      buildDedupeKey({ type: 'host_transferred', periodId: OTHER_PERIOD, userId: USER })
    );
  });
});

describe('buildDedupeKey — grammar', () => {
  it.each([
    ['periodId', { type: 'wobble', periodId: '', userId: USER }],
    ['userId', { type: 'wobble', periodId: PERIOD, userId: '' }],
    ['membershipId', { type: 'dormant', membershipId: '' }],
    ['towerId', { type: 'tower_started', towerId: '', userId: USER }],
    ['blockId', { type: 'block_completed', blockId: '', userId: USER }],
  ] as ReadonlyArray<readonly [string, NotificationEvent]>)(
    'rejects an empty %s',
    (field, event) => {
      expect(() => buildDedupeKey(event)).toThrow(InvalidDedupeKeyInputError);
      try {
        buildDedupeKey(event);
      } catch (e) {
        expect((e as InvalidDedupeKeyInputError).field).toBe(field);
      }
    }
  );

  // A segment carrying the separator makes the key dedupe against the wrong set
  // of events, which nothing downstream can detect.
  it('rejects an id containing the separator', () => {
    expect(() =>
      buildDedupeKey({ type: 'wobble', periodId: `${PERIOD}:extra`, userId: USER })
    ).toThrow(InvalidDedupeKeyInputError);
  });

  it('reports the offending value on the error', () => {
    try {
      buildDedupeKey({ type: 'wobble', periodId: 'a:b', userId: USER });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ field: 'periodId', value: 'a:b' });
    }
  });

  // Must stay under notifications_dedupe_key_length (200). A real insert at this
  // length is asserted in @tower-of-habit/db.
  it('keeps the longest constructible key well under the column limit', () => {
    const longest = Math.max(...NOTIFICATION_TYPES.map((t) => buildDedupeKey(SAMPLES[t]).length));
    expect(longest).toBeLessThanOrEqual(200);
    expect(longest).toBe(
      'host_transferred'.length + 1 + PERIOD.length + 1 + USER.length // 87
    );
  });
});

describe('dedupeEventRecipient', () => {
  it('names the recipient for every scope that carries one', () => {
    for (const type of NOTIFICATION_TYPES) {
      const expected = type === 'dormant' || type === 'returned' ? undefined : USER;
      expect(dedupeEventRecipient(SAMPLES[type])).toBe(expected);
    }
  });
});

describe('NotificationEvent types', () => {
  it('requires a periodId for a wobble', () => {
    // @ts-expect-error a wobble is scoped to a period, not a tower
    const event: NotificationEvent = { type: 'wobble', towerId: TOWER, userId: USER };
    expect(event).toBeDefined();
  });

  it('does not accept a userId for a dormancy event', () => {
    // @ts-expect-error the membership already identifies the user
    const event: NotificationEvent = { type: 'dormant', membershipId: MEMBERSHIP, userId: USER };
    expect(event).toBeDefined();
  });

  it('rejects a type outside the enum', () => {
    // @ts-expect-error tower_paused has no stored occurrence referent to key on
    const event: NotificationEvent = { type: 'tower_paused', towerId: TOWER, userId: USER };
    expect(event).toBeDefined();
  });
});
