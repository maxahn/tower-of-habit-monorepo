# Plan — Phase 2 remainder

Up to 2.9 Authentication (email OTP) has been implemented. Implement the rest of
[phase-2-tickets.md](phase-2-tickets.md), one task at a time, tests first.

Before implementing features, tests should be written first and committed. Tests should
generally fail before the feature is implemented, and then pass after the feature is
implemented. This ensures that the tests are actually testing the feature. Exceptions to
this rule are when a feature is being refactored, or when a feature is being implemented
that is not testable (e.g. a UI feature). In these cases, tests should be written after
the feature is implemented.

Where a ticket's vocabulary differs from the Phase 1 schema, the mapping is recorded in
[DECISIONS.md](DECISIONS.md). Each task below is one commit pair (test, feat) unless noted.

## Tasks

- [x] 2.10 Request context and transaction helper (`ctx.now`, `withTx`, `X-Test-Now`
      behind `ALLOW_TEST_CLOCK`, ESLint `no-restricted-syntax` for apps/api).
- [x] 2.20 Integration test harness (real Postgres, truncate between tests, fixture
      builder, minted sessions, in-memory code sink, `X-Test-Now`, one command).
- [x] 2.11 Users and profile (`GET /me`, `PATCH /me`, `GET /me/sessions`).
- [x] 2.12 Habits and tiers (CRUD, `PUT /habits/:id/tiers`, archive, tower lock rules).
- [ ] 2.13 Tower creation and lobby (`POST /towers`, `GET /towers`, `GET /towers/:id`).
- [ ] 2.14 Join, leave, remove (`POST /towers/join`, `DELETE /towers/:id/memberships/:id`).
- [ ] 2.15 Tower start (`POST /towers/:id/start`, period 1 materialised).
- [ ] 2.16 Logging entries (`POST /entries`, `GET /habits/:id/entries`).
- [ ] 2.17 Period preview (`GET /towers/:id/period`).
- [ ] 2.18 Rate limiting and abuse controls (join limits, write ceiling, fail-closed
      verify-code and join).
- [ ] 2.19 Internal evaluation trigger (`POST /internal/towers/:towerId/periods/:periodId/evaluate`).
- [ ] 2.21 End-to-end scenario test (the Phase 2 definition of done).

OpenAPI (`apps/api/src/docs/openapi.ts`) is updated in the same commit as each new route;
`openapi.test.ts` fails otherwise.
