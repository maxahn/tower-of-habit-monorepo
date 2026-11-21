import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db, useTestOwner } from '../test-utils.js';
import { towers } from './schema.js';
import { activateTower, createTower } from './towers.js';

/*
 * 2.15: draft -> active, stamping started_at with the injected `now`.
 */

const owner = useTestOwner();
const created: string[] = [];
afterEach(async () => {
  for (const id of created.splice(0)) await db.delete(towers).where(eq(towers.id, id));
});

const NOW = new Date('2026-11-16T19:00:00Z');

describe('activateTower', () => {
  it('moves a draft tower to active and stamps started_at', async () => {
    const t = await createTower(db, {
      hostId: owner(),
      name: 'x',
      deadlineTime: '22:00',
      timezone: 'UTC',
    });
    created.push(t.id);
    const row = await activateTower(db, t.id, NOW);
    expect(row).toMatchObject({ lifecycle: 'active', startedAt: NOW });
  });

  it('returns undefined (and changes nothing) when the tower is not a draft', async () => {
    const t = await createTower(db, {
      hostId: owner(),
      name: 'x',
      deadlineTime: '22:00',
      timezone: 'UTC',
    });
    created.push(t.id);
    await activateTower(db, t.id, NOW);
    const later = new Date('2026-11-17T19:00:00Z');
    expect(await activateTower(db, t.id, later)).toBeUndefined();
    const [row] = await db.select().from(towers).where(eq(towers.id, t.id));
    expect(row!.startedAt).toEqual(NOW);
  });
});
