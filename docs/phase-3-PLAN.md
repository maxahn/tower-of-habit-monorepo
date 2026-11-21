# Tower of Habit — Build Plan

Milestone-level plan for the whole build. Each milestone has a goal, its tasks, acceptance criteria, and an exit gate that has to be demonstrable rather than argued.

Detailed tickets live in their own files: `tower-phase1-tickets.md`, `phase-2-tickets.md`, `phase-3-tickets.md`. This file is the index and the gate list — if a ticket and this file disagree, the ticket is newer.

**What's being built:** a mobile group-accountability habit tracker. Small groups commit to their own individual habits; a shared tower rises while everyone shows up and collapses when someone doesn't. Collapse is expected — the fallen tower becomes a foundation for the next one.

**Why:** a portfolio project demonstrating ownership across client, backend and infrastructure, and a novel social mechanic worth talking about in an interview.

---

## Status

| Milestone | Scope                            | State          |
| --------- | -------------------------------- | -------------- |
| **M0**    | Infrastructure and tooling       | ✅ complete    |
| **M1**    | Data model                       | ✅ complete    |
| **M2**    | Evaluator and API                | ✅ complete    |
| **M3**    | Worker, notifications, lifecycle | ✅ complete    |
| **M4**    | Client foundation                | ⬜ not specced |
| **M5**    | Client screens                   | ⬜ not specced |
| **M6**    | Hardening and submission         | ⬜ not specced |

**C1–C6 resolved.** All six inconsistencies between Phase 1 and Phase 2 were resolved during implementation. See `phase-3-tickets.md` for details. M1 and M2 are complete; M3 has significant DB-layer and evaluator work already landed from Phase 2 (claim queries, evaluation transaction steps 1–9, dormancy state machine, base block writes, hibernation outcome).

---

## Phase numbering

Phase 1's forward references assume a slightly different phase layout than the one that emerged (it points at "2.6 deadline picker" and "2.12 tower home screen", which are client tickets, and at 5.x for mobile). The reconciliation used here:

| Milestone | Ticket prefix | Owns                                                   |
| --------- | ------------- | ------------------------------------------------------ |
| M0        | `0.x`         | VM, Compose, Caddy, CI, monorepo tooling               |
| M1        | `1.x`         | Schema, migrations, factories, recompute oracle        |
| M2        | `2.x`         | Pure evaluator, Hono API                               |
| M3        | `3.x`         | Worker, scheduler, notifications, lifecycle completion |
| M4        | `4.x`         | Expo shell, auth, navigation, data layer               |
| M5        | `5.x`         | Screens, tower animation, logging UX                   |
| M6        | `6.x`         | Account deletion, store assets, submission             |

Phase 1's references to `2.6` and `2.12` as client tickets are **stale** and should be read as M5. Its references to `5.6`, `5.8`, `5.15` and `6.5` are correct under this mapping.

---

## M0 — Infrastructure · ✅ complete

**Goal:** a VM that can host the thing, and a monorepo that can build it.

Delivered: Vultr VPS hardened (SSH password auth disabled, port 22 retained), Docker Compose with Caddy + API + worker containers, pnpm workspace layout, ESLint flat config, Prettier via pre-commit, Husky + lint-staged, `.nvmrc` pinned to the Dockerfile's Node version, split `.gitignore`, CI running migrations against an empty database.

**Exit gate (met):** a trivial migration applies cleanly against an empty database in CI, and the stack comes up with `docker compose up -d`.

---

## M1 — Data model · ✅ complete

**Goal:** a schema where the period/quota shape is locked in correctly, so weekly towers stay a configuration change rather than a rewrite.

**Tasks (all done):** `1.1` ORM · `1.2` users · `1.3` habits · `1.4` tiers · `1.5` towers · `1.6` memberships · `1.7` entries · `1.8` tower_periods · `1.9` base_blocks · `1.10` notifications · `1.11` factories · `1.12` recompute oracle · `1.13` auth tables (OTP)

Addendum 1.14 (`tower_milestones`) deferred to V1.1.

**Delivered:** 12 tables, 12 enums, 14 foreign keys. Schema auto-documented via `pnpm db:erd` (generates `docs/schema-erd.html` and the README ERD). 532 db package tests passing. `recompute()` oracle verifies stored height/streak against the period ledger.

