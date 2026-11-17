# Tower — Phase 2 tickets

**Scope:** pure domain evaluator in `packages/shared` + Hono API in `apps/api`.
**Not in scope:** the worker, scheduler tick, and push delivery (Phase 3), and the Expo client (Phase 4).

---

## Preconditions

Phase 2 assumes Phase 1 has landed:

- `packages/db` holds the Drizzle schema and migrations for all 13 tables, the enum types, and the partial unique index `entries_one_qualifying_day`.
- `apps/api` and `packages/shared` exist as workspace packages with TypeScript configured.
- Postgres and Redis are reachable from the API container via Docker Compose.

If any of those are not true, they are Phase 1 corrections, not Phase 2 tickets.

## Phase 2 definition of done

A tower can be created, joined, started, logged against, and evaluated end to end through HTTP, with no worker running. Evaluation is triggered manually through a guarded internal endpoint; Phase 3 replaces the _caller_, not the logic.

Concretely: two accounts can create habits, form a tower, start it, log entries, see the tower survive a period, deliberately miss one, see it collapse, see the base block written with both rosters, and see the second member go dormant on a second consecutive miss.

---

## Resolved decisions

| #   | Decision              | Resolution                                                                                                                                                                                                  | Affects   |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| D1  | Auth mechanism        | **Email OTP** — 6-digit code, 10-minute expiry. No password storage, no native crypto dependency, and no Apple-sign-in obligation until store submission.                                                   | 2.9       |
| D2  | Session transport     | Opaque token in `Authorization: Bearer`, stored in `expo-secure-store`, server-side session row. Revocation matters more than statelessness here; a single VM has no cross-region latency argument for JWT. | 2.9       |
| D3  | Day-boundary timezone | Tower timezone for tower-bound habits; user timezone for standalone habits.                                                                                                                                 | 2.2, 2.16 |
| D4  | Join code format      | 6 characters, Crockford base32 minus `I/L/O/U`. 32^6 ≈ 1.07bn, combined with rate limiting in 2.18.                                                                                                         | 2.13      |
| D5  | Date library          | Luxon for IANA zone arithmetic. Temporal is still polyfill-only on Node 22; revisit when it ships unflagged.                                                                                                | 2.2       |
| D6  | Entry idempotency     | Client-supplied UUID `idempotency_key`, unique per habit. Mobile retries on flaky connections are the normal case, not the exception.                                                                       | 2.16      |

**D1 consequence worth noting up front:** OTP means there is no password to reset, no password to leak, and no credential-stuffing surface — the account recovery story _is_ the login story. The cost is that login depends on email delivery, so Phase 2 writes the code to the application log behind a flag and real delivery lands in Phase 3. That is fine for development and for a two-account test, but it is a hard gate on anyone else using the app, so it belongs early in Phase 3 rather than late.

---

# Workstream 2A — `packages/shared` domain evaluator

The hard constraint from the architecture notes: **the evaluator is a pure function.** State in, decisions out. No database access, no `Date.now()`, no `new Date()` without an argument. The evaluation instant is always a parameter.

This is what lets the API call it for _preview_ ("will this log save the tower?") and the Phase 3 worker call it for _decision_ — the same code, two callers, no divergence.

---

### 2.1 — Domain types and zod schemas

**Package:** `packages/shared`
**Depends on:** Phase 1 schema

**Scope**

Define the domain types and zod schemas that both the API and the mobile client import. This package must not import a database driver — that's the whole reason it's split from `packages/db`.

**Acceptance criteria**

- [ ] Enum unions mirror the Postgres enums exactly: `HabitType`, `PeriodType`, `HabitStatus`, `TowerStatus`, `MembershipState`, `MembershipEventType`, `PeriodStatus`, `EntrySource`.
- [ ] Zod schemas for every API request and response body, exported alongside inferred TS types.
- [ ] A single `export * from './schemas'` barrel; no deep imports required by consumers.
- [ ] `pnpm --filter @tower-of-habit/shared build` emits types with no `any` in the public surface.
- [ ] Importing the package in a file that has no `pg` dependency compiles clean.

**Implementation notes**

Derive the enum unions from one const array per enum (`as const` + `typeof arr[number]`) so the zod schema and the TS type can't drift. Add a type-level assertion test that each union is assignable to the Drizzle enum's inferred type — this catches a Phase 1 migration changing an enum without this package noticing.

