# Phase 3 — Worker, Notifications and Lifecycle: Ticket Breakdown

Sizes as in Phase 1: **S** ≈ half a day, **M** ≈ 1 day, **L** ≈ 2+ days.

Phase 2 built an evaluator that can decide a period and an endpoint that can be poked to make it happen. Phase 3 removes the poke. After this phase the app runs unattended: periods evaluate themselves, people get told before they lose a streak rather than after, and a member who disappears stops taking the group down with them.

**Ticket numbers 3.4–3.9, 3.15 and 3.16 are fixed** — Phase 1 forward-references them by number (1.8 → 3.4, 1.10 → 3.5, 1.5 → 3.6/3.7, 1.9 → 3.9, 1.11 → 3.15/3.16). They keep those meanings here.

The tickets carrying the phase's risk are **3.5**, **3.13** and **3.16**.

---

## Blocking inconsistencies (C1–C6) — ✅ all resolved

Six inconsistencies between Phase 1 and Phase 2 were identified when writing Phase 3. All six were resolved during Phase 1 and 2 implementation:

| #   | Issue                                           | Resolution                                                                                             |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| C1  | `users.password_hash` exists, no auth tables    | `password_hash` gone; `auth_codes` + `sessions` exist; OTP works end-to-end (1.13, 2.9)                |
| C2  | 2.19 assumed `period_results` table             | No such table; per-member data computed at eval time, stored in `base_blocks.roster`                   |
| C3  | 2.5 assumed `membership_events` table           | Transitions applied as column updates on `memberships`; returned in `EvaluationResponse.transitions`   |
| C4  | Assumed `tower_milestones` table                | Deferred to V1.1 as recommended                                                                        |
| C5  | 2.2 derived nudgeAt from wobble×2               | `towers.nudge_lead_minutes` exists (default 240) with CHECK `> wobble_lead_minutes`                    |
| C6  | Client-supplied `localDate`; no dormancy waking | `localDate` derived server-side (2.16); dormancy waking on qualifying log implemented in entry handler |

Addendum 1.13 (auth tables) is complete. Addendum 1.14 (`tower_milestones`) remains deferred to V1.1.

---

## Phase 3 preconditions — ✅ all met

- ✅ Phase 1 landed, including addendum 1.13 (auth tables).
- ✅ Phase 2 landed, with C2, C5 and C6 applied.
- ✅ `apps/worker` exists as a workspace package with a Compose service (skeleton with BullMQ/ioredis — to be replaced by Graphile Worker in 3.1).
- ✅ `evaluateTowerPeriod(tx, towerId, periodId, now, logger?)` exists as an importable service function in `apps/api/src/evaluation/service.ts` (2.19). Steps 1–9 are fully implemented; Phase 3 adds step 10 (notification enqueueing).

## Phase 3 definition of done

Start a tower, close the laptop, and the mechanic works: members get a private nudge, then a group wobble, then either a survived period or a collapse with a base block — all without anyone calling an endpoint. A member who goes quiet costs the group exactly one collapse and then goes dormant. A member who declares an absence costs the group nothing. The worker can be killed mid-evaluation and restarted without double-crediting, double-notifying, or losing a period.

---

## New decisions

| #   | Decision                    | Recommendation                                                                                                           | Affects  |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- |
| D7  | Tick mechanism and interval | `setTimeout` chain (not `setInterval`), 30s, with a re-entrancy guard. See 3.2.                                          | 3.2      |
| D8  | Notification scheduling     | Graphile Worker jobs with `run_at`, enqueued when the period is created, plus a tick sweep as backstop.                  | 3.6, 3.7 |
| D9  | Email provider              | Resend. Postmark is the upgrade if deliverability bites.                                                                 | 3.14     |
| D10 | Push transport              | Expo Push Service, not direct APNs/FCM.                                                                                  | 3.13     |
| D11 | Claim and transaction shape | One transaction per period, locking the period row **and** the tower row. Never persist the `evaluating` state. See 3.4. | 3.4, 3.5 |
| D12 | Voluntary dormancy caps     | 14 days per declaration, 28 days per rolling 365, one active declaration at a time.                                      | 3.12     |

---

# Workstream 3A — Worker runtime

---

## 3.1 — Worker process scaffold · **S** · depends: 0.x, 1.1

`apps/worker` already exists as a workspace package with a BullMQ/ioredis skeleton and a test queue. This ticket replaces that skeleton with the production foundation.

**BullMQ → Graphile Worker.** Remove `bullmq` and `ioredis` deps; add `graphile-worker`. Graphile Worker stores jobs in Postgres, so `addJob` can join the evaluation transaction (transactional outbox). This is load-bearing for 3.5 step 10: a committed collapse always has its notification queued, and a rolled-back eval queues nothing. Keep the Redis connection for rate limiting (already used by the API).

