# Absence redesign: streak shields

See ADR: `docs/adr/0001-shield-based-absence.md`

## Summary

Replace budget-based absence with streak shield mechanic. Active members who survive periods during another member's absence earn tower-wide shields that auto-prevent collapse.

## Changes required

### DB schema

- Add `shieldCount` (integer, default 0, max 3) to `towers` table
- Remove `voluntaryAbsenceDaysUsed` from `memberships` table
- Migration to drop the column and add the new one

### Absence endpoint (`POST /towers/:id/absence`)

- Remove annual budget validation (`annual_budget_exceeded`)
- Add "1 full period in advance" validation: `from` date must be >= current period end + 1 day
- Keep 14-day max per single absence
- Keep "one active absence at a time" check

### Evaluator changes

- On survived period: if any member is dormant with `dormancyReason = 'voluntary'`, increment `shieldCount` (capped at 3)
- On collapse: if `shieldCount > 0`, decrement by 1 and convert the collapse to a survived period instead. Members who missed quota still get their `consecutiveMisses` incremented but the tower survives.

### Notification

- New type: `shield_consumed` — sent to all tower members when a shield prevents a collapse
- New type: `shield_earned` (optional) — sent when a shield is banked

### API response

- Add `shieldCount` to `towerActiveResponseSchema`

## Priority

Must complete before 5.11 (Dormancy and absence UI).
