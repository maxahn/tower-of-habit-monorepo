import { describe, expect, it } from 'vitest';
import { parseBlockRoster } from '../schemas/index.js';
import { daysBetween } from '../time/local-date.js';
import { testClock } from './clock.js';
import { factories } from './factories.js';
import { idGen } from './ids.js';
import {
  allMembersDormant,
  memberMissedPeriods,
  membersLoggedToday,
  standaloneHabit,
  towerRunningFor,
  towerWithBaseBlocks,
} from './scenarios.js';

// 12:00 MDT (-06:00) in Edmonton, the factory default zone.
const NOW = new Date('2026-10-27T18:00:00Z');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const outcomes = (plan: ReturnType<typeof towerRunningFor>) => plan.periods.map((p) => p.outcome);

describe('towerRunningFor', () => {
  it('the 1.11 done-when: a 3-member tower on day 12, one member has missed one period', () => {
    const s = towerRunningFor(12, { now: NOW, members: 3, traits: [memberMissedPeriods(1)] });

    expect(s.periods).toHaveLength(12);
    expect(s.periods[0]!.periodStart).toBe('2026-10-16');
    expect(s.periods.at(-1)).toMatchObject({ periodStart: '2026-10-27', state: 'pending' });
    expect(outcomes(s)).toEqual([...Array(10).fill('survived'), 'collapsed', null]);
    expect(s.members.map((m) => m.membership.state)).toEqual(['active', 'active', 'at_risk']);
    expect(s.members[2]!.membership).toMatchObject({
      consecutiveMissedPeriods: 1,
      lastQualifyingDate: '2026-10-25',
    });
    expect(s.tower).toMatchObject({ height: 0, currentStreak: 0 });
    // The collapse closed a 10-day run, which leaves a block.
    expect(s.blocks).toEqual([
      expect.objectContaining({
        runStartDate: '2026-10-16',
        runEndDate: '2026-10-25',
        blockHeight: 10,
      }),
    ]);
    expect(parseBlockRoster(s.blocks[0]!.roster).ok).toBe(true);
  });

  it('with nobody missing, stands at height N-1 with every past period survived', () => {
    const s = towerRunningFor(30, { now: NOW, members: 2 });
    expect(s.tower).toMatchObject({ height: 29, currentStreak: 29 });
    expect(
      outcomes(s)
        .slice(0, -1)
        .every((o) => o === 'survived')
    ).toBe(true);
    expect(s.blocks).toEqual([]);
    expect(s.memberships.every((m) => m.state === 'active')).toBe(true);
  });

  it('two consecutive misses: dormant instead of a second collapse', () => {
    const s = towerRunningFor(8, { now: NOW, members: 2, traits: [memberMissedPeriods(2)] });
    expect(outcomes(s).slice(-3)).toEqual(['collapsed', 'survived', null]);
    const missed = s.members[1]!.membership;
    expect(missed).toMatchObject({
      state: 'dormant',
      dormancyReason: 'consecutive_miss',
      consecutiveMissedPeriods: 2,
      dormantSince: s.periods.at(-2)!.evaluateAt,
    });
    expect(s.tower!.height).toBe(1);
  });

  it('allMembersDormant: collapse, then hibernation', () => {
    const s = towerRunningFor(10, { now: NOW, members: 2, traits: [allMembersDormant()] });
    expect(outcomes(s).slice(-3)).toEqual(['collapsed', 'hibernated', null]);
    expect(s.memberships.map((m) => m.state)).toEqual(['dormant', 'dormant']);
    expect(s.blocks).toHaveLength(1);
  });

  it('leaves yesterday pending while now is inside its grace window', () => {
    // 00:30 MDT on the 28th; deadline 23:00 + 120 grace closes yesterday at 01:00.
    const now = new Date('2026-10-28T06:30:00Z');
    const s = towerRunningFor(5, { now, deadline: '23:00' });
    expect(s.periods.map((p) => p.state)).toEqual([
      'evaluated',
      'evaluated',
      'evaluated',
      'pending',
      'pending',
    ]);
    expect(s.tower!.height).toBe(3);
  });

  // TODO(tzdata-2026c)[denver]: pass timezone: 'America/Denver' (same expected values);
  // FACTORY_TIMEZONE Edmonton no longer falls back; see packages/shared/src/time/TZDATA.md.
  it('resolves deadlines across the 2026-11-01 fall-back', () => {
    // 12:00 MST (-07:00) on Nov 3: days Oct 30 .. Nov 3.
    const s = towerRunningFor(5, { now: new Date('2026-11-03T19:00:00Z') });
    expect(s.periods.map((p) => p.deadlineAt.toISOString())).toEqual([
      '2026-10-31T04:00:00.000Z', // 22:00 MDT
      '2026-11-01T04:00:00.000Z', // 22:00 MDT
      '2026-11-02T05:00:00.000Z', // 22:00 MST: the clocks went back that morning
      '2026-11-03T05:00:00.000Z',
      '2026-11-04T05:00:00.000Z',
    ]);
  });

  it('logs before the deadline, whatever it is', () => {
    const s = towerRunningFor(3, { now: new Date('2026-10-27T14:00:00Z'), deadline: '07:00' });
    for (const e of s.entries) {
      const period = s.periods.find((p) => p.periodStart === e.localDate)!;
      expect(e.loggedAt.getTime()).toBeLessThan(period.deadlineAt.getTime());
    }
  });

  it("refuses a now past today's evaluate_at, where day N would not be open", () => {
    // 12:00 MDT, with a 08:00 deadline and no grace: today is already decided.
    expect(() => towerRunningFor(3, { now: NOW, deadline: '08:00', grace: 0 })).toThrow(
      /past day 3's evaluate_at/
    );
  });

  it('membersLoggedToday: entries for today at now, today still open', () => {
    const s = towerRunningFor(4, { now: NOW, members: 3, traits: [membersLoggedToday(2)] });
    const today = s.entries.filter((e) => e.localDate === '2026-10-27');
    expect(today).toHaveLength(2);
    expect(today.every((e) => e.loggedAt.getTime() === NOW.getTime())).toBe(true);
    expect(s.periods.at(-1)!.state).toBe('pending');
  });

  it('reuses users passed as members, hosting with the first', () => {
    const f = factories({ seed: 99, now: NOW });
    const [alice, bob] = [f.makeUser({ displayName: 'Alice' }), f.makeUser({ displayName: 'Bob' })];
    const s = towerRunningFor(3, { now: NOW, members: [alice, bob] });
    expect(s.tower!.hostId).toBe(alice.id);
    expect(s.members.map((m) => m.user)).toEqual([alice, bob]);
    expect(new Set(s.habits.map((h) => h.id)).size).toBe(2);
  });

  it('is deterministic for a seed, and distinct across seeds', () => {
    const a = towerRunningFor(12, { now: NOW, members: 3, seed: 7 });
    expect(towerRunningFor(12, { now: NOW, members: 3, seed: 7 })).toEqual(a);
    expect(towerRunningFor(12, { now: NOW, members: 3, seed: 8 }).tower!.id).not.toBe(a.tower!.id);
  });

  it('tiered habits get tier 0, and logs at it', () => {
    const s = towerRunningFor(3, { now: NOW, habitType: 'tiered' });
    expect(s.habits[0]!.tiers.map((t) => t.tierIndex)).toContain(0);
    expect(s.entries.every((e) => e.tierReached === 0)).toBe(true);
  });
});