---

### 2.2 — Period window calculation

**Package:** `packages/shared`
**Depends on:** 2.1, D3, D5

**Scope**

Given a tower config and a period start date, compute the four instants that govern the period.

```ts
export interface PeriodWindow {
  periodStart: string; // ISO date, tower-local
  periodEnd: string; // ISO date, tower-local, inclusive
  nudgeAt: string; // ISO instant
  wobbleAt: string; // ISO instant
  deadlineAt: string; // ISO instant
  evaluateAt: string; // ISO instant
}

export function computePeriodWindow(
  tower: Pick<
    TowerConfig,
    | 'cadence'
    | 'timezone'
    | 'deadlineLocalTime'
    | 'graceWindowMinutes'
    | 'wobbleLeadMinutes'
    | 'weekResetDay'
  >,
  periodStart: string
): PeriodWindow;
```

**Acceptance criteria**

- [ ] `deadlineAt` = `periodEnd` at `deadlineLocalTime` in the tower timezone, converted to UTC.
- [ ] `evaluateAt` = `deadlineAt + graceWindowMinutes`.
- [ ] `wobbleAt` = `deadlineAt − wobbleLeadMinutes`.
- [ ] `nudgeAt` = `deadlineAt − (wobbleLeadMinutes × 2)`, floored at `periodStart` 00:00 local.
- [ ] Daily cadence: `periodEnd === periodStart`.
- [ ] Weekly cadence [v2]: `periodEnd` = the day before the next `weekResetDay`. Implement now, leave unreachable until v2.
- [ ] Spring-forward: a `deadlineLocalTime` that does not exist on that date resolves forward to the next valid instant.
- [ ] Fall-back: an ambiguous local time resolves to the **first** (pre-transition) occurrence.
- [ ] Pure — the module imports nothing that reads a clock.

**Implementation notes**

The DST rules above are a choice, not a default; Luxon will otherwise pick for you silently. Resolving forward on spring-forward means a 02:30 deadline becomes 03:00 for one day, which shortens that period by 30 minutes rather than lengthening it by 23 hours. Resolving to the first occurrence on fall-back means the deadline doesn't drift later into a day that already has an extra hour in it. Both choices favour "the period never gets unexpectedly longer".

**On D3 (which timezone owns "today").** For a habit bound into a tower, `local_date` is resolved in the **tower's** timezone. If each member resolved their own day boundary, two members in different zones would be logging against different days and the quota check would be comparing incompatible things. The cost is that a member far from the tower's timezone has a deadline at an odd local hour — surface this clearly in the lobby UI rather than trying to solve it in the model. A standalone habit has no tower, so it resolves in the user's timezone; entries written before the habit joined a tower keep whatever `local_date` they were written with, which is correct — that's history, not current state.

**Tests**

Table-driven, with at least: America/Regina (no DST — the local case, and a useful control), America/Edmonton across both 2027 transitions, Asia/Kolkata (half-hour offset), Pacific/Chatham (45-minute offset), UTC, and a tower timezone that differs from the acting member's.

---

### 2.3 — Entry qualification rules

**Package:** `packages/shared`
**Depends on:** 2.1

**Scope**

Decide whether a single entry qualifies — that is, whether it reaches base tier.

```ts
export function qualifies(habit: HabitConfig, entry: EntryDraft): boolean;
```

**Acceptance criteria**

- [ ] `binary`: any entry qualifies.
- [ ] `numeric`: qualifies when `value >= tiers[0].threshold`.
- [ ] `tiered`: qualifies when `tierLevel >= 0`.
- [ ] A numeric habit with no tier 0 threshold is a configuration error, surfaced as a typed error rather than defaulting to `true`.
- [ ] Returns the same result for the same input regardless of call order or ambient state.

**Implementation notes**

Qualification is deliberately separate from _recording_. A non-qualifying entry is still persisted — it feeds tier history, personal bests, and numeric totals. Only the qualifying flag drives the tower. Keep this function free of any notion of "already logged today"; that's the database's job via the partial unique index, not the evaluator's.

---

### 2.4 — Period evaluation

**Package:** `packages/shared`
**Depends on:** 2.2, 2.3

**Scope**

The core function. Given a tower, a period, and every member's state within it, decide the period's outcome.

