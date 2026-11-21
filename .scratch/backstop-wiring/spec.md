Status: done

# Wire Backstop Sweep Into Worker

## Problem Statement

`sweepBackstop` transitions stale active/at_risk memberships to dormant when a member hasn't logged a qualifying entry in 14+ days. The function is implemented and integration-tested but never called from the worker's entry point, tick loop, or task list. Members who fall through the evaluator's backstop check (e.g., towers with no pending period, towers stuck in error state) silently remain "active" forever.

The evaluator's dormancy state machine does fire `backstopDue` on `day_elapsed` events during period evaluation, so most backstop transitions happen there. The standalone sweep is defense-in-depth — it catches what the evaluator misses.

## Solution

Wire `sweepBackstop` as a Graphile Worker cron job that runs hourly. This matches the date-granular nature of backstop checks (14-day threshold) without adding load to the 30-second tick loop. Also move the raw schema query out of the sweep module and into a proper DB package function.

## User Stories

1. As a tower host, I want members who silently stop logging to be automatically marked dormant, so that my tower's active roster reflects reality.
2. As an operator, I want a safety net that catches memberships the evaluator misses, so that no member stays falsely "active" indefinitely.
3. As an operator, I want to see how many backstop transitions each sweep performs, so that I can monitor whether the evaluator is handling most cases.
4. As a member, I want to receive a dormant notification when the backstop fires, so that I know my membership status changed.
5. As an operator, I want the backstop sweep to run on a schedule independent of the tick loop, so that evaluation latency isn't affected by the safety-net scan.
6. As a developer, I want the backstop query to live in the DB package alongside other membership queries, so that schema coupling is contained.

## Implementation Decisions

- **Scheduling**: Add `sweepBackstop` as a Graphile Worker cron task, not a tick-loop step. Configure it to run once per hour via the `crontab` option in the worker's `run` configuration. The tick loop stays lean for time-sensitive evaluation.
- **Keep the existing function signature**: `sweepBackstop(db, now)` stays as-is. No TickDeps-style injection — the function is a single scan with no orchestration logic that benefits from mocking. Integration tests are the right level.
- **Extract the query to `packages/db`**: The sweep currently imports raw Drizzle schema tables (`memberships`, `towers`) and builds a custom join. Move this query into a function in the DB package (e.g., `listBackstopCandidates`) that returns the membership snapshots with timezone. The sweep module then calls the DB function and applies the `backstopDue` decision, keeping schema coupling in one place.
- **Logging**: Log the count of transitions per sweep run for observability. If count is 0, log at debug level; if > 0, log at info.
- **Error handling**: If the sweep throws, Graphile Worker retries per its default policy. The sweep is idempotent — `transitionMembership` uses optimistic concurrency, so a retry won't double-transition.

## Testing Decisions

- The existing 5 integration tests in `backstop.integration.test.ts` already cover the sweep logic thoroughly (never-logged member, exact boundary at day 14, day 13 no-op, skip dormant, notification enqueuing). These tests continue to pass unchanged.
- Add a DB-level test for the new `listBackstopCandidates` function: verify it returns only active/at_risk memberships with their tower timezone.
- No new integration test for the cron scheduling itself — Graphile Worker's cron is well-tested infrastructure. The existing tests verify the function; wiring is a one-line configuration.
- Prior art: existing `backstop.integration.test.ts` and `sweep.test.ts` patterns.

## Out of Scope

- Changing the backstop threshold (14 days). That's a domain decision, not an architectural one.
- Adding backstop to the tick loop. The hourly cron matches the date granularity.
- Dependency injection for the sweep function. Integration tests are sufficient for a single-query module.

## Further Notes

The backstop is a safety net, not the primary path. The evaluator's dormancy state machine handles most cases during normal period evaluation. Monitor the cron job's transition count — if it regularly finds members to transition, that signals the evaluator has a gap worth investigating.
