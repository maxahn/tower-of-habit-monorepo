# Phase 5 — Client Screens

**Goal:** the product. The mechanic becomes something people feel rather than something an endpoint reports.

**Estimate:** 15–20 days.

---

## Status

| Ticket   | Scope                                       | State   |
| -------- | ------------------------------------------- | ------- |
| **5.1**  | Habit creation + tier ladder editor         | ⬜ todo |
| **5.2**  | Habit list + standalone habit view          | ⬜ todo |
| **5.3**  | Logging: binary, numeric, tier picker       | ⬜ todo |
| **5.4**  | Tower creation + deadline picker            | ⬜ todo |
| **5.5**  | Lobby: code sharing, members, start         | ⬜ todo |
| **5.6**  | Join by code                                | ⬜ todo |
| **5.7**  | Tower home: height, streak, members, period | ⬜ todo |
| **5.8**  | Countdown timer anchored to deadline_at     | ⬜ todo |
| **5.9**  | Tower animation (Reanimated; Skia deferred) | ⬜ todo |
| **5.10** | Base block history (strata view)            | ⬜ todo |
| **5.11** | Dormancy and absence UI                     | ⬜ todo |
| **5.12** | Solo-active warning                         | ⬜ todo |
| **5.13** | Empty states and first-run guidance         | ⬜ todo |
| **5.14** | Offline and flaky-connection handling       | ⬜ todo |
| **5.15** | Settings screen (full)                      | ⬜ todo |

---

## Build order

Tickets are sequenced so each screen builds on the last. Habits before towers (a tower requires a habit). Logging before tower home (logging is the core action). Animation and history are polish after the core loop is functional.

```
5.1  Habit creation + tier ladder editor
 ↓
5.2  Habit list + standalone habit view (streak, entries)
 ↓
5.3  Logging (binary, numeric, tier picker)
 ↓
5.4  Tower creation + deadline picker
 ↓
5.5  Lobby (code sharing, member list, remove, start)
 ↓
5.6  Join by code
 ↓
5.7  Tower home (height, streak, members, current period)
 ↓
5.8  Countdown timer
 ↓
5.9  Tower animation (Reanimated)
 ↓
5.10 Base block history (strata view)
 ↓
5.11 Dormancy and absence UI
 ↓
5.12 Solo-active warning
 ↓
5.13 Empty states and first-run guidance
 ↓
5.14 Offline handling
 ↓
5.15 Settings screen (full)
```

---

## Key decisions

| #   | Decision                | Resolution                                                                                                                           |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Logging interaction     | Optimistic mutation via TanStack Query. `clientEntryId` (uuid) for idempotency. Revert on server error.                              |
| D2  | Countdown source        | `deadlineAt` only. `evaluateAt` never shown. Timer ticks via `useEffect` interval at 1s.                                             |
| D3  | Animation library       | Reanimated 3 for the tower animation. Skia renderer deferred to M6 — the animation boundary is a swappable component.                |
| D4  | Offline strategy        | TanStack Query `onlineManager` + mutation pausing. Idempotency keys prevent duplicates on retry. Full sync queue deferred to M6.     |
| D5  | Tower home data         | Single `GET /towers/:id` call returns everything (members, current period, blocks). No separate period polling.                      |
| D6  | Navigation for towers   | Stack navigator inside the Towers tab: list → detail (lobby or active) → strata history. Modal for join-by-code.                     |
| D7  | Habit navigation        | Stack navigator inside the Habits tab: list → detail → create/edit. Logging happens inline on the detail screen.                     |
| D8  | Join code display       | Formatted as `XXXX-XXXX` (4+4). Share sheet for sending the code. Deep link deferred to M6.                                          |
| D9  | "Who caused collapse"   | Never shown. The API doesn't expose it, the client doesn't compute it. Collapse is the tower's event, not a person's.                |
| D10 | Strata view             | Flat list of base blocks, newest on top. Each row shows run height, dates, and member roster. Tap expands the roster.                |
| D11 | Standalone habit streak | Computed client-side from entry dates (same logic as `currentStreak` in shared). Visible on the habit detail screen.                 |
| D12 | Pull-to-refresh         | All list screens and the tower home support pull-to-refresh via TanStack Query's `refetch`.                                          |
| D13 | Form validation         | Shared zod schemas used for client-side validation. `zodResolver` with react-hook-form for create/edit forms.                        |
| D14 | Tier ladder editor      | Inline on the habit creation screen. Numeric habits start with one tier; "add tier" appends. Drag-to-reorder deferred — manual only. |

---

## Acceptance criteria

- [ ] Only `deadlineAt` is ever displayed; `evaluateAt` appears nowhere in the UI
- [ ] A double-tapped log produces one credit and no error toast
- [ ] A log made with no connection is retried and converges, never duplicated
- [ ] Height and streak are shown as two distinct numbers, never summed
- [ ] The strata view is legible to someone who joined for the fifth attempt
- [ ] No screen anywhere shows who caused a collapse
- [ ] A member in a distant timezone sees their own local deadline time alongside the tower's
- [ ] The animation runs at 60fps on a mid-range Android device, and the Skia boundary is swappable
- [ ] Creating a habit, logging, creating a tower, joining, and starting all work end-to-end on a real device
- [ ] Empty states guide the user toward the next action (create habit, create/join tower)
- [ ] A declared absence shows the return date and greys out the member row

## Exit gate

Three people on three physical devices run a real tower for a week, including a deliberate collapse, without anyone needing to be told how it works.