**Notification type enum migration.** Phase 3 needs two new notification types not yet in the `notification_type` enum:

- `hibernate` — group notification when a tower enters hibernation (3.11)
- `at_risk` — private push to a member newly flagged at-risk (3.8)

Add a migration: `ALTER TYPE notification_type ADD VALUE 'hibernate'; ALTER TYPE notification_type ADD VALUE 'at_risk';`. Update `NOTIFICATION_TYPES` in `packages/shared/src/notifications/dedupe-key.ts` and add `buildDedupeKey` patterns for both.

**Remaining scaffold work:**

- Config parsed and validated with zod **at boot**, failing fast with the offending key named. A worker that starts with a missing `DATABASE_URL` and discovers it on the first tick is a worker that looks healthy and does nothing.
- A minimal HTTP listener exposing `/healthz` only, so Compose has something to probe. No domain endpoints — the worker is not a second API.
- Graceful shutdown on `SIGTERM`: stop scheduling ticks → await the in-flight tick → drain Graphile Worker → close the pool → exit 0. Hard timeout of 20s, then `process.exit(1)`.
- `deploy: replicas: 1` in Compose. The claim logic in 3.4 makes more than one safe, but there is no reason to run two on a single VM and the second one makes every log harder to read.

**Done when:** the container starts, logs its resolved config with secrets redacted, answers `/healthz`, and exits cleanly on `docker compose stop` without a 10-second SIGKILL wait; `hibernate` and `at_risk` are valid notification types.

---

## 3.2 — Tick loop and injected clock · **M** · depends: 3.1 · D7

```ts
export async function runTick(now: Date, deps: TickDeps): Promise<TickReport>;
```

The loop is a thin wrapper; `runTick` is the unit under test and takes `now` as a parameter like everything else in this codebase.

**Use a `setTimeout` chain, not `setInterval`.** `setInterval` keeps firing while a slow tick is still running, so a tick that takes 45 seconds on a 30-second interval starts overlapping itself and the overlap compounds. A chain that schedules the next tick only after the current one settles cannot drift into itself.

- Re-entrancy guard: a single in-flight promise, asserted in tests by invoking the loop twice.
- Every tick wrapped so a thrown error is logged and the loop continues. One bad tower must not stop the scheduler — that is the failure mode that silently collapses every tower in the system.
- `TICK_ENABLED=false` disables automatic ticking so integration tests can drive `runTick` directly (3.16).
- One `now` per tick, passed to every call below it. The ESLint `no-restricted-syntax` rule from 2.10 extends to `apps/worker`.
- `TickReport` returns counts (periods claimed, evaluated, skipped, errored, duration) for 3.17 to log.

**On not using Graphile Worker's cron for evaluation.** Graphile has a crontab and it would work. The explicit tick is worth keeping anyway: Phase 1 designed the claim query specifically so a missed tick causes _delay rather than data loss_ (1.8), and that property is only obvious and testable if the catch-up query lives in our code where `runTick(now)` can be called with any `now`. Notification _delivery_ still goes through Graphile (3.13), where retry and backoff are exactly what it's for.

**Done when:** `runTick` is callable directly with an arbitrary `now`; a deliberately slow tick does not overlap; a thrown error inside one period's evaluation leaves the loop running and the other periods evaluated.

---

## 3.3 — Period materialisation sweep · **M** · depends: 3.2, 1.8

Periods are created in two places, and this is deliberate:

1. **At evaluation** (3.5) — the normal path. Evaluating period _N_ creates period _N+1_.
2. **By this sweep** — the repair path, for towers that are `active` with no `pending` period.

The sweep finds active towers whose latest period is already evaluated and whose successor is missing, and creates it. Idempotent via `unique (tower_id, period_start)`: catch `23505` and move on rather than checking first, because the check-then-insert is the race.

**The chain catches itself up, and that is the design.** If the worker is down for three days, period 2 was never created, so days 2 and 3 have no period rows. On restart, period 1 is due → evaluates → creates period 2 → period 2 is immediately due → evaluates → creates period 3, and so on until the chain reaches the present. Each evaluation reads the entries whose `local_date` falls in its own window, so a member who logged on days 2 and 3 is correctly credited even though nothing evaluated at the time.

What must **not** happen during that catch-up is a three-day-old wobble notification arriving. That is the staleness guard in 3.6–3.8.

- Horizon of one period ahead, so 3.6's nudge job has a period row to attach to.
- The sweep must never create a period whose `period_start` precedes the tower's `started_at`.

**Done when:** deleting the pending period of an active tower causes the next tick to recreate it with identical `deadline_at` and `evaluate_at`; a worker stopped for 72 hours catches up on restart with correct per-period outcomes and no notifications for closed periods.

