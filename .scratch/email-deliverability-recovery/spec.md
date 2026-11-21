Status: ready-for-agent

# Email Deliverability Lockout Recovery

## Problem Statement

When Resend reports a bounce or complaint, the email is permanently blocked in the `email_deliverability` table. There is no recovery path — a user whose email temporarily bounced (full mailbox, transient DNS failure) is permanently locked out of their account. `clearEmailDeliverability` exists in the DB layer but is not exposed through any API surface.

## Solution

Add a TTL-based auto-expiry for deliverability blocks and expose an internal API endpoint for manual clearing. Soft bounces auto-expire after 30 days; hard bounces and complaints require manual clearing via the internal API.

## User Stories

1. As a user whose mailbox was temporarily full, I want the bounce block to expire after a reasonable period, so that I can log in again without contacting support.
2. As an operator, I want to manually clear a deliverability block for a specific email, so that I can resolve support tickets.
3. As an operator, I want to distinguish between soft bounces (transient) and hard bounces (permanent), so that auto-expiry only applies where appropriate.
4. As a user, I want a clear error message when my email is blocked, so that I know to contact support or wait.

## Implementation Decisions

- Add a `bounceType` column to `email_deliverability` (text, `'soft'` | `'hard'` | `'complaint'`). The Resend webhook payload includes bounce type classification.
- Modify `isEmailDeliverable` to check: if `bounceType = 'soft'` AND `markedAt + 30 days < now()`, treat as deliverable (the block has expired). Hard bounces and complaints remain permanent until manually cleared.
- Add `DELETE /v1/internal/email-deliverability/:email` to the internal API (guarded by `INTERNAL_API_TOKEN`). Calls existing `clearEmailDeliverability`.
- Update the Resend webhook handler to pass bounce type when calling `markEmailUndeliverable`.
- The 422 `email_undeliverable` error message should tell the user to try again later (soft bounce) or contact support (hard bounce/complaint).

## Testing Decisions

- Test the `isEmailDeliverable` query function with the TTL logic (DB-level test in `packages/db`).
- Integration test: webhook marks email as soft-bounce → wait (use test clock) → user can request code again.
- Integration test: internal endpoint clears a hard bounce → user can request code again.
- Prior art: existing `email-deliverability.test.ts` in `packages/db`, webhook integration tests.

## Out of Scope

- Self-service recovery (e.g., user proves email ownership via alternative channel). The app has no alternative contact method.
- Automatic retry of failed email sends. The recovery is about unblocking future code requests, not resending failed ones.

## Further Notes

The 30-day TTL for soft bounces is a starting point. Monitor bounce rates after launch and adjust. If a soft bounce address bounces again on retry, it gets re-blocked with a fresh `markedAt`.
