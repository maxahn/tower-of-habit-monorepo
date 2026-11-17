import { db, entries, memberships, towers } from '@tower-of-habit/db';
import {
  entryListResponseSchema,
  logEntryResponseSchema,
  type LogEntryResponse,
} from '@tower-of-habit/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readErrorBody } from '../testing/harness.js';
import { useIntegrationApp } from '../testing/integration.js';

/*
 * 2.16: POST /entries, GET /habits/:id/entries. Tower zone for a bound habit,
 * user zone otherwise (D3); the day boundary and grace window decide which
 * date an entry lands on; qualification is 2.3's, never the client's.
 *
 * Harness clock: 2026-11-16T19:00Z = 12:00 Edmonton (MST). Tower deadline
 * 22:00 Edmonton = 05:00Z next day; grace 120 → evaluateAt 07:00Z.
 */

const it_ = useIntegrationApp();

async function startedTower(
  opts: { members?: number; habit?: { type: 'binary' | 'numeric' | 'tiered' } } = {}
) {
  const s = await it_.fixtures.lobby({
    members: opts.members ?? 2,
    ...(opts.habit ? { habit: opts.habit } : {}),
  });
  const res = await it_.request(`/v1/towers/${s.tower.id}/start`, { method: 'POST', as: s.host });
  expect(res.status).toBe(200);
  return s;
}

async function log(
  as: { token: string },
  json: Record<string, unknown>,
  now?: string
): Promise<{ status: number; body: LogEntryResponse }> {
  const res = await it_.request('/v1/entries', { as, json, ...(now ? { now } : {}) });
  const text = await res.clone().text();
  expect(res.status, text).toBeLessThan(300);
  return { status: res.status, body: logEntryResponseSchema.parse(await res.json()) };
}

