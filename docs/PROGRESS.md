# Progress

**Next task:** 2.16 Logging entries.

**Blockers:** none. Postgres (`localhost:5433`, `tower_test`) and Redis are reachable via
`pnpm dev:up`; `pnpm migrate:test` has been applied.

## Done

- 2.10 Request context and transaction helper: `apps/api/src/context.ts` (`requestClock`, `ctxOf`, `withTx`, `X-Test-Now` behind `ALLOW_TEST_CLOCK`), eslint rule for `apps/api/src`.
- 2.20 Integration test harness: `apps/api/src/testing/integration.ts` (`useIntegrationApp`: real Postgres, truncate per test, fixture builder, minted sessions, code sink, test clock), `apps/api/src/compose.ts` (production wiring shared with index.ts), `pnpm test:integration`.
- 2.11 Users and profile: `GET/PATCH /v1/me`, `GET /v1/me/sessions` (`apps/api/src/me/routes.ts`); shared `me.ts` schemas; db `getUser`, `updateUser`, `countActiveTowersForUser`, `listLiveSessionsForUser`.
- 2.12 Habits and tiers: `apps/api/src/habits/routes.ts` (create/list/detail/patch/replace-tiers/archive, `habit_locked_by_tower`); shared `tierLadderIssues`, `replaceTiersRequestSchema`, `habitDetailResponseSchema`, `currentStreak`; db numeric ladders (DECISIONS P9), `replaceTiers`, `listHabitsForOwner`, `findHabitTower`; db modules now take the `Db` union (usable inside a transaction).
- 2.13 Tower creation and lobby: `POST/GET /v1/towers`, `GET /v1/towers/:id` (`apps/api/src/towers/routes.ts`, `service.ts`); shared `createTowerRequestSchema` now takes `habitId`, `towerDetailResponseSchema` (lobby | active), `towerListResponseSchema`; db `createTowerWithFreshCode` (5 retries), `listTowersForUser`, `listTowerMembers`.
- 2.14 Join, leave, remove: `POST /v1/towers/join`, `DELETE /v1/towers/:id/memberships/:membershipId` (lobby only; creator alone disbands); db `findTowerByJoinCode`.
- 2.15 Tower start: `POST /v1/towers/:id/start` (creator only, ≥ 2 members, period 1 via `computePeriodWindow`, next-day rule, idempotent); `apps/api/src/towers/periods.ts` (`periodWindowFor`, `firstPeriodStart`, `periodInsert`); db `activateTower`.