**Exit gate (met):** migrations apply cleanly from empty; factories express a mid-run tower with a missed period in one line; `recompute()` agrees with every stored value.

---

## M2 — Evaluator and API · ✅ complete

**Goal:** the whole mechanic working over HTTP, with evaluation triggered by hand. M3 replaces the caller, not the logic.

**Tasks (all done):**

- _2A evaluator_ — `2.1` types · `2.2` period window · `2.3` qualification · `2.4` evaluation · `2.5` dormancy machine · `2.6` base block draft · `2.7` evaluator suite
- _2B API foundation_ — `2.8` Hono skeleton · `2.9` OTP auth · `2.10` tx helper + injected clock · `2.11` profile
- _2C domain_ — `2.12` habits · `2.13` towers + lobby · `2.14` join/leave · `2.15` start · `2.16` entries · `2.17` period preview · `2.18` rate limiting · `2.19` internal evaluate
- _2D verification_ — `2.20` harness · `2.21` end-to-end scenario

C1–C6 corrections were applied during implementation: `localDate` derived server-side (2.16), `nudge_lead_minutes` read from column (2.2), no `period_results` table (2.19).

**Delivered:** Pure evaluator in `packages/shared` (1603 tests, 99.2% statement coverage). Hono API with OTP auth, full tower lifecycle. `evaluateTowerPeriod(tx, towerId, periodId, now, logger?)` in `apps/api/src/evaluation/service.ts` — importable by Phase 3 worker. 170 API tests including E2E scenario covering survive → wobble → collapse → base block → dormancy → solo continuation → reactivation.

**Exit gate (met):** two accounts form a tower, start it, log, survive, collapse with a base block, second member goes dormant on consecutive miss — all through HTTP, no worker running (2.21 E2E test).

---

## M3 — Worker, notifications, lifecycle · ✅ complete

**Goal:** remove the manual trigger. The app runs unattended and people are told before they lose a streak, not after.

**Already built (from Phase 2):**

- `evaluateTowerPeriod` steps 1–9: claim, lock, evaluate, persist, height/streak, base block, membership transitions, next period
- DB claim layer: `claimDuePeriods`, `lockPeriodForEvaluation`, `lockTower`
- Dormancy state machine: `stepMembership()` + `applyMemberships` handling at_risk, consecutive_miss, backstop, voluntary return expiry
- Hibernation outcome: `hibernated` written, streak preserved, next period materialised
- Base block writes: `buildBaseBlockDraft` + `appendBaseBlock`, MIN_BLOCK_DAYS = 3
- Recompute oracle: `verifyTower` / `repairTower` proven in 2.21 E2E test
- Notification infrastructure: `ensureNotification` (idempotent, dedupe_key unique), `listDueNotifications`, `transitionNotification`, 10 notification types

**Remaining tasks:**

- _3A runtime_ — `3.1` scaffold (BullMQ→Graphile, enum migration) · `3.2` tick loop · `3.3` materialisation sweep · `3.4` claim (wire existing DB fns) · `3.5` eval tx (add step 10: notification enqueueing)
- _3B notifications_ — `3.6` nudge · `3.7` wobble · `3.8` collapse
- _3C lifecycle_ — `3.10` dormancy (backstop sweep for non-evaluating towers) · `3.11` hibernation (add notification) · `3.12` voluntary dormancy (new endpoints)
- _3D delivery_ — `3.13` Graphile Worker + push **L ⭐** · `3.14` email **← ship first**
- _3E ops_ — `3.17` dead-man's-switch + metrics · `3.18` runbook
- _3F verification_ — `3.15` worker suite **L** · `3.16` time-travel **L ⭐**

3.9 (base block write) is absorbed into 3.5 — already implemented.

**Acceptance criteria**

- [ ] A tower left alone evaluates correctly for 7 consecutive days with no intervention
- [ ] Nudge precedes wobble precedes collapse, with the nudge private
- [ ] No notification of any kind for a surviving period
- [ ] Worker survives `SIGKILL` mid-evaluation: no double credit, no double notification, no lost period
- [ ] 72 hours of downtime catches up correctly with no stale wobbles
- [ ] A silent member costs the group exactly one collapse, then goes dormant
- [ ] A declared absence costs the group nothing
- [ ] `verifyTower(db, towerId).ok` at every step of 3.16
- [ ] `sum(block_height) + current_streak ≤ towers.height`, gap attributable to sub-minimum runs
- [ ] Stopping the worker alerts within 3× the tick interval; a throwing tick does not ping healthy
- [ ] `oldest_pending_period_age` observable, alerting above 15 minutes
- [ ] An invalidated push token is never sent to twice
- [ ] A login code reaches a real inbox in under 10 seconds, not in spam

