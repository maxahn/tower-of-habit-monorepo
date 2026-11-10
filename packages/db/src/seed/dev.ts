/**
 * Dev seed (1.11): enough data to open the app and see every state without
 * waiting days. Idempotent: it deletes its own previous output first.
 *
 *   pnpm seed:dev            (ENV_FILE defaults to .env.dev, like drizzle.config.ts)
 *
 * This is the edge of the system, so it is the one place that reads the real
 * clock. Everything below it takes that `now` as a parameter.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = process.env.ENV_FILE ?? '.env.dev';
const envPath = resolve(process.cwd(), '../../', envFile);
if (existsSync(envPath)) process.loadEnvFile(envPath);

const SEED_EMAIL_DOMAIN = 'seed.local';

function assertSafeTarget(): void {
  if (process.env.ALLOW_SEED === '1') return;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'seed:dev refuses to run with NODE_ENV=production (set ALLOW_SEED=1 to override).'
    );
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL is not set (looked for ${envPath}).`);
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_dev')) {
    throw new Error(
      `seed:dev only targets *_dev databases, not "${dbName}" (set ALLOW_SEED=1 to override).`
    );
  }
}

async function main(): Promise<void> {
  assertSafeTarget();
  // Imported after the env file is loaded: client.ts reads DATABASE_URL at import.
  const [{ db }, { inArray, like, or }, schema, testing] = await Promise.all([
    import('../client.js'),
    import('drizzle-orm'),
    import('../schema.js'),
    import('../testing/index.js'),
  ]);
  const { users, towers, memberships } = schema;
  const {
    factories,
    memberMissedPeriods,
    persist,
    standaloneHabit,
    towerRunningFor,
    towerWithBaseBlocks,
  } = testing;

  const now = new Date();

  // Previous seed output. Towers first: memberships have no on-delete action
  // on users, and towers.host_id is RESTRICT.
  const previous = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${SEED_EMAIL_DOMAIN}`));
  const previousIds = previous.map((u) => u.id);
  if (previousIds.length) {
    const memberOf = db
      .select({ id: memberships.towerId })
      .from(memberships)
      .where(inArray(memberships.userId, previousIds));
    await db
      .delete(towers)
      .where(or(inArray(towers.hostId, previousIds), inArray(towers.id, memberOf)));
    await db.delete(users).where(inArray(users.id, previousIds));
  }

  // Fixed seeds, so ids are stable across reseeds (handy for deep links).
  const f = factories({ seed: 1, now });
  const alice = f.makeUser({ email: `alice@${SEED_EMAIL_DOMAIN}`, displayName: 'Alice' });
  const bob = f.makeUser({ email: `bob@${SEED_EMAIL_DOMAIN}`, displayName: 'Bob' });

  const reading = await persist(
    db,
    standaloneHabit({
      now,
      seed: 2,
      owner: alice,
      type: 'numeric',
      name: 'Read',
      unit: 'minutes',
      loggedDays: 5,
      timezone: 'America/Edmonton',
    })
  );
  const midRun = await persist(
    db,
    towerRunningFor(12, { now, seed: 3, members: [alice, bob], name: 'Morning run' })
  );
  const atRisk = await persist(
    db,
    towerWithBaseBlocks(2, {
      now,
      seed: 4,
      members: [alice, bob],
      name: 'Pushups',
      traits: [memberMissedPeriods(1, { member: 1 })],
    })
  );

  console.log(`Seeded at ${now.toISOString()} (passwords are placeholders until auth lands):`);
  console.log(`  users:  ${alice.email}, ${bob.email}`);
  console.log(
    `  solo:   "${reading.habits[0]!.name}" for Alice, ${reading.entries.length} days logged`
  );
  for (const s of [midRun, atRisk]) {
    const states = s.members.map((m) => `${m.user.displayName}=${m.membership.state}`).join(', ');
    console.log(
      `  tower:  "${s.tower!.name}" day ${s.periods.length}, height ${s.tower!.height}, ` +
        `${s.blocks.length} base blocks, join code ${s.tower!.joinCode} (${states})`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