---

## 3.4 — Period claim · **S** · depends: 3.3, 1.8 · D11 · ⭐

The DB layer for claiming is already implemented in `packages/db`:

- **`claimDuePeriods(db, now, limit?, leaseMinutes?)`** — batch claim with `FOR UPDATE SKIP LOCKED`, passing the tick's injected `now` (not `now()`).
- **`lockPeriodForEvaluation(db, periodId, towerId)`** — single-period lock acquiring both the period and tower row locks (period then tower, always in that order to prevent deadlocks).
- **`lockTower(db, towerId)`** — tower row lock for height/streak read-modify-write safety.

**What remains:** wire these functions into the tick loop from 3.2. The tick calls `claimDuePeriods` to get the batch, then opens one transaction per period (not one per batch — a batch-wide transaction means one tower's bug rolls back every other tower's evaluation).

The `state = 'evaluating'` is never persisted. The whole evaluation happens inside the transaction that holds the row lock, so a crashed worker rolls back to `pending` automatically. `claimed_at` is written in the same transaction as the outcome, purely as an audit of when the period was processed.

**Done when:** two workers against the same database claim disjoint sets, proven under real concurrency; killing the worker with `SIGKILL` mid-evaluation leaves the period `pending` and the next tick evaluates it exactly once; a tower with two due periods evaluates them in order without a lost height update.

---

## 3.5 — Evaluation transaction and idempotency · **M** · depends: 3.4, 2.4, 2.19 · ⭐

**Steps 1–9 are fully implemented** in `evaluateTowerPeriod(tx, towerId, periodId, now, logger?)` at `apps/api/src/evaluation/service.ts`. The function is importable and callable outside HTTP — its doc comment says "Phase 3 should import evaluateTowerPeriod, not re-derive it from the HTTP handler."

Inside one transaction, for one period:

1. ✅ Lock period, then tower (3.4).
2. ✅ If `state = 'evaluated'`, return the stored outcome. No writes, no jobs, no notifications.
3. ✅ Gather member state via `loadEvaluationInput`.
4. ✅ Call `evaluatePeriod` from `packages/shared` with the tick's `now`.
5. ✅ Persist: `state = 'evaluated'`, `outcome`, `evaluated_at`, `claimed_at`.
6. ✅ Update `towers.height` and `towers.current_streak`.
7. ✅ Write the base block if the outcome calls for one (via `buildBaseBlockDraft` + `appendBaseBlock`; runs shorter than 3 days write no row).
8. ✅ Apply membership transitions (at_risk, dormant/consecutive_miss, recovered, backstop, voluntary return expiry).
9. ✅ Create the next period.
10. ❌ **Enqueue notification jobs in this transaction** (3.13) — **this is the remaining work.**

Step 10 is the part worth getting right. Graphile Worker stores jobs in Postgres, and `addJob` accepts an existing client, so job insertion joins the evaluation transaction. That gives a transactional outbox for free: **a committed collapse always has its notification queued, and a rolled-back evaluation queues nothing.** Enqueueing outside the transaction produces exactly the two failures you cannot explain to a user — a collapse nobody was told about, or a collapse notification for a collapse that didn't happen.

The jobs to enqueue depend on the outcome:

- `survived` → nothing (no notification for a surviving period)
- `collapsed` → group collapse notification + private `at_risk` push per newly at-risk member
- `hibernated` → one group hibernation notification (only on entering hibernation, not on subsequent hibernated periods)

**Idempotency is structural, not best-effort.** Step 2 short-circuits on re-run; the base block's `unique (tower_id, ordinal)` and the notification `dedupe_key` absorb anything that slips past it.

**The recompute oracle (1.12) is the acceptance test.** After every evaluation in every test, assert `verifyTower(db, towerId).ok === true`. The oracle (`recomputeTowerState` in shared, `verifyTower` / `repairTower` in `packages/db/src/towers/recompute.ts`) is already used in the 2.21 E2E integration test.

**Done when:** evaluating the same period twice produces one outcome, one base block, one set of notifications; a forced rollback after step 9 leaves no queued jobs; `verifyTower(db, towerId).ok` holds across every scenario in the suite.

---

# Workstream 3B — Notifications

All three dispatches share a shape: a Graphile job scheduled for a known instant, which re-reads state at run time and decides whether the notification is still warranted. **The decision to send is made at send time, never at schedule time.** A nudge scheduled four hours before a deadline must not fire for someone who logged three hours ago.

---

## 3.6 — Nudge dispatch · **M** · depends: 3.5, 1.10 · D8

Private, per-member, at `deadline_at − nudge_lead_minutes` (the real column — see C5).

