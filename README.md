# Tower of Habit MonoRepo

## Development

### Setup

**Prerequisites:**

- Node 24.x (check `.nvmrc`)
- pnpm 9.x or later

**First-time setup:**

```bash
nvm use              # Uses .nvmrc
pnpm install         # Installs all workspaces
husky install        # Enables pre-commit hooks
pnpm migrate:dev       # Applies migrations to local dev database
pnpm migrate:seed     # Seeds local dev database
```

### Dev Scripts

pnpm dev # Runs dev in all workspaces in parallel
pnpm -F backend dev # Run backend only
pnpm -F client dev # Run client only
pnpm lint # Lint all workspaces
pnpm format # Format all files

### Services (Docker)

- `pnpm dev:up` / `dev:down` — start/stop Postgres, Redis, Caddy, api, and worker using `.env.dev`. This is the only variant that publishes Postgres (`127.0.0.1:5433` → container `5432`; override with `POSTGRES_HOST_PORT`) and Redis (`127.0.0.1:6379`) to the host, since `dev:api`/`dev:worker`/`migrate:dev` run on the host and need to reach the containers.
- `pnpm db:admin` — starts pgAdmin (and Postgres) at http://localhost:5050 (override with `PGADMIN_HOST_PORT`). Also started by `dev:up`. The `tower (dev)` server is pre-registered; enter `POSTGRES_PASSWORD` on first connect and tick "Save password".
- `pnpm services:up` / `services:down` — plain stack; no Postgres/Redis host ports.
- `pnpm services:up:staging` / `services:down:staging` — same as plain, using `.env.staging`.

### App processes (run on host, not containerized)

- `pnpm dev:api` — runs `apps/api` via `tsx watch`. Starts Postgres and Redis with host ports published first, so it needs no separate `dev:up`.
- `pnpm dev:worker` — same, for `apps/worker`.
- `pnpm dev:mobile` — starts the Expo app in `apps/mobile`.

### Database

