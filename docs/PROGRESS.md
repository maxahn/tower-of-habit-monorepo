# Progress

**Next task:** 2.11 Users and profile.

**Blockers:** none. Postgres (`localhost:5433`, `tower_test`) and Redis are reachable via
`pnpm dev:up`; `pnpm migrate:test` has been applied.

## Done

- 2.10 Request context and transaction helper: `apps/api/src/context.ts` (`requestClock`, `ctxOf`, `withTx`, `X-Test-Now` behind `ALLOW_TEST_CLOCK`), eslint rule for `apps/api/src`.
- 2.20 Integration test harness: `apps/api/src/testing/integration.ts` (`useIntegrationApp`: real Postgres, truncate per test, fixture builder, minted sessions, code sink, test clock), `apps/api/src/compose.ts` (production wiring shared with index.ts), `pnpm test:integration`.