```ts
export interface EvaluationInput {
  now: string; // ISO instant — injected, never read from a clock
  tower: TowerConfig;
  window: PeriodWindow;
  members: MemberPeriodState[]; // qualifyingDays, excused, consecutiveMisses, state
}

export interface EvaluationOutput {
  periodStatus: 'open' | 'wobbling' | 'survived' | 'collapsed';
  perMember: MemberOutcome[];
  transitions: MembershipTransition[];
  baseBlock?: BaseBlockDraft;
  nextPeriodStart?: string;
}

export function evaluatePeriod(input: EvaluationInput): EvaluationOutput;
```

**Acceptance criteria**

- [ ] `now < wobbleAt` and quota unmet → `open`.
- [ ] `now >= wobbleAt`, `now < evaluateAt`, at least one non-excused member short of quota → `wobbling`, with those members named in `perMember`.
- [ ] All non-excused active members meet quota → `survived`, regardless of `now`.
- [ ] `now >= evaluateAt` and any non-excused active member short of quota → `collapsed`.
- [ ] Excused members (declared voluntary absence) never cause `wobbling` or `collapsed`.
- [ ] Dormant members are excluded from the quota check entirely.
- [ ] A tower with zero active members returns `survived` and sets no transitions — hibernation is the caller's concern.
- [ ] `collapsed` populates `baseBlock` only when the run length meets the minimum (see 2.6).
- [ ] Calling twice with identical input returns deeply equal output.
- [ ] Calling with `now` moved backwards never turns `collapsed` into `open` — the function is monotonic in `now` for a fixed member state.

**Implementation notes**

The monotonicity criterion is the one worth testing hardest. `evaluate_at` exists specifically so a period cannot be un-collapsed, and that guarantee has to hold in the pure function as well as in the database — otherwise a replayed or late tick could reverse a collapse that members have already been notified about.

Slack is computed here even for daily towers, where it is always zero. Writing the daily path as `slack = daysRemaining − daysNeeded` rather than a boolean means the v2 weekly path is a config change, not a second code path.

---

### 2.5 — Dormancy and escalation state machine

**Package:** `packages/shared`
**Depends on:** 2.4

**Scope**

Produce the membership transitions that a period outcome implies.

| Current state       | Condition                        | Next state     | Collapse? |
| ------------------- | -------------------------------- | -------------- | --------- |
| `active`            | met quota                        | `active`       | no        |
| `active`            | missed, `consecutive_misses = 0` | `at_risk`      | **yes**   |
| `at_risk`           | met quota                        | `active`       | no        |
| `at_risk`           | missed again                     | `dormant_auto` | **no**    |
| `dormant_auto`      | logs once                        | `active`       | no        |
| any active          | no entry for 14 days             | `dormant_auto` | no        |
| `dormant_voluntary` | return date reached              | `active`       | no        |

**Acceptance criteria**

- [ ] At most one collapse per absent member per absence — the second consecutive miss transitions to dormant _instead of_ collapsing.
- [ ] The 14-day backstop fires independently of cadence, based on the habit's most recent qualifying entry.
- [ ] Returning from `dormant_auto` resets `consecutive_misses` to 0.
- [ ] A return in the middle of an open period counts that period's entries that already exist.
- [ ] Every transition emits a `MembershipTransition` carrying `type`, `effectiveFrom`, and the reason — these become `membership_events` rows.
- [ ] Voluntary dormancy is never auto-escalated; it expires on its own date.

**Implementation notes**

`consecutive_misses` is denormalised onto `memberships` in the Phase 1 schema so this runs as one read at evaluation time rather than a window query over `period_results`. The evaluator receives it as input and returns the new value — it does not compute it from history, which keeps the function cheap and the caller in charge of persistence.

---

### 2.6 — Base block draft

**Package:** `packages/shared`
**Depends on:** 2.4

**Scope**

On collapse, build the base block payload: run bounds, height, periods survived, and the per-member roster.

**Acceptance criteria**

- [ ] `heightDays` = qualifying days in the collapsed run.
- [ ] Runs shorter than the minimum (3 days, from config not a literal) return no base block; height is still preserved on the tower.
- [ ] Roster includes every member who held a membership during the run, including those who went dormant mid-run, each with `qualifyingDays`, `periodsPresent`, `highestTier`, and `wasDormant`.
- [ ] `ordinal` is supplied by the caller, not computed here — the evaluator doesn't know how many blocks already exist.
- [ ] **No field identifies who caused the collapse**, and no combination of returned fields makes it derivable from a single block in isolation.

