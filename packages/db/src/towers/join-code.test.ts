import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db, useTestOwner } from '../test-utils.js';
import { towers } from './schema.js';
import { createTower, findTowerByJoinCode } from './towers.js';

/*
 * 2.14: join-by-code lookup. Codes are citext: stored upper-cased, matched in
 * any case, trimmed.
 */

const owner = useTestOwner();
const created: string[] = [];
afterEach(async () => {
  for (const id of created.splice(0)) await db.delete(towers).where(eq(towers.id, id));
});

describe('findTowerByJoinCode', () => {
  it('matches case-insensitively and trims whitespace', async () => {
    const t = await createTower(db, {
      hostId: owner(),
      name: 'x',
      deadlineTime: '22:00',
      timezone: 'UTC',
      joinCode: 'ABCD2345',
    });
    created.push(t.id);
    expect((await findTowerByJoinCode(db, 'abcd2345'))?.id).toBe(t.id);
    expect((await findTowerByJoinCode(db, '  AbCd2345 '))?.id).toBe(t.id);
  });

  it('returns undefined for an unknown code', async () => {
    expect(await findTowerByJoinCode(db, 'ZZZZ9999')).toBeUndefined();
  });
});
