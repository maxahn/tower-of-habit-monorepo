### Dev Cheat Sheet

**Connect to database from host:**
(Check your `.env.dev` or active .env. file for the correct user and database)

```bash
docker exec -it <container_name> psql -U tower -d tower_dev
```

Postgres common commands:

`\l` List databases
`\c database_name` Connect to a database
`\dt` List tables in the current schema
`\dt *.*` List tables across schemas
`\d table_name` Show table columns and indexes
`SELECT * FROM table_name LIMIT 10;` View table contents
`\q` Exit psql

### Test scenarios

Build realistic tower state in one line. Builders are pure (`@tower-of-habit/shared/testing`); `useScenarios` persists them and cleans up after each test.

```ts
import { memberMissedPeriods } from '@tower-of-habit/db/testing';
import { useScenarios } from '@tower-of-habit/db/testing/vitest';

const scenarios = useScenarios(); // now = SCENARIO_NOW unless you pass one

// A 3-member tower on day 12; the last member missed yesterday.
const s = await scenarios.towerRunningFor(12, { members: 3, traits: [memberMissedPeriods(1)] });
```

Builders: `towerRunningFor(days, opts)`, `towerWithBaseBlocks(n, opts)`, `standaloneHabit(opts)`. Traits: `memberMissedPeriods(n, { member })`, `allMembersDormant()`, `withBaseBlocks(n)`, `membersLoggedToday(k)`. For a movable `now`, use `testClock(start)`. Domain code never reads the system clock; you pass it the instant.

Period outcomes, tower height, membership state and base blocks come from `deriveTowerState`, which is **provisional**. It encodes the §5/§6 rules as currently written, until the evaluator (3.x) and recompute (1.12) take over as the source of truth.

### Dev seed

```bash
pnpm migrate:dev && pnpm seed:dev
```

This creates `alice@seed.local` and `bob@seed.local`, Alice's standalone "Read" habit, a 12-day tower ("Morning run"), and a tower with two base blocks where Bob is at risk ("Pushups"). Running it again replaces the previous seed. It refuses anything but a `*_dev` database unless `ALLOW_SEED=1` is set.