**Implementation notes**

The last criterion is a product decision from the spec, and it's easy to violate by accident — adding a `missedBy` array for "debugging" would reintroduce exactly the permanent blame record the design rules out. If something is needed for support, log it to the application log, not to a user-visible table.

---

### 2.7 — Evaluator test suite

**Package:** `packages/shared`
**Depends on:** 2.2 … 2.6

**Scope**

Table-driven fixtures covering the full matrix, plus property tests for the invariants.

**Acceptance criteria**

- [ ] Fixtures for: clean survival, single miss → collapse, second miss → dormancy, excused absence, all-dormant, one-active-member, return mid-period, 14-day backstop, sub-minimum run on collapse.
- [ ] DST fixtures from 2.2 wired through a full evaluation, not just window computation.
- [ ] Property: for fixed member state, `evaluatePeriod` is monotonic in `now` across `open → wobbling → collapsed`.
- [ ] Property: output is deeply equal across repeated calls with identical input.
- [ ] Property: no input combination produces `collapsed` with a `baseBlock` whose `heightDays` is 0.
- [ ] Coverage of `packages/shared` domain modules ≥ 90% lines, and 100% of branch coverage in `evaluatePeriod`.
- [ ] Suite runs with no database and no network, in under 5 seconds.

---

# Workstream 2B — API foundation

---

### 2.8 — Hono app skeleton

**Package:** `apps/api`
**Depends on:** 2.1

**Scope**

The app shell: router mounting, middleware stack, error handling, health endpoints.

**Acceptance criteria**

- [ ] Middleware order: request ID → structured logger → CORS → body limit → auth → route.
- [ ] Every response error uses one envelope: `{ error: { code, message, details? } }` with a stable machine-readable `code`.
- [ ] A thrown `DomainError` maps to its own status; an unhandled throw maps to `500` and logs with the request ID, never leaking the message to the client.
- [ ] Zod validation failures map to `400` with `code: "validation_failed"` and a field-keyed `details`.
- [ ] `GET /healthz` returns 200 without touching the database; `GET /readyz` checks Postgres and Redis and returns 503 when either is down.
- [ ] Graceful shutdown drains in-flight requests on `SIGTERM` before exit.

**Implementation notes**

Split `/healthz` from `/readyz` deliberately — Compose restart policy should key on liveness, and the Caddy upstream check on readiness. A single combined endpoint causes restart loops when Postgres is briefly unavailable but the process is fine.

---

### 2.9 — Authentication (email OTP)

**Package:** `apps/api`
**Depends on:** 2.8, D1, D2

**Scope**

Code request, code verification, logout, session middleware. No passwords anywhere in the schema or the API surface.

**Endpoints**

| Method | Path                        | Notes                                         |
| ------ | --------------------------- | --------------------------------------------- |
| POST   | `/auth/request-code`        | Always `202`, whether or not the email exists |
| POST   | `/auth/verify-code`         | Returns session token + user                  |
| POST   | `/auth/logout`              | Revokes current session                       |
| POST   | `/auth/sessions/revoke-all` | Revokes every session for the user            |

**Acceptance criteria — codes**

- [ ] Codes are 6 digits, generated with CSPRNG (rejection-sampled, not `% 1000000`, which biases the low end).
- [ ] Single-use, 10-minute expiry, and invalidated after 5 failed verification attempts.
- [ ] Stored as SHA-256 hashes, not plaintext — a 6-digit space is brute-forceable offline in milliseconds, so a leaked table of live codes is a leaked set of accounts.
- [ ] Requesting a new code invalidates any outstanding code for that email, so only one is ever live.
- [ ] Verification compares with a constant-time comparison.
- [ ] Codes never appear in logs, error messages, or validation `details`, enforced by the field allowlist below.
- [ ] A consumed, expired, or unknown code all return `401` with `code: "invalid_code"` — one body, one status.

**Acceptance criteria — enumeration**

- [ ] `POST /auth/request-code` returns `202` with an empty body for both known and unknown emails, with no timing difference large enough to distinguish them.
- [ ] No endpoint in the API reveals whether an email has an account. This is strictly better than the password alternative, where a duplicate-registration error has to say so.
- [ ] Email is normalised on write and compared case-insensitively: trim, lowercase. No other normalisation (no dot-stripping, no plus-tag removal — those are provider-specific and wrong as often as right).

