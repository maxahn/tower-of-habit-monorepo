# Progress

**Next task:** 2.20 Integration test harness.

**Blockers:** none. Postgres (`localhost:5433`, `tower_test`) and Redis are reachable via
`pnpm dev:up`; `pnpm migrate:test` has been applied.

## Done

- 2.10 Request context and transaction helper: `apps/api/src/context.ts` (`requestClock`, `ctxOf`, `withTx`, `X-Test-Now` behind `ALLOW_TEST_CLOCK`), eslint rule for `apps/api/src`.