- One job per period, `jobKey = nudge:{period_id}`, `run_at = nudgeAt`, enqueued when the period is created.
- At run time: load the period, confirm it is still `pending`, and compute who is short of quota. Send only to those members. Skip dormant members and members with a voluntary absence covering the period.
- `dedupe_key = nudge:{period_id}:{user_id}` on the `notifications` row.
- **Staleness guard:** if `now > deadline_at`, do nothing and record the notification as `skipped`. A nudge after the deadline is at best noise and at worst cruel.
- Floor `nudgeAt` at the period's local 00:00 — a large `nudge_lead_minutes` can otherwise push it into the previous day.

**Copy:** addressed to one person, no group framing. _"Your habit isn't logged yet — the tower's deadline is at 10pm."_ Nobody else sees this, which is the entire point: most misses are ordinary forgetting, and the first thing the group hears about a miss should not be an announcement.

**Done when:** a member who logs before `nudgeAt` receives nothing; a member who hasn't receives exactly one nudge; a nudge job that runs after its deadline sends nothing; the dedupe key prevents a second send when the job is retried.

---

## 3.7 — Wobble dispatch · **M** · depends: 3.6 · D8

Broadcast, at `deadline_at − wobble_lead_minutes`, naming who is outstanding.

- One job per period, `jobKey = wobble:{period_id}`, `run_at = wobbleAt`.
- At run time, recompute the outstanding set. **If it is empty, send nothing at all** — not a "tower is safe" message. A notification whose content is "nothing is wrong" trains people to ignore notifications.
- Goes to **every** member including the outstanding ones. The spec is explicit that the broadcast names names; excluding the person named would make the group conversation happen behind their back.
- `dedupe_key = wobble:{period_id}:{user_id}`.
- Staleness guard as in 3.6.
- Name formatting: one name, _"Jordan and Sam"_ for two, _"Jordan, Sam and 2 others"_ beyond three. Display names come from `users.display_name` at send time.

This is the app's growth loop as much as its safety net — it is the moment one member texts another outside the app. Worth making the copy good: _"The tower is wobbling. 2 hours left and Jordan hasn't logged."_

**Done when:** a period where everyone has logged produces no wobble; a period with two outstanding members produces one broadcast naming both, delivered to all members; retrying the job sends nothing further.

---

## 3.8 — Collapse dispatch · **M** · depends: 3.5 · D8

Enqueued inside the evaluation transaction (3.5 step 10) rather than scheduled ahead, because collapse is an outcome, not an instant.

- Group notification to all members, `dedupe_key = collapse:{period_id}:{user_id}`.
- A separate **private** notification to each member newly flagged `at_risk`, `dedupe_key = at_risk:{membership_id}:{period_id}`. The spec wants at-risk visible to the group and explained privately to the person; this is the private half, and it is the message that says one log tomorrow fixes everything.
- **No notification on `survived`.** A daily "the tower stands" push is noise that costs the wobble its signal value.
- Hibernation sends one group notification (3.11).
- **Collapse is never retracted.** `evaluate_at` exists to guarantee the outcome is decided once, after the grace window closes (DR-001). A late log arriving after `evaluate_at` belongs to the new period, not the closed one.

**Done when:** a collapse delivers one group push per member plus one private at-risk push to the member who missed; a re-run evaluation delivers nothing additional; no notification of any kind is sent for a surviving period.

---

## 3.9 — Base block write · ✅ absorbed into 3.5

**Fully implemented** in `evaluateTowerPeriod` step 7. `writeBaseBlock` (private in service.ts) calls `buildBaseBlockDraft` from `packages/shared` and `appendBaseBlock` from the DB layer. Runs shorter than 3 days (`MIN_BLOCK_DAYS`) write no row; ordinals stay gapless. The 2.21 E2E integration test exercises this path and asserts the recompute oracle.

The base block invariant `sum(block_height) + current_streak ≤ towers.height` is enforced by the recompute oracle. Height resets to 0 on collapse (DECISIONS P15); the block's `block_height` preserves the run length.

No separate ticket needed — this work ships as part of the existing `evaluateTowerPeriod`.

---

# Workstream 3C — Lifecycle completion

---

## 3.10 — Dormancy ladder, backstop and waking · **S** · depends: 3.5, 1.6

**Mostly implemented.** The evaluator decides transitions via `stepMembership()` in `packages/shared/src/evaluator/dormancy.ts`, and `evaluateTowerPeriod` step 8 (`applyMemberships`) persists them:

| Transition                                                       | Status                                                                                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| missed, first time → `at_risk`, `consecutive_missed_periods = 1` | ✅ implemented                                                                                                                      |
| missed again → `dormant`, `dormancy_reason = 'consecutive_miss'` | ✅ implemented                                                                                                                      |
| met quota → `active`, `consecutive_missed_periods = 0`           | ✅ implemented                                                                                                                      |
| 14-day backstop → `dormant`, `dormancy_reason = 'backstop'`      | ✅ implemented in evaluator                                                                                                         |
| Voluntary return expiry                                          | ✅ implemented in evaluator                                                                                                         |
| Waking on qualifying log                                         | ✅ implemented in entry handler (`apps/api/src/entries/routes.ts`) — wakes `consecutive_miss` and `backstop` dormant, NOT voluntary |