describe('towerWithBaseBlocks', () => {
  it('stacks n valid blocks under a live run', () => {
    const s = towerWithBaseBlocks(3, { now: NOW, members: 2 });
    expect(s.blocks).toHaveLength(3);
    for (const b of s.blocks) {
      expect(parseBlockRoster(b.roster).ok).toBe(true);
      expect(b.blockHeight).toBeGreaterThanOrEqual(3);
      expect(b.blockHeight).toBeLessThanOrEqual(daysBetween(b.runStartDate, b.runEndDate) + 1);
    }
    expect(s.tower!.height).toBe(2);
    expect(s.memberships.every((m) => m.state === 'active')).toBe(true);
  });

  it('composes with a member at risk on top', () => {
    const s = towerWithBaseBlocks(2, { now: NOW, members: 2, traits: [memberMissedPeriods(1)] });
    expect(s.blocks).toHaveLength(2);
    expect(s.memberships.map((m) => m.state)).toEqual(['active', 'at_risk']);
  });
});

describe('standaloneHabit', () => {
  it('logs the last n days, ending yesterday, with no tower', () => {
    const s = standaloneHabit({ now: NOW, type: 'numeric', loggedDays: 5 });
    expect(s.tower).toBeNull();
    expect(s.entries.map((e) => e.localDate)).toEqual([
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
    expect(s.entries.every((e) => e.numericValue === 30)).toBe(true);
  });
});

describe('factories', () => {
  it('rejects a tiered habit without tier 0, and tiers on other types', () => {
    const f = factories({ now: NOW });
    expect(() =>
      f.makeHabit({
        ownerId: 'x',
        type: 'tiered',
        tiers: [{ tierIndex: 1, label: 'x', thresholdValue: 1 }],
      })
    ).toThrow(/tier 0/);
    expect(() =>
      f.makeHabit({
        ownerId: 'x',
        type: 'binary',
        tiers: [{ tierIndex: 0, label: 'x', thresholdValue: 1 }],
      })
    ).toThrow(/binary/);
  });

  it('idGen emits v4-shaped uuids', () => {
    const next = idGen(123);
    for (let i = 0; i < 200; i++) expect(next()).toMatch(UUID_V4);
  });
});

describe('testClock', () => {
  it('moves only when told, and hands out copies', () => {
    const clock = testClock(NOW);
    clock.now.setTime(0);
    expect(clock.now).toEqual(NOW);
    expect(clock.advance({ days: 1, minutes: 30 })).toEqual(new Date('2026-10-28T18:30:00Z'));
    // TODO(tzdata-2026c)[offset]: Edmonton becomes 2026-11-02T04:00Z (or use America/Denver).
    expect(clock.toLocal('2026-11-01', '22:00', 'America/Edmonton')).toEqual(
      new Date('2026-11-02T05:00:00Z')
    );
  });
});
