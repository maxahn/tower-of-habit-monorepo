# Phase 3 Operational Runbook

Exact commands for diagnosing and recovering the Tower of Habit worker.
All `docker compose` commands assume you are in the repo root.

---

## 1. Deploy and restart the worker

```bash
# Rebuild and restart only the worker (zero-downtime: new container starts before old stops)
docker compose build worker && docker compose up -d --no-deps worker

# Tail logs to confirm startup
docker compose logs -f --tail=100 worker

# Verify the healthz endpoint responds
docker compose exec worker wget -qO- http://localhost:4000/healthz
# Expected: {"ok":true}
```

The worker runs two systems in parallel: a **tick loop** (claims and evaluates periods) and **Graphile Worker** (async jobs: email, push, nudge, wobble). Both must start cleanly — check logs for `graphile-worker started` and `tick loop started`.

---

## 2. Apply migrations

Migrations live in `packages/db/migrations/` and run via `drizzle-kit migrate` inside the **api** container (which bundles `drizzle.config.ts` and the migrations folder; the worker image does not).

```bash
# Staging
pnpm migrate:deploy:staging

# Production (or any compose stack)
docker compose run --rm --no-deps api pnpm --filter @tower-of-habit/db migrate:deploy
```

Always migrate **before** deploying a new api/worker image that expects the new schema.

---

## 3. Scheduler diagnostics

### How far behind is the scheduler?

```sql
-- Overdue pending periods, oldest first
SELECT id, tower_id, period_start, evaluate_at,
       now() - evaluate_at AS behind
  FROM tower_periods
 WHERE state = 'pending' AND evaluate_at <= now()
 ORDER BY evaluate_at
 LIMIT 20;
```

```bash
docker compose exec postgres psql -U tower -d tower_of_habit -c \
  "SELECT id, tower_id, period_start, evaluate_at, now() - evaluate_at AS behind
     FROM tower_periods WHERE state = 'pending' AND evaluate_at <= now()
     ORDER BY evaluate_at LIMIT 20;"
```

### Oldest pending period age (single number)

```sql
SELECT EXTRACT(EPOCH FROM (now() - min(evaluate_at)))::int AS age_seconds
  FROM tower_periods
 WHERE state = 'pending' AND evaluate_at <= now();
```

The worker's metrics collector logs a warning when this exceeds 15 minutes.

### Poison periods (exhausted claim attempts)

A period claimed 5+ times without evaluating is poison — it needs manual intervention.

```sql
SELECT id, tower_id, period_start, evaluate_at, state, attempts, claimed_at
  FROM tower_periods
 WHERE state IN ('pending', 'evaluating') AND attempts >= 5;
```

Fix: either resolve the underlying error and re-evaluate by hand (§4), or reset the attempt counter:

```sql
UPDATE tower_periods SET attempts = 0, state = 'pending', claimed_at = NULL
 WHERE id = '<period-id>';
```

---

## 4. Re-evaluate a period by hand

Uses the 2.19 internal endpoint. Requires `INTERNAL_API_TOKEN` to be set on the api.

```bash
curl -s -X POST \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN" \
  http://localhost:3000/v1/internal/towers/$TOWER_ID/periods/$PERIOD_ID/evaluate \
  | jq .
```

**Notes:**

- Idempotent: an already-evaluated period returns an error code (`period_already_evaluated`), not a double evaluation.
- Runs the full evaluation: outcome, height/streak update, base block on collapse, membership transitions, notification enqueueing, and next-period materialisation.
- The period must be in `pending` or `evaluating` state and its `evaluate_at` must be in the past.

To find the period id for a tower:

```sql
SELECT id, period_start, period_end, state, evaluate_at
  FROM tower_periods
 WHERE tower_id = '<tower-id>'
 ORDER BY period_start DESC
 LIMIT 10;
```

---

## 5. Permanently failed Graphile Worker jobs

### Inspect

```sql
SELECT id, task_identifier, payload::text, attempts, max_attempts,
       last_error, created_at, run_at
  FROM graphile_worker.jobs
 WHERE attempts >= max_attempts AND last_error IS NOT NULL
 ORDER BY created_at DESC;
```

```bash
docker compose exec postgres psql -U tower -d tower_of_habit -c \
  "SELECT id, task_identifier, payload::text, attempts, max_attempts,
          last_error, created_at, run_at
     FROM graphile_worker.jobs
    WHERE attempts >= max_attempts AND last_error IS NOT NULL
    ORDER BY created_at DESC;"
```

**Task list reference:** `send_email`, `send_push`, `check_push_receipts`, `nudge`, `wobble`.

### Retry a failed job

Reset its attempt counter so Graphile Worker picks it up again:

```sql
UPDATE graphile_worker.jobs
   SET attempts = 0, run_at = now()
 WHERE id = <job-id>;
```