**Exit gate:** start a tower, close the laptop for a week, and the mechanic works — nudges, wobbles, a collapse with a base block, a dormancy, and a hibernation, each notified exactly once.

**Estimate:** 10–14 days (down from 14–18; claim, eval steps 1–9, dormancy, hibernation, base blocks already landed). 3.14 ships first: until email works you are the only person who can log in, so no second account and no real tower.

---

## M4 — Client foundation · ⬜ not specced

**Goal:** an Expo app that authenticates, navigates, and talks to the API — no tower UI yet.

**Tasks (provisional)**

- `4.1` Expo + expo-router + NativeWind v4 / Tailwind 3 wiring
- `4.2` React Native Reusables components copied in and themed
- `4.3` TanStack Query client, typed against `packages/shared` zod schemas
- `4.4` OTP login and verify screens, token in `expo-secure-store`
- `4.5` session restore, refresh and sign-out; 401 → re-auth without losing navigation state
- `4.6` push token registration, permission prompt, token POST to the API
- `4.7` ESLint `no-restricted-imports` barrier enforcing no server code in `apps/mobile`
- `4.8` change-of-email flow (unblocked by 3.14)
- `4.9` EAS build profiles for dev, preview and production

**Acceptance criteria**

- [ ] `packages/shared` types import into the client with no database driver pulled in
- [ ] Login survives an app restart and a cold boot
- [ ] A 401 mid-session returns the user to login without a crash or a stuck spinner
- [ ] Push permission denial is handled: the app works, notifications are off, and the state is visible in settings
- [ ] The import barrier fails CI when server-only code is imported into the client
- [ ] An internal preview build installs on a physical device

**Exit gate:** a real device logs in with an emailed code, registers a push token, receives a test push, and survives a cold restart still signed in.

**Estimate:** 8–12 days.

---

## M5 — Client screens · ⬜ not specced

**Goal:** the product. This is the milestone where the mechanic becomes something people feel rather than something an endpoint reports.

**Tasks (provisional)**

- `5.1` habit creation, including the tier ladder editor
- `5.2` tower creation with `5.6`'s deadline picker, timezone, and grace window
- `5.3` lobby: code sharing, member list, remove, start
- `5.4` join by code
- `5.5` logging: binary, numeric, tier picker; optimistic write with the 2.16 convergence rule
- `5.6` deadline picker defaulting to 22:00, with the odd-local-hour warning for distant members
- `5.7` tower home: height, streak, member status row, wobble state
- `5.8` countdown anchored to `deadline_at` and nothing else
- `5.9` tower animation behind a boundary — Reanimated first, Skia deferred
- `5.10` base block history: the strata view, tap a layer for that run's roster
- `5.11` standalone habit view with its own streak — the solo mode and the day-one retention story
- `5.12` dormancy and absence UI: at-risk state, declare an absence, greyed-out member with return date
- `5.13` "you're holding this up alone" state
- `5.14` empty states and first-run onboarding
- `5.15` offline and flaky-connection handling, retry with the idempotency key

**Acceptance criteria**

- [ ] Only `deadline_at` is ever displayed; `evaluate_at` appears nowhere in the UI
- [ ] A double-tapped log produces one credit and no error toast
- [ ] A log made with no connection is retried and converges, never duplicated
- [ ] Height and streak are shown as two distinct numbers, never summed
- [ ] The strata view is legible to someone who joined for the fifth attempt
- [ ] No screen anywhere shows who caused a collapse
- [ ] A member in a distant timezone sees their own local deadline time alongside the tower's
- [ ] The animation runs at 60fps on a mid-range Android device, and the Skia boundary is swappable

**Exit gate:** three people on three physical devices run a real tower for a week, including a deliberate collapse, without anyone needing to be told how it works.

**Estimate:** 15–20 days.

---

## M6 — Hardening and submission · ⬜ not specced

**Goal:** something that can be handed to strangers and linked from a CV.

**Tasks (provisional)**

