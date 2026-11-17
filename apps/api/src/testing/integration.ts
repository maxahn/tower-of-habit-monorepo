import {
  createHabit,
  createMembership,
  createSession,
  createTower,
  db,
  transitionHabit,
  users,
  type Habit,
  type Membership,
  type Tower,
  type User,
} from '@tower-of-habit/db';
import { testClock, type TestClock } from '@tower-of-habit/shared/testing';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { beforeEach } from 'vitest';
import type { AppEnv } from '../app.js';
import { generateSessionToken, hashToken } from '../auth/crypto.js';
import { createFakeSender, type FakeSender, type SentCode } from '../auth/testing.js';
import { composeApp, SESSION_TTL_SECONDS } from '../compose.js';
import { TEST_NOW_HEADER } from '../context.js';
import { createMemoryRateLimiter } from '../rate-limit/testing.js';
import { createMemoryLogger, type MemoryLogger } from './harness.js';

/*
 * 2.20: the integration harness. Real Postgres (DATABASE_URL from .env.test,
 * loaded by vitest.integration.config.ts), the production route table
 * (compose.ts), and in-memory stand-ins for the two things a test must be able
 * to see or control: the login-code sender and the rate limiter.
 *
 * Tables are truncated before every test. Users are created by direct insert
 * plus a minted session row, never by walking the OTP flow; the handful of
 * tests that exercise auth read the code from the sink.
 */

/** Every table, for one TRUNCATE. Order is irrelevant with CASCADE. */
const ALL_TABLES = [
  'users',
  'habits',
  'habit_tiers',
  'entries',
  'towers',
  'memberships',
  'tower_periods',
  'base_blocks',
  'push_tokens',
  'notifications',
  'auth_codes',
  'sessions',
];