**Remaining work:**

1. **Backstop sweep for non-evaluating towers.** The 14-day backstop currently fires during evaluation, but a hibernating tower evaluates nothing, so a backstop that only fires during evaluation would miss members in a tower that's been quiet for >14 days. Add a tick sweep: `state != 'dormant' AND (last_qualifying_date IS NULL OR last_qualifying_date < now_local - 14 days)` → `dormant`, `dormancy_reason = 'backstop'`.

2. **Dormancy notifications.** The `dormant` notification type exists in the enum but is not yet sent. Enqueue a private notification to the newly-dormant member as part of 3.5 step 10.

**Done when:** a member silent for 14 days in a hibernating tower (no evaluations running) still goes dormant via the sweep; dormancy notifications are delivered.

---

## 3.11 — Hibernation and wake · **S** · depends: 3.10, 1.8

**Mostly implemented.** `evaluateTowerPeriod` already writes `outcome = 'hibernated'` when all memberships are dormant, preserves `current_streak`, writes no base block, and materialises the next period. The 2.21 E2E test exercises this path including solo continuation and reactivation.

**Remaining work:**

- One group notification on _entering_ hibernation, `dedupe_key = hibernate:{tower_id}:{period_id}`. Nothing on subsequent hibernated periods — a tower nobody is using should not send a push every night. This requires the `hibernate` notification type added in 3.1.
- Surface the "you're holding this up alone" state in the API response so the client can say _"You're holding this up alone."_

**Done when:** a 30-day hibernation sends one notification, not 30; the API response distinguishes the solo-active-member state.

---

## 3.12 — Voluntary dormancy · **M** · depends: 3.10, 1.6 · D12 · _(closes spec open decision #4)_

An API ticket rather than a worker one, but it only becomes meaningful once the worker is collapsing towers.

**Endpoints**

| Method | Path                  | Notes                                    |
| ------ | --------------------- | ---------------------------------------- |
| POST   | `/towers/:id/absence` | `{ from, to }`, tower-local dates        |
| DELETE | `/towers/:id/absence` | Cancel an upcoming or active declaration |

**Caps (D12):** 14 days per declaration, 28 days per rolling 365 days, one active or upcoming declaration at a time. Enough for a holiday, not enough to opt out of the game.

- An absence covering a period means the member is **excused**: they cannot cause a wobble or a collapse, and the tower's streak continues.
- Excused is not the same as dormant-by-absence for scoring: excused periods count as `total_days` but not `qualifying_days` in the base block roster, and the member shows as `was_dormant` only if they were actually dormant.
- Stored as `dormancy_reason = 'voluntary'` with `voluntary_return_date` (the column 1.6 added ahead of time for exactly this).
- **Timing rule:** a declaration takes effect immediately if the current period has not yet reached `deadline_at`, otherwise from the next period. It never retroactively excuses a period whose outcome is already decided — that would be un-collapsing a tower by API call.
- Cancelling restores `active` from the next period onward.
- The group sees the member greyed out with a return date. Declared absence is socially different from silent disappearance and the UI should make that obvious; this is the most likely reason a well-functioning tower dies, and it is entirely avoidable.

**Done when:** a declared absence spanning a period produces `survived` with that member not logging; the caps reject a 15-day declaration, a second concurrent declaration, and a declaration exceeding the annual budget; a declaration submitted after the deadline does not excuse the current period; cancelling returns the member to `active` without collapsing anything.

---

# Workstream 3D — Delivery

---

## 3.13 — Graphile Worker and push delivery · **L** · depends: 3.1, 1.10 · D10 · ⭐

**Queue setup**

- `graphile-worker` running in the same process as the tick loop, own `graphile_worker` schema, migrations applied at boot.
- Task list: `send_push`, `send_email` (3.14), `check_push_receipts`, `nudge`, `wobble`.
- `max_attempts: 5` with Graphile's exponential backoff. A push that fails five times over roughly half an hour is not going to succeed.
- `addJob` always takes the ambient transaction's client when called from 3.5.
- `jobKey` on scheduled jobs so re-enqueueing replaces rather than duplicates; `jobKeyMode: 'preserve_run_at'` so a replacement doesn't silently move a nudge.

**Notification rows are the idempotency boundary**