**Acceptance criteria — sessions**

- [ ] Session tokens are 32 bytes of CSPRNG output, base64url-encoded, stored as SHA-256 hashes, never logged.
- [ ] Token lookup is by hash; a raw token is never persisted in any form.
- [ ] Sessions carry `created_at`, `last_seen_at`, `expires_at` (90 days), and an optional `user_agent`.
- [ ] Session middleware attaches `userId` to context, refreshes `last_seen_at` at most once per hour, and returns `401` with `code: "unauthenticated"` otherwise.
- [ ] An expired or revoked session returns `401`, not `403`.
- [ ] First successful verification creates the user, with `timezone` from a request field, validated against the IANA database, defaulting to UTC.

**Acceptance criteria — rate limiting**

- [ ] `POST /auth/request-code`: 3 per email per 15 minutes and 10 per IP per 15 minutes, returning `429` with `Retry-After`.
- [ ] `POST /auth/verify-code`: 10 per email per 15 minutes, independent of the per-code attempt cap.
- [ ] Counters live in Redis per 2.18 and key on the normalised email, not the raw input.

**Implementation notes**

**On delivery in Phase 2.** Write the code to the application log behind `AUTH_CODE_LOG=true`, defaulted false and asserted false in production config. Real email delivery is Phase 3. Keep the sender behind a one-method interface (`sendLoginCode(email, code)`) so Phase 3 swaps the implementation without touching the handler.

**On storing code hashes.** It feels like overkill for a value that lives 10 minutes, but a 6-digit code has 20 bits of entropy — a leaked `auth_codes` table is equivalent to a leaked set of live sessions, and hashing costs nothing here. SHA-256 is correct rather than Argon2id precisely _because_ the input space is tiny: a slow KDF buys nothing against 10^6 candidates, and the real control is the 5-attempt cap plus the rate limiter.

**On the two-layer attempt limiting.** The per-code cap (5 attempts) stops guessing against one live code. The per-email rate limit on `verify-code` stops the cheaper attack: request a fresh code, burn 4 attempts, repeat. Without the second layer, the first is a speed bump.

**On invalidating prior codes.** Allowing several live codes at once multiplies the guessing surface by the number outstanding, and it also produces the confusing case where an older email still works. One live code per email is both safer and less surprising.

**On log redaction.** Use a field **allowlist** for structured logs rather than a denylist of secret field names. The difference is between "we forgot to redact the new field" and "the new field was never logged in the first place". Worth doing now while the surface is four endpoints.

---

### 2.10 — Request context and transaction helper

**Package:** `apps/api`
**Depends on:** 2.8

**Scope**

A single helper that gives a handler a transaction, the acting user, and an injected `now`.

**Acceptance criteria**

- [ ] `withTx(c, async (tx, ctx) => …)` commits on resolve, rolls back on throw.
- [ ] `ctx.now` is a single ISO instant captured once per request and passed to every evaluator call in that request.
- [ ] `ctx.now` can be overridden by the `X-Test-Now` header **only** when `ALLOW_TEST_CLOCK=true`, which is false in production config.
- [ ] No handler calls `new Date()` directly — enforced by an ESLint `no-restricted-syntax` rule.

**Implementation notes**

The lint rule is the enforcement mechanism for the purity constraint. Without it, the evaluator stays pure and the handlers quietly stop being reproducible, which is the same bug one layer up. The test clock header is what makes 2.21's integration tests able to cross a deadline without waiting for one.

---

### 2.11 — Users and profile

**Package:** `apps/api`
**Depends on:** 2.9

**Endpoints:** `GET /me`, `PATCH /me` (display name, timezone), `GET /me/sessions`

**Acceptance criteria**

- [ ] `GET /me` returns the user plus a count of active towers.
- [ ] `timezone` is validated against the IANA database; an unknown zone is `400`, not a silent fallback.
- [ ] Changing timezone does not retroactively alter any `entries.local_date`.
- [ ] `GET /me/sessions` lists the caller's sessions with `created_at`, `last_seen_at`, and `user_agent`, marking the current one.
- [ ] Email changes are **not** supported in Phase 2 — the email is the login credential, so changing it needs a verify-new-address flow and therefore email delivery.

---

# Workstream 2C — Domain endpoints

---

### 2.12 — Habits and tiers

**Package:** `apps/api`
**Depends on:** 2.10, 2.3

