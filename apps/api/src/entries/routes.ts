import { getHabit, listEntriesForHabit, type Db, type Habit } from '@tower-of-habit/db';
import { logEntryRequestSchema, type EntryListResponse } from '@tower-of-habit/shared';
import type { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { withTx, type RequestCtx, type TxRunner } from '../context.js';
import { DomainError } from '../errors.js';
import { jsonBody } from '../validation.js';
import { logHabitEntry } from './service.js';

export type EntryRouteDeps = { db: TxRunner };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownHabit(tx: Db, ctx: RequestCtx, id: string): Promise<Habit> {
  if (!UUID_RE.test(id)) throw new DomainError(404, 'not_found', 'Habit not found');
  const habit = await getHabit(tx, id);
  if (!habit || habit.ownerId !== ctx.userId) {
    throw new DomainError(404, 'not_found', 'Habit not found');
  }
  return habit;
}

export function mountEntryRoutes(api: Hono<AppEnv>, deps: EntryRouteDeps): void {
  api.post('/entries', jsonBody(logEntryRequestSchema), (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const body = c.req.valid('json');
      const habit = await ownHabit(tx, ctx, body.habitId);
      const result = await logHabitEntry(tx, habit, body, ctx.now);
      return c.json(result, result.created ? 201 : 200);
    })
  );

  api.get('/habits/:id/entries', (c) =>
    withTx(deps.db, c, async (tx, ctx) => {
      const habit = await ownHabit(tx, ctx, c.req.param('id'));
      const rows = await listEntriesForHabit(tx, habit.id);
      const body: EntryListResponse = { entries: rows as unknown as EntryListResponse['entries'] };
      return c.json(body);
    })
  );
}