### Delete a permanently failed job

```sql
DELETE FROM graphile_worker.jobs WHERE id = <job-id>;
```

---

## 6. Verify / repair a tower's height

The recompute oracle derives height and currentStreak from the period ledger alone and compares them against the stored values.

### Verify (read-only)

```bash
docker compose run --rm --no-deps api pnpm --filter @tower-of-habit/api recompute --tower $TOWER_ID
```

Exits 0 if the tower is healthy. Exits 1 and prints divergences if height or streak is wrong.

### Repair (writes corrected values)

```bash
docker compose run --rm --no-deps api pnpm --filter @tower-of-habit/api recompute --tower $TOWER_ID --repair
```

What it does:

- Locks the tower row (`FOR UPDATE`) so it serialises with any concurrent evaluation.
- Rewrites `height` and `current_streak` if they diverge from the ledger.
- **Does NOT fix base blocks.** `base_blocks` is append-only and its rosters are frozen snapshots — block repair is a human decision. Block divergences are reported in the output.

### Raw SQL verification (no CLI)

```sql
-- Count survived periods = height
SELECT count(*) AS height
  FROM tower_periods
 WHERE tower_id = '<tower-id>' AND outcome = 'survived';

-- Current streak: count consecutive survived from the latest evaluated period backwards
SELECT period_start, outcome
  FROM tower_periods
 WHERE tower_id = '<tower-id>' AND state = 'evaluated'
 ORDER BY period_start DESC;
-- Walk backwards: streak = number of leading 'survived' rows before the first non-survived.
```

---

## 7. Confirm whether a notification was sent

The `notifications` table has no `period_id` column. The period id is embedded in `dedupe_key`.

### Query by period

```sql
SELECT id, user_id, type, dedupe_key, status, sent_at, error, created_at
  FROM notifications
 WHERE dedupe_key LIKE '%<period-uuid>%'
 ORDER BY created_at;
```

### Dedupe key formats

| Type                               | Format                                    |
| ---------------------------------- | ----------------------------------------- |
| nudge, wobble, collapse, hibernate | `{type}:{period_id}:{user_id}`            |
| dormant, returned                  | `{type}:{membership_id}`                  |
| at_risk                            | `at_risk:{membership_id}:{period_id}`     |
| member_joined                      | `member_joined:{membership_id}:{user_id}` |
| block_completed                    | `block_completed:{block_id}:{user_id}`    |
| tower_started, tower_archived      | `{type}:{tower_id}:{user_id}`             |

### Status values

- `pending` — not yet delivered
- `sent` — delivered successfully (`sent_at` is set)
- `failed` — delivery failed (`error` is set); may be retried up to 5 attempts
- `skipped` — intentionally not sent (e.g. no live push tokens)

---

## 8. Invalidate a stuck push token

Tokens are live when `invalidated_at IS NULL`. There is no boolean `is_active` column.

### Find live tokens for a user

```sql
SELECT id, token, platform, created_at, last_seen_at
  FROM push_tokens
 WHERE user_id = '<user-id>' AND invalidated_at IS NULL;
```

### Invalidate a specific token

```sql
UPDATE push_tokens
   SET invalidated_at = now()
 WHERE token = '<expo-push-token>' AND invalidated_at IS NULL;
```

### Invalidate all tokens for a user

```sql
UPDATE push_tokens
   SET invalidated_at = now()
 WHERE user_id = '<user-id>' AND invalidated_at IS NULL;
```

Normal invalidation is automatic: `DeviceNotRegistered` errors from Expo's push receipt API trigger `invalidatePushToken` in the `check_push_receipts` Graphile Worker task. Manual invalidation is for tokens that are stuck causing repeated errors.

---

## 9. Dead-man's-switch (healthchecks.io)

The worker pings `HEALTHCHECKS_URL` after each **successful** tick (fire-and-forget). A missed ping triggers an alert from healthchecks.io.

**When the ping does NOT fire:**

- Tick threw an error
- Worker process is down
- Worker is alive but `TICK_ENABLED=false`
- `HEALTHCHECKS_URL` is not configured (noop heartbeat used instead)

**Setup:** See `docs/TODO.md` for first-time healthchecks.io configuration (account signup, check creation with 3x grace period, alert destinations).

**Relevant config vars:**

- `HEALTHCHECKS_URL` — the ping URL (optional; noop if absent)
- `TICK_ENABLED` — whether the tick loop runs at all (default true)
- `TICK_INTERVAL_MS` — tick interval in milliseconds (default in config)

### Verify the heartbeat is working

```bash
# Check worker logs for "tick complete" and "tick metrics" lines
docker compose logs --tail=50 worker | grep -E 'tick complete|tick metrics'
```

If ticks are completing but healthchecks.io shows no pings, check that `HEALTHCHECKS_URL` is set in the worker's environment.
