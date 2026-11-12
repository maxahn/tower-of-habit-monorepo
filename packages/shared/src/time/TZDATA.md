# tzdata notes

## Alberta: permanent UTC−6 (tzdata 2026c)

**Status (2026-11-12): pending.** The runtime is behind. Node 24.11.1 bundles tzdata `2025b`, which still applies DST to `America/Edmonton`. `tzdata-canary.test.ts` fails once the runtime picks up the new rule. When it does, work through this file and then delete the canary.

### What changed

- Alberta's Official Time Act (2026) puts the province on UTC−6 year-round.
  - The last clock change was the spring-forward on 2026-03-08. Clocks did **not** fall back on 2026-11-01.
  - UTC−6 year-round is the same offset Saskatchewan uses (`America/Regina`).
- IANA shipped the rule in **tzdata 2026c (2026-07-08)**.
- **The identifier is unchanged: keep using `America/Edmonton`.**
  - There is no new zone name to adopt or validate.
  - "Mountain Time (Alberta)" is only a Windows display name.
  - Don't map Alberta users to `America/Regina` or `America/Denver`. Edmonton is the correct zone, and its _rules_ changed.

Sources: [IANA tz releases](https://www.iana.org/time-zones/releases), [timeanddate](https://www.timeanddate.com/news/time/alberta-permanent-dst.html), [Corretto tzdata issue](https://github.com/corretto/corretto-8/issues/580).

### Live impact until the runtime is upgraded

While a process runs on tzdata older than 2026c, every Edmonton instant from 2026-11-01 onward is resolved at UTC−7 instead of UTC−6. That makes it **one hour late in UTC**.

- `tower_periods.deadline_at` and `evaluate_at` are affected. A 22:00 deadline fires at what is really 23:00 local.
- Nudge and wobble times are affected the same way.
- `local_date` derivation near midnight is affected too (`resolveLocalDate` / `civilInZone`). A log at 23:30 real local time is read as 22:30.
- `tower_periods` rows are pinned when they are created. Periods that already exist keep the wrong instants even after the upgrade. See step 6 below.

### Runtime fix checklist

1. Move to a Node release whose `process.versions.tz` is `2026c` or later. Bump `.nvmrc`, the `engines` field if needed, and the api/worker Docker base images.
2. Stopgap if no such Node release exists yet: point `NODE_ICU_DATA` at a full ICU data file built with tzdata 2026c or later.
3. Verify the fix:
   ```bash
   node -p process.versions.tz          # >= 2026c
   node -e 'console.log(new Intl.DateTimeFormat("en-CA",{timeZone:"America/Edmonton",timeZoneName:"shortOffset"}).format(new Date("2027-01-15T12:00Z")))'
   # expect GMT-6
   ```
4. Mobile: Hermes reads the device OS timezone database, which updates with OS updates, so the app needs no change. Check on a real device: an Alberta device in January should show UTC−6.
5. Postgres: nothing in the repo uses `AT TIME ZONE` or timezone-aware SQL today, so its tzdata doesn't matter yet. Check again if that changes.
6. Write a one-off script that recomputes `deadline_at` and `evaluate_at` for Edmonton towers' open and scheduled `tower_periods`, using `resolvePeriodWindow` / `computePeriodWindow` on the upgraded runtime. This is the same gap as the "changing timezone does NOT recompute" note in `packages/db/src/towers/towers.ts`.

### Test migration (search `TODO(tzdata-2026c)`)

Once the canary fails, about 30 assertions fail with it, because they hard-code Edmonton's old DST rules. Every one is tagged `TODO(tzdata-2026c)`, and the tag names the recipe to use:

- **[denver]: the test is about DST mechanics** (a gap, an ambiguous time, never late on fall-back, the MDT→MST change). Replace `America/Edmonton` with **`America/Denver`**.
  - Denver has exactly the transitions the old Edmonton rules had: 2026-11-01T08:00Z, 2027-03-14T09:00Z and 2027-11-07T08:00Z, verified with Intl on tzdata 2025b.
  - **Every expected UTC value stays the same.** Only the zone and its constant change; rename `EDM` to something like `MOUNTAIN_DST`.
  - Update comments that say "Edmonton" accordingly.
- **[offset]: the test just uses Edmonton as an ordinary zone.** From 2026-11-01 onward the offset is −06 all year. Winter (formerly MST) instants move one hour earlier in UTC. For example, 22:00 on 2027-11-07 becomes `2027-11-08T04:00:00.000Z` instead of `05:00`.
- **Add a control.** Give the 2.2 zone table in `period-window.test.ts` an Edmonton row that asserts post-2026c behaviour: no DST, the same UTC values as the Regina rows. This protects against a future runtime that regresses to old data.
- **Not affected:** anything before 2026-11-01, including the 2026-03-08 spring-forward, which really happened. October 2026 MDT values are already −06.

Tagged files:

| File                                             | What                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/time/period-window.test.ts` | 2.2 zone table Edmonton rows, the weekly 2027-03-14 case, and the 2026-11-01 `periodInstants` / `resolvePeriodWindow` cases |
| `packages/shared/src/time/wall-clock.test.ts`    | the 2026-11-01 rows (later/earlier, `'forward'`, the `'later'` default)                                                     |
| `packages/shared/src/time/local-date.test.ts`    | the DST-boundaries fall-back test                                                                                           |
| `packages/shared/src/testing/scenarios.test.ts`  | "across the 2026-11-01 fall-back" and `toLocal`                                                                             |
| `packages/db/src/towers/periods/periods.test.ts` | the `FALL_BACK` cases                                                                                                       |

`FACTORY_TIMEZONE` (`testing/factories.ts`) and the dev seed (`packages/db/src/seed/dev.ts`) stay `America/Edmonton`. It is still a valid zone, and those don't assert offsets.

When everything is green on the new runtime, delete `tzdata-canary.test.ts` and this section, and remove the tags.
