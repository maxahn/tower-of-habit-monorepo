# Tower of Habit MonoRepo

## Development

### Services (Docker)

- `pnpm services:up:dev` / `services:down:dev` — start/stop Postgres, Redis, Caddy, api, and worker using `.env.local`. This is the only variant that publishes Postgres (`127.0.0.1:5432`) and Redis (`127.0.0.1:6379`) to the host, since `dev:api`/`dev:worker`/`db:migrate` run on the host and need to reach the containers.
- `pnpm services:up` / `services:down` — plain stack; no Postgres/Redis host ports.
- `pnpm services:up:staging` / `services:down:staging` — same as plain, using `.env.staging`.

### App processes (run on host, not containerized)

- `pnpm dev:api` — runs `apps/api` via `tsx watch`. Requires `services:up:dev` running first so it can reach Postgres/Redis.
- `pnpm dev:worker` — same, for `apps/worker`.
- `pnpm dev:mobile` — starts the Expo app in `apps/mobile`.

### Database

- `pnpm db:generate` — runs `drizzle-kit generate` against `packages/db`; creates a new SQL migration file under `packages/db/migrations` from changes to `packages/db/src/schema.ts`. Run this first whenever the schema changes.
- `pnpm db:migrate` — runs `drizzle-kit migrate` against `packages/db`; applies pending migrations. Also requires `services:up:dev` for host access to Postgres.
- `pnpm --filter @tower-of-habit/db studio` — opens Drizzle Studio against the local database.

### Quality checks

- `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`.

### Adding packages

- `pnpm -F <package-name> add <dependency>` — adds a dependency to a specific package within the monorepo.
- `pnpm -F <package-name> remove <dependency>` — removes a dependency from a specific package within the monorepo.
- `pnpm add -D <package-name>` — adds a dev dependency to the root of the monorepo.
- `pnpm add <package-name>` — adds a dependency to the root of the monorepo.