describe('POST /v1/entries', () => {
  it('logs a qualifying binary entry for today in the tower zone (201, live)', async () => {
    const s = await startedTower();
    const { status, body } = await log(s.host, {
      habitId: s.host.habit.id,
      idempotencyKey: undefined,
      clientEntryId: crypto.randomUUID(),
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ created: true, qualifies: true });
    expect(body.entry).toMatchObject({
      localDate: '2026-11-16',
      countsTowardQuota: true,
      source: 'live',
      loggedAt: it_.clock.now.toISOString(),
    });
  });

  it('lands on yesterday during the grace window, as a grace entry', async () => {
    const s = await startedTower();
    // 00:30 Edmonton on the 17th = 07:30Z? No: MST is UTC-7, so 00:30 = 07:30Z,
    // which is past evaluateAt (07:00Z). Use 23:30 on the 16th = 06:30Z.
    const { body } = await log(s.host, { habitId: s.host.habit.id }, '2026-11-17T06:30:00.000Z');
    expect(body.entry).toMatchObject({
      localDate: '2026-11-16',
      source: 'grace',
      countsTowardQuota: true,
    });
  });

  it('accepts an explicit localDate of today or of yesterday while its grace window is open', async () => {
    const s = await startedTower();
    const a = await log(s.host, { habitId: s.host.habit.id, localDate: '2026-11-16' });
    expect(a.body.entry.localDate).toBe('2026-11-16');
    // Member B, at 23:30 on the 16th: may still log the 16th (grace) or — no,
    // the 17th has not started in tower time. Ask for the 16th explicitly.
    const b = await log(
      s.members[1]!,
      { habitId: s.members[1]!.habit.id, localDate: '2026-11-16' },
      '2026-11-17T06:30:00.000Z'
    );
    expect(b.body.entry).toMatchObject({ localDate: '2026-11-16', source: 'grace' });
  });

  it('rejects a localDate outside the window with 400 date_out_of_window', async () => {
    const s = await startedTower();
    for (const [localDate, now] of [
      ['2026-11-15', undefined],
      ['2026-11-17', undefined],
      ['2026-11-16', '2026-11-17T08:00:00.000Z'], // the 16th's grace window closed at 07:00Z
    ] as const) {
      const res = await it_.request('/v1/entries', {
        as: s.host,
        json: { habitId: s.host.habit.id, localDate },
        ...(now ? { now } : {}),
      });
      expect(res.status, `${localDate} @ ${now}`).toBe(400);
      expect((await readErrorBody(res)).error.code).toBe('date_out_of_window');
    }
  });

  it('computes qualification from the habit (numeric threshold), never from the client', async () => {
    const s = await startedTower({ habit: { type: 'numeric' } }); // tier 0 threshold 20
    const low = await log(s.host, { habitId: s.host.habit.id, numericValue: 10 });
    expect(low.body).toMatchObject({ qualifies: false, created: true });
    expect(low.body.entry.countsTowardQuota).toBe(false);
    const high = await log(s.host, { habitId: s.host.habit.id, numericValue: 25 });
    expect(high.body).toMatchObject({ qualifies: true, created: true });
    expect(high.body.entry.countsTowardQuota).toBe(true);
  });

  it('replays an idempotencyKey (clientEntryId) with the original entry, 200', async () => {
    const s = await startedTower();
    const key = crypto.randomUUID();
    const first = await log(s.host, { habitId: s.host.habit.id, clientEntryId: key });
    const again = await log(
      s.host,
      { habitId: s.host.habit.id, clientEntryId: key },
      '2026-11-16T20:00:00.000Z'
    );
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.entry).toEqual(first.body.entry);
  });

  it('stores additional entries on an already-credited day as supplemental', async () => {
    const s = await startedTower();
    await log(s.host, { habitId: s.host.habit.id });
    const second = await log(s.host, { habitId: s.host.habit.id });
    expect(second.status).toBe(201);
    expect(second.body.entry.countsTowardQuota).toBe(false);
    const rows = await db.select().from(entries).where(eq(entries.habitId, s.host.habit.id));
    expect(rows.filter((r) => r.countsTowardQuota)).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it('uses the user’s timezone for a standalone habit (D3)', async () => {
    const me = await it_.fixtures.user({ timezone: 'Asia/Tokyo' });
    const habit = await it_.fixtures.habit(me);
    // 19:00Z = 04:00 Tokyo on the 17th.
    const { body } = await log(me, { habitId: habit.id });
    expect(body.entry.localDate).toBe('2026-11-17');
    // The request may override the zone (the client's current zone).
    const r2 = await log(me, { habitId: habit.id, timezone: 'America/Edmonton' });
    expect(r2.body.entry.localDate).toBe('2026-11-16');
  });

  it('returns a dormant member to active on a qualifying log, resetting the miss counter', async () => {
    const s = await startedTower();
    const m = s.members[1]!;
    await db
      .update(memberships)
      .set({
        state: 'dormant',
        dormantSince: it_.clock.now,
        dormancyReason: 'consecutive_miss',
        consecutiveMissedPeriods: 2,
      })
      .where(eq(memberships.id, m.membership.id));
    await log(m, { habitId: m.habit.id });
    const [row] = await db.select().from(memberships).where(eq(memberships.id, m.membership.id));
    expect(row).toMatchObject({
      state: 'active',
      consecutiveMissedPeriods: 0,
      dormantSince: null,
      dormancyReason: null,
      lastQualifyingDate: '2026-11-16',
    });
  });

  it('does not wake a voluntarily dormant member', async () => {
    const s = await startedTower();
    const m = s.members[1]!;
    await db
      .update(memberships)
      .set({ state: 'dormant', dormantSince: it_.clock.now, dormancyReason: 'voluntary' })
      .where(eq(memberships.id, m.membership.id));
    await log(m, { habitId: m.habit.id });
    const [row] = await db.select().from(memberships).where(eq(memberships.id, m.membership.id));
    expect(row!.state).toBe('dormant');
  });

  it('accepts a log against a habit in a collapsed tower (height 0, still active)', async () => {
    const s = await startedTower();
    await db.update(towers).set({ height: 0, currentStreak: 0 }).where(eq(towers.id, s.tower.id));
    const { status } = await log(s.host, { habitId: s.host.habit.id });
    expect(status).toBe(201);
  });

  it('is 404 for a habit the caller does not own', async () => {
    const s = await startedTower();
    const res = await it_.request('/v1/entries', {
      as: s.members[1]!,
      json: { habitId: s.host.habit.id },
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/habits/:id/entries', () => {
  it('lists the habit’s entries, newest first, to the owner only', async () => {
    const s = await startedTower();
    await log(s.host, { habitId: s.host.habit.id, localDate: '2026-11-16' });
    const res = await it_.request(`/v1/habits/${s.host.habit.id}/entries`, { as: s.host });
    expect(res.status).toBe(200);
    const body = entryListResponseSchema.parse(await res.json());
    expect(body.entries.map((e) => e.localDate)).toEqual(['2026-11-16']);
    expect(
      (await it_.request(`/v1/habits/${s.host.habit.id}/entries`, { as: s.members[1]! })).status
    ).toBe(404);
  });
});