Insert the `notifications` row first, `ON CONFLICT (dedupe_key) DO NOTHING`. If zero rows were inserted, the notification already exists — return without sending. This is why 1.10 made `dedupe_key` unique, and it is what makes an idempotent evaluator safe to pair with a non-idempotent push service.

**Expo Push Service (D10)**

- `expo-server-sdk` with `chunkPushNotifications` — the service accepts 100 per request and the SDK handles batching.
- Send returns **tickets**, not delivery confirmations. Store the ticket id on the notification row, then enqueue `check_push_receipts` with `run_at` ≈ 15 minutes out. Receipts are where real failures appear; a 200 from the send call means Expo accepted the message, nothing more.
- `DeviceNotRegistered` in a receipt → set `push_tokens.invalidated_at`. Never retry that token again. This is the main reason a push pipeline silently rots.
- `MessageRateExceeded` → let Graphile retry with backoff.
- `MessageTooBig` or `InvalidCredentials` → fail permanently and log loudly; these are bugs, not transient conditions.
- Mark the notification `sent` on a successful ticket, `failed` with the error on a permanent one.

**Why Expo rather than direct APNs/FCM:** the client is Expo (0.x), so `expo-notifications` tokens are already the native format, and direct APNs would mean managing a signing key, a token refresh loop and two separate payload shapes for the sake of removing one hop. Worth revisiting only if delivery latency becomes a complaint.

**No quiet-hours logic in v1.** Deadlines are chosen by the group, so notifications land in the evening by construction, and 1.5 already steers the default to 22:00 rather than 23:59. A tower that deliberately sets a 02:00 deadline gets 02:00 notifications, which is what it asked for.

**Done when:** a collapse delivers one push per member with no duplicate on job retry; an invalidated token is never sent to twice; receipts are checked and `DeviceNotRegistered` invalidates the token; a push failure never rolls back or re-triggers an evaluation; killing the worker mid-send redelivers at most one duplicate, absorbed by the dedupe key.

---

## 3.14 — Email delivery for login codes · **M** · depends: 3.13, 2.9 · D9 · _ship first_

This is the gate on anyone other than you using the app, so it belongs at the front of the phase rather than the end.

Replace the `AUTH_CODE_LOG` sink behind 2.9's existing `sendLoginCode(email, code)` interface. No handler changes.

- **Resend (D9)**, called from a `send_email` Graphile task so a provider blip retries instead of costing someone their login.
- Dedicated sending subdomain (`mail.` or `auth.`) with SPF and DKIM configured, so a deliverability problem can never contaminate the apex domain.
- Plain text plus a minimal HTML part. Transactional auth mail with heavy markup reads as marketing to filters.
- **Put the bare code first in both subject and body**, unpunctuated and unwrapped — `123456 is your Tower code`. iOS and Android Mail both surface a code for one-tap entry when it is cleanly delimited, and a code buried in a sentence loses that.
- Bounce and complaint webhook → mark the address undeliverable and surface it at the next code request, so a user with a typo'd email learns why nothing arrived instead of retrying forever.
- `AUTH_CODE_LOG` asserted false in production config, and the assertion covered by a test.

**Done when:** a code arrives at a real inbox within 10 seconds, not in spam, on a cold domain with SPF/DKIM passing; a forced provider error retries and eventually succeeds; a hard bounce marks the address and the next request surfaces it; the code is one-tap-entry on an iPhone.

---

# Workstream 3E — Observability and operations

---

## 3.17 — Dead-man's-switch and metrics · **M** · depends: 3.2

A scheduler that silently stops is the worst failure this system has: nothing errors, nothing alerts, and every tower collapses the following night. The point of this ticket is that you find out from a page, not from a friend.

- **healthchecks.io ping after each successful tick**, with a grace period of 3× the tick interval. Ping on success only — a tick that threw must not report healthy.
- Alert destination is email plus whatever you actually read on a phone.
- **The metric that matters most: `oldest_pending_period_age`** — the age of the oldest `pending` period whose `evaluate_at` has passed. Healthy is under a minute. Over 15 minutes means the scheduler is behind even though the process is alive and pinging, which is the failure mode the dead-man's-switch alone cannot see.
- Structured log line per evaluation with `tower_id`, `period_id`, `outcome`, duration.
- Counters per tick from `TickReport` (3.2): claimed, evaluated, skipped, errored, duration; plus pushes sent, pushes failed, tokens invalidated.
- Log the Graphile Worker failed-job count; a growing permanently-failed queue is a real outage wearing a disguise.

**Done when:** stopping the worker triggers a healthchecks.io alert within the grace period; a tick that throws does not ping; `oldest_pending_period_age` is queryable and alerts above 15 minutes; one log line per evaluation carries enough to reconstruct what happened without a debugger.

---

## 3.18 — Operational runbook · **S** · depends: 3.17

`docs/runbook-phase3.md`, with exact commands rather than descriptions.