- `6.1` Sentry or equivalent on client and server
- `6.2` backup and restore for Postgres, with a restore actually tested
- `6.3` rate-limit and abuse review against real usage
- `6.4` privacy policy and terms; data export
- `6.5` account deletion — hard-delete the user, overwrite `display_name` to "Former member" in every base block roster in the same transaction, keeping contribution counts (flagged in 1.2)
- `6.6` Apple sign-in, if store review requires it alongside email
- `6.7` store assets, screenshots, description
- `6.8` TestFlight and internal Play track
- `6.9` load sanity check: 100 towers × 5 members evaluating in one tick
- `6.10` README and architecture write-up — the portfolio artifact

**Acceptance criteria**

- [ ] A database restore has been performed from backup into a scratch environment and verified
- [ ] Account deletion leaves no user row, and leaves every base block roster legible
- [ ] 100 towers evaluate in one tick inside the tick interval, with headroom
- [ ] Both stores accept the build
- [ ] The architecture write-up explains the evaluator purity constraint and why `evaluate_at` exists

**Exit gate:** a stranger installs from TestFlight, forms a tower with a friend, and runs it for a week without contacting you.

**Estimate:** 10–14 days.

---

## Critical path

```
M0 ✅ → M1 ✅ → M2 ✅ → M3 → M4 → M5 → M6
```

Little parallelises across milestones, because each depends on the last being correct rather than merely present. Inside milestones there is real parallelism: M1's 1.2–1.4 are independent, M2's 2A and 2B are fully independent, M3's 3.14 can land before anything else in that phase.

**Total: roughly 67–91 working days** of focused work, M1 through M6.

The one re-ordering worth considering: **M4.1–4.6 could start during M3**, since the client foundation only needs the API from M2, not the worker. If motivation flags during M3 — which is the least visible phase, all of it backend — pulling the Expo shell forward gives you something to look at.

---

## Risk register

| Risk                                         | Where it bites      | Mitigation                                                                                   |
| -------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| Period/quota shape wrong                     | M1 `1.5`, `1.8`     | Store `period_length`/`quota` even though v1 hard-codes 1/1; weekly stays config             |
| `local_date` derivation bugs                 | M1 `1.7`            | Pure function, table-driven DST tests, both grace branches covered                           |
| Evaluator and preview diverge                | M2 `2.17`           | One `evaluatePeriod`, two callers, no rules duplicated in handlers                           |
| Scheduler silently stops                     | M3 `3.17`           | healthchecks.io on successful ticks + `oldest_pending_period_age` alert                      |
| Notification sent for an uncommitted outcome | M3 `3.5`            | Transactional outbox: `addJob` inside the evaluation transaction                             |
| Duplicate pushes on retry                    | M3 `3.13`           | `notifications.dedupe_key` unique, insert-first-then-send                                    |
| Login codes land in spam                     | M3 `3.14`           | Dedicated sending subdomain, SPF/DKIM, plain-text-first, bounce webhook                      |
| Push pipeline rots silently                  | M3 `3.13`           | Receipt checking, `DeviceNotRegistered` → invalidate token                                   |
| Stored height drifts from reality            | all                 | `recompute()` asserted after every evaluation in every test                                  |
| Blame leaks into the product                 | M3 `3.9`, M5 `5.10` | No `caused_collapse` column exists, so no feature can surface it                             |
| Scope creep into v2                          | all                 | Weekly, milestones, friends, high fives are all explicitly out of scope and listed per phase |

---

## Invariants that hold everywhere

Worth re-reading before any phase. Each one is cheap to preserve and expensive to retrofit.

1. **The evaluator is pure.** State in, decisions out. The evaluation instant is always a parameter; `new Date()` is lint-banned in `apps/api` and `apps/worker`.
2. **`deadline_at` is the only instant a member ever sees.** `evaluate_at` is internal, and exists so an outcome is decided exactly once.
3. **Height and streak are two numbers, never one.** Height is cumulative and never decreases; streak resets on collapse.
4. **One credit per day**, enforced by a partial unique index, not by application logic.
5. **Nothing records who caused a collapse.** The column does not exist, which is the only durable way to guarantee it.
6. **A missed tick causes delay, not data loss.** The claim query finds all due periods, not the current one.
7. **Daily is the degenerate case of period-and-quota**, not a special path.