**Endpoints**

| Method | Path                  |
| ------ | --------------------- |
| POST   | `/habits`             |
| GET    | `/habits`             |
| GET    | `/habits/:id`         |
| PATCH  | `/habits/:id`         |
| PUT    | `/habits/:id/tiers`   |
| POST   | `/habits/:id/archive` |

**Acceptance criteria**

- [ ] Tier ladder is replaced wholesale by `PUT`, not patched per-tier — a ladder is a single consistent object and partial edits invite gaps.
- [ ] Tier levels must be contiguous from 0, and thresholds strictly increasing for numeric habits.
- [ ] A habit bound into an **active** tower rejects changes to `type`, `cadence`, and to tier 0's threshold, with `code: "habit_locked_by_tower"`.
- [ ] Tiers above 0 remain editable while active — raising your own ceiling mid-run is allowed; moving the floor is not.
- [ ] `GET /habits/:id` includes current streak, the owning tower if any, and the tier ladder.
- [ ] Archiving a habit bound to an active tower is rejected.

**Implementation notes**

Locking tier 0 but not the rest is the load-bearing rule: tier 0 is what the tower checks, so letting someone lower it mid-run would let them retroactively change what counts as showing up. Everything above tier 0 is personal and safe to edit.

---

### 2.13 — Tower creation and lobby

**Package:** `apps/api`
**Depends on:** 2.12, D4

**Endpoints:** `POST /towers`, `GET /towers`, `GET /towers/:id`

**Acceptance criteria**

- [ ] Creation puts the tower in `lobby` and creates the creator's membership with their chosen habit.
- [ ] Join code is 6 Crockford base32 characters excluding `I`, `L`, `O`, `U`; generated with CSPRNG; retried on unique violation up to 5 times.
- [ ] Codes are stored and compared case-insensitively, normalised on write.
- [ ] `deadlineLocalTime`, `timezone`, `graceWindowMinutes` (0–360, default 120), and `wobbleLeadMinutes` (default 120) are validated at creation.
- [ ] `GET /towers/:id` returns different shapes for lobby and active, and is visible only to members.
- [ ] Non-members get `404`, not `403` — a `403` confirms the code is real.

---

### 2.14 — Join, leave, remove

**Package:** `apps/api`
**Depends on:** 2.13

**Endpoints:** `POST /towers/join`, `DELETE /towers/:id/memberships/:membershipId`

**Acceptance criteria**

- [ ] Join requires a code and a `habitId` the caller owns.
- [ ] Join is rejected unless tower status is `lobby`, with `code: "tower_not_joinable"`.
- [ ] Habit cadence must equal tower cadence.
- [ ] A habit already bound to another non-collapsed tower is rejected with `code: "habit_already_committed"`.
- [ ] Self-removal is permitted in lobby; removal of another member is permitted to the creator only.
- [ ] The creator cannot remove themselves while others remain — they transfer or disband.
- [ ] All of the above return `404` on an unknown code, with timing that doesn't distinguish unknown from non-joinable.

---

### 2.15 — Tower start

**Package:** `apps/api`
**Depends on:** 2.14, 2.2

**Endpoint:** `POST /towers/:id/start`

**Acceptance criteria**

- [ ] Creator only.
- [ ] Requires ≥ 2 memberships, each with a habit attached whose cadence matches.
- [ ] Transitions `lobby → active`, sets `started_at`, and **materialises period 1** via `computePeriodWindow`.
- [ ] Period 1 starts on the tower-local date of the start instant, unless the start instant is already past that day's `deadlineAt`, in which case it starts the next day.
- [ ] Idempotent: a second call on an active tower returns the existing state, not a duplicate period.
- [ ] Runs in one transaction — a tower is never active without a period row.

**Implementation notes**

The "already past today's deadline" rule prevents a tower started at 11pm with a 10pm deadline from collapsing twelve minutes later. Starting the next day costs one day of height and avoids a collapse nobody could have prevented.

Period materialisation lives here rather than in the worker because Phase 2 has no worker, and because a tower that is active with no period is an invalid state regardless of which component would have filled the gap.

---

### 2.16 — Logging entries

**Package:** `apps/api`
**Depends on:** 2.15, 2.3, D6

**Endpoints:** `POST /entries`, `GET /habits/:id/entries`

**Acceptance criteria**