Procedures to cover:

```bash
# Deploy and restart the worker only
cd /opt/tower-of-habit
git pull && docker compose build worker && docker compose up -d --no-deps worker
docker compose logs -f --tail=100 worker

# Apply migrations
docker compose run --rm api pnpm --filter @tower-of-habit/db migrate:deploy

# Scheduler behind: how far?
docker compose exec postgres psql -U tower -d tower_of_habit -c \
  "SELECT id, tower_id, evaluate_at, now() - evaluate_at AS behind
     FROM tower_periods WHERE state = 'pending' AND evaluate_at <= now()
     ORDER BY evaluate_at LIMIT 20;"

# Re-evaluate one period by hand (the 2.19 endpoint, still mounted)
curl -X POST -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  localhost:3000/internal/towers/$TOWER/periods/$PERIOD/evaluate

# Permanently failed notification jobs
docker compose exec postgres psql -U tower -d tower_of_habit -c \
  "SELECT task_identifier, last_error, attempts, run_at
     FROM graphile_worker.jobs WHERE attempts >= max_attempts ORDER BY run_at DESC;"

# Verify a tower's stored height against the oracle
docker compose run --rm api pnpm --filter @tower-of-habit/api recompute --tower $TOWER
```

Also document: what to do when a tower's height is wrong (recompute, then repair), how to confirm a notification was or wasn't sent for a given period, and how to invalidate a stuck push token.

**Done when:** a stranger could restart the worker, diagnose a lagging scheduler, and verify a tower's height using only this file.

---

# Workstream 3F — Verification

---

## 3.15 — Worker test suite · **L** · depends: 3.1 … 3.14

Builds on 1.11's factories and 2.20's harness. Integration-level, real Postgres, no mocks for the database.

Cases that must exist:

- **Claim concurrency** — two workers, disjoint claims, proven under real parallelism (1.8's exit criterion, now exercised by the real caller).
- **Crash safety** — kill mid-transaction, period returns to `pending`, next tick evaluates exactly once.
- **Idempotency** — evaluate the same period twice: one outcome, one base block, one notification set.
- **Outbox** — force a rollback after job enqueue and assert `graphile_worker.jobs` is empty; commit and assert the jobs exist.
- **Staleness guards** — a nudge or wobble job running after `deadline_at` sends nothing.
- **Dedupe** — replaying every notification job sends nothing further.
- **Backstop** — 14 days silent in a hibernating tower still goes dormant.
- **Hibernate and wake** — streak preserved, one notification, resumption on a log.
- **Token invalidation** — a `DeviceNotRegistered` receipt stops future sends to that token.
- **Recompute oracle** — asserted after every scenario above.

**Done when:** the suite runs in CI against Compose Postgres, under two minutes, with no sleeps and no flakes across 20 consecutive runs.

---

## 3.16 — Time-travel scenario test · **L** · depends: 3.15 · ⭐

The phase's acceptance test: one timeline, driven by calling `runTick(now)` with a synthetic clock, no sleeping and no mocked system time.

A 40-day script over a 3-member tower (A, B, C), asserting state **and** the exact notification set per user at each step. Running totals are part of the assertions, so they are given explicitly:

| Day   | What happens                      | Outcome         | Height / streak | Notifications                                |
| ----- | --------------------------------- | --------------- | --------------- | -------------------------------------------- |
| 1–3   | everyone logs                     | `survived` ×3   | 3 / 3           | **none**                                     |
| 4     | C hasn't logged at `nudgeAt`      | —               | —               | private nudge to **C only**                  |
| 4     | still nothing at `wobbleAt`       | —               | —               | broadcast to A, B, C naming C                |
| 4     | C logs inside the grace window    | `survived`      | 4 / 4           | none                                         |
| 5     | C misses entirely                 | `collapsed`     | 4 / 0           | group ×3 + private at-risk to C              |
| 5     | base block written                | —               | —               | ordinal 1, `block_height` 4, run days 1–4    |
| 6     | C misses again, A and B log       | `survived`      | 5 / 1           | **none** — C → `dormant`, no second collapse |
| 7–20  | A and B log, C dormant            | `survived` ×14  | 19 / 15         | none                                         |
| 21    | B declares absence for days 21–24 | `survived`      | 20 / 16         | none — no wobble naming B                    |
| 22–24 | A logs, B excused, C dormant      | `survived` ×3   | 23 / 19         | none                                         |
| 25    | B's return date reached, B logs   | `survived`      | 24 / 20         | none                                         |
| 26    | C logs once                       | `survived`      | 25 / 21         | none — C → `active`, counter 0               |
| 27–29 | all three log                     | `survived` ×3   | 28 / 24         | none                                         |
| 30    | nobody logs                       | `collapsed`     | 28 / 0          | group ×3 + private at-risk ×3                |
| 30    | base block written                | —               | —               | ordinal 2, `block_height` 24, run days 6–29  |
| 31    | nobody logs                       | `hibernated`    | 28 / 0          | one group hibernation notice                 |
| 32–38 | nothing                           | `hibernated` ×7 | 28 / 0          | **none**                                     |
| 39    | A logs, alone                     | `survived`      | 29 / 1          | none                                         |
| 40    | across a DST transition           | `survived`      | 30 / 2          | none                                         |

Two assertions in that table are the ones most likely to break: **day 6 sends nothing at all** (the second miss converts to dormancy instead of a collapse, so there is no group push), and **days 32–38 send nothing** (hibernation notifies once, not nightly).

Add a second, shorter script for the sub-minimum run, which the main timeline deliberately doesn't cover: a 2-day run collapsing, asserting no base block row and **no consumed ordinal**, followed by a 10-day run producing the next ordinal with `run_start_date` immediately after the short run's collapse — and `sum(block_height) + current_streak` short of `height` by exactly those 2 days.

**Done when:** the full timeline runs in under 30 seconds; every assertion is on persisted state or recorded notifications, never on a log line; `recompute(tower)` matches at every step; the suite fails if any notification is sent that the table above does not list.

---

## Suggested order

3.9 (base blocks) is absorbed into 3.5 — it's already implemented in `evaluateTowerPeriod`. The dependency graph shifts because 3.4, 3.5, 3.10, and 3.11 are partially done:

```
3.14 email ← ship first, it gates every other human using the app
   ↓
3.1 scaffold (BullMQ→Graphile, enum migration)
   ↓
3.2 tick → 3.3 sweep → 3.4 claim (wire existing DB fns) → 3.5 evaluate (add step 10: notification enqueueing)
                                                              ↓
                        3.13 Graphile Worker + push ⭐ ← ─────┤
                                ↓                             │
                        3.6 nudge → 3.7 wobble → 3.8 collapse
                                                              ↓
                        3.10 dormancy (remaining: backstop sweep)
                           ↓
                        3.11 hibernation (add notification) → 3.12 voluntary (new endpoints)
                                                              ↓
                        3.17 observability → 3.18 runbook
                                                              ↓
                        3.15 suite → 3.16 time-travel ⭐
```

3.14 first is deliberate and the one ordering change worth insisting on: until email works, you are the only person who can log in, which means no second account, which means no real tower, which means none of 3.5–3.12 can be exercised by hand.

**Rough total: 10–14 working days** (down from 14–18; 3.4, 3.5, 3.9, 3.10, 3.11 are partially done). The remaining risk concentrates in 3.13 and 3.16. If compressing, compress 3.12 (a clean deferral to V1.1) or 3.18 (write it later, badly, under pressure). Never compress 3.16 — it is the only thing that proves the mechanic works unattended, which is the entire premise of the app.

## Phase 3 exit criteria

- [x] Addendum 1.13 landed; `users.password_hash` is gone and OTP login works end to end (proven by 2.9 and 2.21 E2E test; real inbox pending 3.14)
- [ ] A tower started and left alone evaluates every period correctly for 7 consecutive days with no manual intervention
- [ ] Nudge precedes wobble precedes collapse, in that order, with the nudge private
- [ ] No notification is sent for a surviving period
- [ ] A surviving period, a collapse, a dormancy and a hibernation all produce exactly one correct notification set each
- [ ] The worker survives `SIGKILL` mid-evaluation with no double credit, no double notification, and no lost period
- [ ] 72 hours of worker downtime catches up correctly with no stale wobbles
- [ ] A silent member costs the group exactly one collapse, then goes dormant
- [ ] A declared absence costs the group nothing
- [ ] `recompute(tower) === stored(tower)` across every scenario in 3.15 and at every step of 3.16
- [ ] `sum(block_height) + current_streak ≤ towers.height` holds, with the gap attributable to sub-minimum runs
- [ ] Stopping the worker alerts within 3× the tick interval
- [ ] `oldest_pending_period_age` is observable and alerts above 15 minutes
- [ ] The runbook is sufficient for someone else to operate the system

## Explicitly out of scope

| Item                                                       | Phase               |
| ---------------------------------------------------------- | ------------------- |
| Milestones and altitude rewards (needs addendum 1.14)      | V1.1 — first ticket |
| High fives and "member completed" notifications            | V1.1                |
| Change-of-email flow (now unblocked by 3.14)               | 4                   |
| Expo client, push token registration UI                    | 4                   |
| Quiet hours and per-user notification preferences          | post-MVP            |
| Weekly towers, slack-based wobble, partial-period freebie  | v2                  |
| Account deletion and roster anonymisation (flagged in 1.2) | 6                   |