- `pnpm db:generate` — runs `drizzle-kit generate` against `packages/db`; creates a new SQL migration file under `packages/db/migrations` from changes to `packages/db/src/schema.ts`. Run this first whenever the schema changes.
- `pnpm migrate:dev` — runs `drizzle-kit migrate` against `packages/db` using `.env.dev`; applies pending migrations. Requires `dev:up` for host access to Postgres.
- `pnpm migrate:test` — same, against the `tower_test` database using `.env.test`.
- Host-run tools connect through the published port, so the `DATABASE_URL` in `.env.dev` / `.env.test` must use `localhost:5433` (not `postgres:5432`, which only resolves inside Docker, and not `5432`, which a native Postgres install may already hold).
- `pnpm db:erd` — regenerates the schema ERD in both `docs/schema-erd.html` and the [ERD](#erd) section below from the Drizzle schema. Run after schema changes.
- `pnpm --filter @tower-of-habit/db studio` — opens Drizzle Studio against the local database.

### Quality checks

- `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`.
- `pnpm test:integration` — runs the API's integration suite (`apps/api/src/**/*.integration.test.ts`) against the real Postgres from Compose using `.env.test`: `pnpm dev:up`, `pnpm migrate:test`, then this. Tables are truncated before every test. `X-Test-Now` is honoured by the app under test, so a test can cross a period deadline without sleeping.
- `pnpm test:coverage` — runs each package's tests with V8 coverage. Per-package reports land in `packages/*/coverage/` and `apps/api/coverage/` (open `index.html`; `lcov.info` for editor/CI tools). The db suite needs Postgres: `pnpm dev:up` then `pnpm migrate:test`.
- `pnpm coverage:readme` — runs coverage and rewrites the table in [Coverage](#coverage) below. Run it before committing when you want the README numbers refreshed. If Postgres isn't reachable, the db row is kept and marked stale.

### Coverage

Last generated with `pnpm coverage:readme`. Coverage counts code that ran during tests, not code whose behavior was asserted.

<!-- coverage:start -->

| Package | Statements | Branches | Functions | Lines | Tests              |
| ------- | ---------: | -------: | --------: | ----: | ------------------ |
| shared  |      99.2% |    97.9% |    100.0% | 99.2% | 1613 passed (1613) |
| db      |      93.3% |    92.9% |     92.3% | 93.3% | 541 passed (541)   |
| api     |      53.5% |    90.1% |     84.3% | 53.5% | 173 passed (173)   |

<!-- coverage:end -->

### Adding packages

- `pnpm -F <package-name> add <dependency>` — adds a dependency to a specific package within the monorepo.
- `pnpm -F <package-name> remove <dependency>` — removes a dependency from a specific package within the monorepo.
- `pnpm add -D <package-name>` — adds a dev dependency to the root of the monorepo.
- `pnpm add <package-name>` — adds a dependency to the root of the monorepo.

### ERD

<!-- erd:start -->

```mermaid
erDiagram
    towers ||--o{ base_blocks : "towerId [cascade]"
    habits ||--o{ entries : "habitId [cascade]"
    habits ||--o{ habit_tiers : "habitId [cascade]"
    users ||--o{ habits : "ownerId [cascade]"
    towers ||--o{ memberships : "towerId [cascade]"
    users ||--o{ memberships : "userId [no action]"
    habits ||--o{ memberships : "habitId [no action]"
    users ||--o{ notifications : "userId [cascade]"
    towers ||--o{ notifications : "towerId [cascade]"
    users ||--o{ push_tokens : "userId [cascade]"
    users ||--o{ sessions : "userId [cascade]"
    towers ||--o{ tower_periods : "towerId [cascade]"
    users ||--o{ tower_periods : "freebieGrantedBy [no action]"
    users ||--o{ towers : "hostId [restrict]"

    auth_codes {
        text id
        text email
        text codeHash
        int attemptCount
        timestamp expiresAt
        timestamp consumedAt "nullable"
        timestamp createdAt
    }
    base_blocks {
        text id
        text towerId FK
        int ordinal
        text runStartDate
        text runEndDate
        int blockHeight
        jsonb roster
        timestamp createdAt
    }
    email_deliverability {
        text email
        text reason
        timestamp markedAt
    }
    entries {
        text id
        text habitId FK
        text localDate
        int tierReached
        int numericValue "nullable"
        timestamp loggedAt
        bool countsTowardQuota
        text clientEntryId "nullable"
        timestamp createdAt
    }
    habit_tiers {
        text id
        text habitId FK
        int tierIndex
        text label
        int thresholdValue "nullable"
    }
    habits {
        text id
        text ownerId FK
        text name
        text type
        text unit "nullable"
        text periodUnit
        int periodLength
        int quota
        text lifecycle
        timestamp startedAt "nullable"
        timestamp archivedAt "nullable"
        timestamp createdAt
        timestamp updatedAt
    }
    memberships {
        text id
        text towerId FK
        text userId FK
        text habitId FK
        text state
        int consecutiveMissedPeriods
        text lastQualifyingDate "nullable"
        timestamp dormantSince "nullable"
        text dormancyReason "nullable"
        text voluntaryReturnDate "nullable"
        int voluntaryAbsenceDaysUsed
        timestamp joinedAt
    }
    notifications {
        text id
        text userId FK
        text towerId FK
        text type
        text dedupeKey
        timestamp scheduledFor
        text status
        int attempts
        timestamp sentAt "nullable"
        text error "nullable"
        timestamp createdAt
    }
    push_tokens {
        text id
        text userId FK
        text token
        text platform
        timestamp createdAt
        timestamp lastSeenAt
        timestamp invalidatedAt "nullable"
    }
    sessions {
        text id
        text userId FK
        text tokenHash
        text previousTokenHash "nullable"
        timestamp rotatedAt "nullable"
        text userAgent "nullable"
        timestamp createdAt
        timestamp lastSeenAt
        timestamp expiresAt
        timestamp revokedAt "nullable"
    }
    tower_periods {
        text id
        text towerId FK
        text periodStart
        text periodEnd
        timestamp deadlineAt
        timestamp evaluateAt
        text state
        text outcome "nullable"
        timestamp evaluatedAt "nullable"
        timestamp claimedAt "nullable"
        int attempts
        text freebieSource "nullable"
        text freebieGrantedBy FK "nullable"
        timestamp createdAt
    }
    towers {
        text id
        text hostId FK
        text name
        text periodUnit
        int periodLength
        int quota
        text deadlineTime
        text timezone
        int weekResetDay "nullable"
        text joinCode
        int wobbleLeadMinutes
        int nudgeLeadMinutes
        int graceWindowMinutes
        text lifecycle
        int height
        int currentStreak
        timestamp startedAt "nullable"
        timestamp createdAt
    }
    users {
        text id
        text email
        text timezone
        text displayName "nullable"
        timestamp createdAt
        timestamp updatedAt
    }
```

<!-- erd:end -->