- [ ] Body carries `habitId`, `localDate`, optional `tierLevel` / `value`, and `idempotencyKey`.
- [ ] `localDate` is resolved in the tower timezone for a bound habit, user timezone otherwise (D3).
- [ ] `localDate` may be the current local date, or the immediately preceding one when `now < evaluateAt` for that period — anything else is `400` with `code: "date_out_of_window"`.
- [ ] An entry written in the grace window sets `source = 'grace'`; otherwise `'live'`.
- [ ] `qualifies` is computed by 2.3, never supplied by the client.
- [ ] A unique violation on `entries_one_qualifying_day` returns `200` with the **existing** entry, not `409` — the day is already credited and the client should converge.
- [ ] A replayed `idempotencyKey` returns the original entry unchanged.
- [ ] Non-qualifying additional entries on an already-credited day are accepted and stored.
- [ ] Logging against a habit in a collapsed or hibernating tower is accepted and counts toward the rebuild.

**Implementation notes**

Catching `23505` and returning the existing row is deliberate. The client cannot reliably know whether its previous request committed, and a `409` would surface a scary error for the benign case of a double tap on a flaky connection. The partial index is the source of truth; the handler's job is to translate it into something a mobile client can act on.

---

### 2.17 — Period preview

**Package:** `apps/api`
**Depends on:** 2.4, 2.16

**Endpoint:** `GET /towers/:id/period`

**Scope**

Return the current period's live state by calling `evaluatePeriod` with `ctx.now` — read-only, no writes, no transitions persisted.

**Acceptance criteria**

- [ ] Returns `periodStatus`, each member's qualifying days against quota, the window instants, and current height and streak.
- [ ] Identifies which members are outstanding when `wobbling`.
- [ ] Performs no writes, even when the computed status is `collapsed` — persistence is 2.19's job.
- [ ] Response is computed from the same `evaluatePeriod` call the worker will make, with no duplicated rules in the handler.

**Implementation notes**

This endpoint is the payoff for extracting the evaluator. If the handler reimplements "are we wobbling" with its own query, the preview and the actual outcome will disagree at some point, and that disagreement will be visible to users as a tower that said it was fine and then fell.

---

### 2.18 — Rate limiting and abuse controls

**Package:** `apps/api`
**Depends on:** 2.8, Redis

**Acceptance criteria**

- [ ] Auth endpoints limited per 2.9.
- [ ] Join-by-code: 10 attempts per user per hour and 30 per IP per hour, returning `429` with `Retry-After`.
- [ ] Write endpoints: a global per-user ceiling well above normal use, as a backstop not a product constraint.
- [ ] Limits are enforced in Redis with a fixed-window counter keyed by scope and identity.
- [ ] Redis unavailability fails **closed** for `verify-code` and join attempts, and **open** for ordinary writes.

**Implementation notes**

A 6-character join code space is roughly a billion, which is plenty against random guessing but not against a determined enumerator over months. The per-user limit is the real control; the per-IP limit catches the unauthenticated-ish case.

Failing closed on `verify-code` matters because the rate limiter is load-bearing for auth, not just hygiene: a 6-digit code is 10^6 candidates, and an unthrottled verify endpoint with Redis down is brute-forceable in minutes. The per-code 5-attempt cap in 2.9 lives in Postgres and still holds, but the cheap attack — request a fresh code, burn 4 attempts, repeat — is bounded only by the Redis counter. Ordinary writes still fail open, because a user who can't log their habit loses their streak, while a user who can't sign in retries in a minute.

---

### 2.19 — Internal evaluation trigger

**Package:** `apps/api`
**Depends on:** 2.4 … 2.6, 2.15

**Endpoint:** `POST /internal/towers/:towerId/periods/:periodId/evaluate`

**Scope**

The manual stand-in for the Phase 3 tick. Claims the period, runs the evaluator, persists everything the outcome implies.

**Acceptance criteria**

- [ ] Guarded by `INTERNAL_API_TOKEN`, and refuses to mount when that variable is unset.
- [ ] Claims the period with `SELECT … FOR UPDATE SKIP LOCKED` — the same claim shape Phase 3 will use.
- [ ] Rejects a period whose status is already terminal, with `code: "period_already_evaluated"`.
- [ ] On `survived`: writes `period_results`, increments streak and height, materialises the next period, awards any crossed milestones.
- [ ] On `collapsed`: writes `period_results`, writes the base block and its roster, resets streak, preserves height, applies membership transitions, materialises the next period.
- [ ] All of the above in one transaction.
- [ ] Re-running after a successful evaluation is a no-op returning the persisted outcome.
- [ ] Milestone awards are idempotent on `(tower_id, milestone_key)`.