export async function truncateAll(): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`));
}

/** The suite's default instant: a Monday, noon in Edmonton. */
export const INTEGRATION_NOW = new Date('2026-11-16T19:00:00.000Z');

/** A fixture user plus the raw token of a minted session. */
export type Actor = { user: User; token: string };

export type UserOptions = { email?: string; timezone?: string; displayName?: string | null };

export type HabitOptions = {
  name?: string;
  type?: 'binary' | 'numeric' | 'tiered';
  unit?: string;
  tiers?: readonly { tierIndex: number; label: string; thresholdValue: number | null }[];
};

export type TowerOptions = {
  name?: string;
  deadlineTime?: string;
  timezone?: string;
  graceWindowMinutes?: number;
  wobbleLeadMinutes?: number;
  nudgeLeadMinutes?: number;
};

export type LobbyMember = Actor & { habit: Habit; membership: Membership };

export type LobbyScenario = {
  tower: Tower;
  /** The host first. */
  members: LobbyMember[];
  host: LobbyMember;
};

export type RequestOptions = {
  method?: string;
  json?: unknown;
  /** Sends `Authorization: Bearer <token>`. */
  as?: Actor | { token: string };
  /** X-Test-Now for this request; defaults to the harness clock. */
  now?: string | Date;
  headers?: Record<string, string>;
};

export type IntegrationApp = {
  app: Hono<AppEnv>;
  logger: MemoryLogger;
  sender: FakeSender;
  clock: TestClock;
  sentCodes(): SentCode[];
  request(path: string, options?: RequestOptions): Promise<Response>;
  /** The headers the most recent request() sent, for asserting the clock. */
  lastRequestHeaders(): Record<string, string> | undefined;
  fixtures: {
    user(options?: UserOptions): Promise<Actor>;
    habit(owner: Actor, options?: HabitOptions): Promise<Habit>;
    tower(host: Actor, options?: TowerOptions): Promise<Tower>;
    membership(tower: Tower, member: Actor, habit: Habit): Promise<Membership>;
    /** A draft tower with `members` users, each with an active habit bound in. */
    lobby(options?: {
      members?: number;
      tower?: TowerOptions;
      habit?: HabitOptions;
    }): Promise<LobbyScenario>;
  };
};

let userSeq = 0;

/**
 * Builds the app once per file and truncates every table before each test.
 * Call at module scope, like useTestOwner in the db package.
 */
export function useIntegrationApp(options: { now?: Date } = {}): IntegrationApp {
  const logger = createMemoryLogger();
  const sender = createFakeSender();
  const clock = testClock(options.now ?? INTEGRATION_NOW);
  let lastHeaders: Record<string, string> | undefined;

  const app = composeApp({
    db,
    logger,
    sender,
    limiter: createMemoryRateLimiter(() => clock.now.getTime()),
    clientIp: (c) => c.req.header('x-test-ip') ?? null,
    readiness: { postgres: async () => undefined, redis: async () => undefined },
    isDraining: () => false,
    corsOrigins: [],
    bodyLimitBytes: 1024 * 1024,
    clock: { allowTestClock: true },
  });

  beforeEach(async () => {
    await truncateAll();
    logger.lines.length = 0;
    sender.sent.length = 0;
    clock.set(options.now ?? INTEGRATION_NOW);
  });

  async function mintSession(user: User): Promise<Actor> {
    const token = generateSessionToken();
    await createSession(db, {
      userId: user.id,
      tokenHash: hashToken(token),
      userAgent: 'integration-test',
      ttlSeconds: SESSION_TTL_SECONDS,
    });
    return { user, token };
  }

  const fixtures: IntegrationApp['fixtures'] = {
    async user(opts = {}) {
      const n = ++userSeq;
      const [user] = await db
        .insert(users)
        .values({
          email: opts.email ?? `user${n}@integration.test`,
          timezone: opts.timezone ?? 'America/Edmonton',
          displayName: opts.displayName === undefined ? `User ${n}` : opts.displayName,
        })
        .returning();
      return mintSession(user!);
    },

    async habit(owner, opts = {}) {
      const type = opts.type ?? 'binary';
      const base = { ownerId: owner.user.id, name: opts.name ?? 'Run' };
      const habit =
        type === 'binary'
          ? await createHabit(db, { ...base, type })
          : type === 'numeric'
            ? await createHabit(db, {
                ...base,
                type,
                unit: opts.unit ?? 'minutes',
                // Tier 0's threshold is what qualifies() checks (DECISIONS P9).
                tiers: opts.tiers ?? [{ tierIndex: 0, label: 'Base', thresholdValue: 20 }],
              })
            : await createHabit(db, {
                ...base,
                type,
                tiers: opts.tiers ?? [
                  { tierIndex: 0, label: 'Base', thresholdValue: null },
                  { tierIndex: 1, label: 'Strong', thresholdValue: null },
                ],
              });
      return transitionHabit(db, habit.id, 'active', clock.now);
    },

    async tower(host, opts = {}) {
      return createTower(db, {
        hostId: host.user.id,
        name: opts.name ?? 'Morning run',
        deadlineTime: opts.deadlineTime ?? '22:00',
        timezone: opts.timezone ?? 'America/Edmonton',
        ...(opts.graceWindowMinutes !== undefined
          ? { graceWindowMinutes: opts.graceWindowMinutes }
          : {}),
        ...(opts.wobbleLeadMinutes !== undefined
          ? { wobbleLeadMinutes: opts.wobbleLeadMinutes }
          : {}),
        ...(opts.nudgeLeadMinutes !== undefined ? { nudgeLeadMinutes: opts.nudgeLeadMinutes } : {}),
      });
    },

    async membership(tower, member, habit) {
      return createMembership(db, { towerId: tower.id, userId: member.user.id, habitId: habit.id });
    },

    async lobby(opts = {}) {
      const n = opts.members ?? 2;
      const actors: Actor[] = [];
      for (let i = 0; i < n; i++) actors.push(await fixtures.user());
      const tower = await fixtures.tower(actors[0]!, opts.tower);
      const members: LobbyMember[] = [];
      for (const actor of actors) {
        const habit = await fixtures.habit(actor, opts.habit);
        const membership = await fixtures.membership(tower, actor, habit);
        members.push({ ...actor, habit, membership });
      }
      return { tower, members, host: members[0]! };
    },
  };

  async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
    const now = opts.now === undefined ? clock.now : new Date(opts.now);
    const headers: Record<string, string> = {
      [TEST_NOW_HEADER]: now.toISOString(),
      ...(opts.as ? { authorization: `Bearer ${opts.as.token}` } : {}),
      ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    };
    lastHeaders = headers;
    return app.request(path, {
      method: opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'),
      headers,
      ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    });
  }

  return {
    app,
    logger,
    sender,
    clock,
    sentCodes: () => [...sender.sent],
    request,
    lastRequestHeaders: () => lastHeaders,
    fixtures,
  };
}
