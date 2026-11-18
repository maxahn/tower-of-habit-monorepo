# Progress

**Next task:** 3.4 claim wiring — wire `claimDuePeriods` and `evaluateTowerPeriod` into the tick loop.

**Blockers:** none.

## Done

- 2.10 Request context and transaction helper: `apps/api/src/context.ts` (`requestClock`, `ctxOf`, `withTx`, `X-Test-Now` behind `ALLOW_TEST_CLOCK`), eslint rule for `apps/api/src`.
- 2.20 Integration test harness: `apps/api/src/testing/integration.ts` (`useIntegrationApp`: real Postgres, truncate per test, fixture builder, minted sessions, code sink, test clock), `apps/api/src/compose.ts` (production wiring shared with index.ts), `pnpm test:integration`.
- 2.11 Users and profile: `GET/PATCH /v1/me`, `GET /v1/me/sessions` (`apps/api/src/me/routes.ts`); shared `me.ts` schemas; db `getUser`, `updateUser`, `countActiveTowersForUser`, `listLiveSessionsForUser`.
- 2.12 Habits and tiers: `apps/api/src/habits/routes.ts` (create/list/detail/patch/replace-tiers/archive, `habit_locked_by_tower`); shared `tierLadderIssues`, `replaceTiersRequestSchema`, `habitDetailResponseSchema`, `currentStreak`; db numeric ladders (DECISIONS P9), `replaceTiers`, `listHabitsForOwner`, `findHabitTower`; db modules now take the `Db` union (usable inside a transaction).
- 2.13 Tower creation and lobby: `POST/GET /v1/towers`, `GET /v1/towers/:id` (`apps/api/src/towers/routes.ts`, `service.ts`); shared `createTowerRequestSchema` now takes `habitId`, `towerDetailResponseSchema` (lobby | active), `towerListResponseSchema`; db `createTowerWithFreshCode` (5 retries), `listTowersForUser`, `listTowerMembers`.
- 2.14 Join, leave, remove: `POST /v1/towers/join`, `DELETE /v1/towers/:id/memberships/:membershipId` (lobby only; creator alone disbands); db `findTowerByJoinCode`.
- 2.15 Tower start: `POST /v1/towers/:id/start` (creator only, ≥ 2 members, period 1 via `computePeriodWindow`, next-day rule, idempotent); `apps/api/src/towers/periods.ts` (`periodWindowFor`, `firstPeriodStart`, `periodInsert`); db `activateTower`.
- 2.16 Logging entries: `POST /v1/entries`, `GET /v1/habits/:id/entries` (`apps/api/src/entries/routes.ts`: D3 zones, optional validated `localDate`, computed `source`, 2.3 qualification, dormant-return on a qualifying log); db `recordEntry`; shared `logEntryResponseSchema`, `entryListResponseSchema`.
- 2.17 Period preview: `GET /v1/towers/:id/period` (read-only `evaluatePeriod` at `ctx.now`); `apps/api/src/evaluation/input.ts` (`loadEvaluationInput`, shared with 2.19); shared `periodPreviewResponseSchema`, `currentRunStart`; db `countQualifyingDays`.
- 2.18 Rate limiting: `enforceRateLimits` gains `failClosed` (503 `rate_limiter_unavailable`); verify-code and join-by-code (10/user/h, 30/IP/h) fail closed; per-user write ceiling (`rate-limit/write-ceiling.ts`, 600/h, fails open) on the authenticated router.
- 2.21 End-to-end scenario test: `apps/api/src/integration/e2e-scenario.integration.test.ts` (full Phase 2 walk-through: OTP auth, habits, tower lifecycle, wobble, collapse, base block, dormancy, solo continuation, reactivation; outsider isolation with third user Charlie).
- Schema ERD generator: `packages/db/scripts/generate-erd.ts` (introspects Drizzle schema via `getTableConfig`, outputs Mermaid ER diagram HTML to `docs/schema-erd.html`; `pnpm db:erd` to regenerate).
- Phase 3 reconciliation: updated `docs/phase-3-tickets.md` and `docs/phase-3-PLAN.md` against actual Phase 1/2 implementation. C1–C6 resolved, M1/M2 marked complete, tickets 3.4/3.5/3.9/3.10/3.11 rewritten to reflect existing code, 3.9 absorbed into 3.5, BullMQ→Graphile Worker noted in 3.1, estimate reduced to 10–14 days.
- 2.19 Internal evaluation trigger: `POST /v1/internal/towers/:towerId/periods/:periodId/evaluate` behind `INTERNAL_API_TOKEN` (`apps/api/src/internal/routes.ts`); `apps/api/src/evaluation/service.ts` (`evaluateTowerPeriod(tx, towerId, periodId, now)` for Phase 3 to import: claim with FOR UPDATE SKIP LOCKED, outcome incl. hibernated, height/streak, base block via `buildBaseBlockDraft`, §6 transitions + backstop, next period); db `lockPeriodForEvaluation`, `lockTower`, `extendTowerRun`, `closeTowerRun`, `listQualifyingDaysInRange`, `createMembership` takes `joinedAt`; shared `evaluationResponseSchema`. DECISIONS P15 records the height-on-collapse semantics.
