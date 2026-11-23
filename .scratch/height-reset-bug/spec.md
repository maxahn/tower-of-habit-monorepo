# Bug: tower.height resets on collapse (should be cumulative)

## Summary

`tower.height` and `tower.currentStreak` are both reset to 0 on collapse, making them redundant. The intended semantics are:

- **`height`** — total cumulative height across all runs (never resets)
- **`currentStreak`** — current run height (resets on collapse)

## Current behavior

In `packages/db/src/towers/towers.ts`:

- **Line 133 (survived):** `height + 1`, `currentStreak + 1` — both increment ✓
- **Line 144 (collapse):** `height = 0`, `currentStreak = 0` — both reset ✗

`height` should not reset on collapse. It should keep its value and continue accumulating in future survived periods.

## Expected behavior

- On survived period: `height + 1`, `currentStreak + 1` (unchanged)
- On collapse: `currentStreak = 0`, **height unchanged**

## Affected code

- `packages/db/src/towers/towers.ts` — `collapseRun` function (line ~144)
- `packages/shared/src/evaluator/evaluate.ts` — base block still uses `tower.height` for `blockHeight`, which is correct (it captures the run height at collapse time, but this should use `currentStreak` after the fix since `height` will be cumulative)

## Fix plan

1. Write red tests first (evaluator + DB integration) proving the bug
2. Fix `collapseRun` to only reset `currentStreak`
3. Fix `baseBlock.blockHeight` to use `currentStreak` (the run height) instead of `height` (now cumulative)
4. Verify existing evaluator tests still pass

## Priority

Must fix before or during 5.7 (tower home displays both run height and total height).
