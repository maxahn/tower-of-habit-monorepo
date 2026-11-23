Status: done
Type: task
Priority: blocker (before 5.7)

# Write red tests proving height-reset bug, then fix

## Task

1. **Red tests (evaluator unit):** Add test cases to `packages/shared/src/evaluator/evaluate.test.ts`:
   - Tower survives 5 periods (height=5, currentStreak=5), then collapses → assert height stays 5, currentStreak resets to 0
   - Tower survives 3, collapses, survives 2 → assert height=5 (cumulative), currentStreak=2
   - Base block created on collapse should record blockHeight = currentStreak (the run height), not cumulative height

2. **Red tests (DB integration):** Add test to `packages/db/src/towers/towers.test.ts` (or appropriate integration test):
   - Call incrementHeight 3 times, then collapseRun → assert height=3, currentStreak=0
   - Increment again → assert height=4, currentStreak=1

3. **Fix:**
   - `packages/db/src/towers/towers.ts` collapseRun: only reset currentStreak, leave height
   - `packages/shared/src/evaluator/evaluate.ts`: use currentStreak (not height) for baseBlock.blockHeight
   - Add `currentStreak` to the evaluator's `EvaluationInput.tower` type if not present

4. **Verify:** all existing evaluator tests still green