**Implementation notes**

Write the claim query with `SKIP LOCKED` now even though a single manual caller can't contend. Phase 3 swaps the caller for a tick loop, and if the locking shape only appears then, the first concurrency bug shows up in the component that's hardest to test.

Keep the persistence logic in a service function that takes `(tx, towerId, periodId, now)`. Phase 3 should import that function, not re-derive it from the HTTP handler.

---

# Workstream 2D — Verification

---

### 2.20 — Integration test harness

**Package:** `apps/api`
**Depends on:** 2.8, 2.10

**Acceptance criteria**

- [ ] Tests run against a real Postgres from Compose, not a mock or an in-memory substitute.
- [ ] Migrations run once per suite; tables are truncated between tests with a single `TRUNCATE … RESTART IDENTITY CASCADE`.
- [ ] A fixture builder creates users, habits, towers, and memberships in one call per scenario.
- [ ] Test users are created by direct insert plus a minted session row, not by walking the OTP flow — the handful of tests that exercise auth itself read the code from the test mail sink.
- [ ] The `sendLoginCode` interface is bound to an in-memory sink in tests, so a test can assert a code was sent and read it without parsing logs.
- [ ] `X-Test-Now` is wired so a test can cross `wobbleAt`, `deadlineAt`, and `evaluateAt` without sleeping.
- [ ] Suite is runnable with one command and in CI.

**Commands**

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres redis
pnpm --filter @tower-of-habit/db migrate:test
pnpm --filter @tower-of-habit/api test:integration
```

---

### 2.21 — End-to-end scenario test

**Package:** `apps/api`
**Depends on:** every ticket above

**Scope**

One test that walks the Phase 2 definition of done start to finish.

**Acceptance criteria**

- [ ] Two users authenticate via the OTP flow, create habits, form a tower, and start it.
- [ ] Both log on day 1 → evaluation returns `survived`, height 1, streak 1, next period exists.
- [ ] Both log days 2 and 3.
- [ ] User B misses day 4 → clock advanced past `wobbleAt`, preview returns `wobbling` naming B; clock advanced past `evaluateAt`, evaluation returns `collapsed`.
- [ ] Base block exists with `heightDays = 3`, both members on the roster with correct contributions, and no field identifying B.
- [ ] B's membership is `at_risk`; height preserved at 3; streak reset to 0.
- [ ] B misses day 5 → evaluation transitions B to `dormant_auto` and does **not** collapse again.
- [ ] A continues alone; the tower survives with one active member.
- [ ] B logs on day 7 → returns to `active` with `consecutive_misses = 0`.

---

## Dependency graph

```
2.1 ─┬─ 2.2 ─┬─ 2.4 ─┬─ 2.5 ─┐
     │       │       ├─ 2.6 ─┤
     └─ 2.3 ─┘       │       ├─ 2.7
                     │       │
2.8 ─┬─ 2.9 ─ 2.11   │       │
     ├─ 2.10 ─┬─ 2.12 ─ 2.13 ─ 2.14 ─ 2.15 ─┬─ 2.16 ─┬─ 2.17
     └─ 2.18  │                              │        └─ 2.19
              └──────────────────────────────┴─ 2.20 ─ 2.21
```

Parallelisable: 2A (2.1 → 2.7) and 2B (2.8 → 2.11) have no dependency on each other and can run concurrently. 2C needs both.

## Explicitly out of scope

| Item                                                              | Phase     |
| ----------------------------------------------------------------- | --------- |
| Scheduler tick loop, Graphile Worker, healthchecks.io             | 3         |
| Push notification delivery (nudge, wobble, collapse)              | 3         |
| Real email delivery for login codes (gates any non-test user)     | 3 — early |
| Change-of-email flow (needs verify-new-address)                   | 3         |
| Voluntary dormancy endpoints                                      | 3         |
| OAuth / Apple & Google sign-in (store submission may force Apple) | post-MVP  |
| Expo client                                                       | 4         |
| Weekly towers, slack-based wobble, partial first period           | v2        |
| Friend system, in-app invites                                     | post-MVP  |
