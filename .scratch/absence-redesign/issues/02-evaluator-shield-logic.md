Status: open
Type: task
Blocked by: 01

# Evaluator: earn and consume streak shields

1. Write red tests:
   - Period survived while a member is voluntarily dormant → shieldCount increments (up to 3)
   - Period survived, no one absent → shieldCount unchanged
   - Collapse with shieldCount > 0 → shield consumed, period treated as survived, shieldCount decremented
   - Collapse with shieldCount = 0 → normal collapse behavior
   - Shield consumption still increments consecutiveMisses for the member who missed
2. Update `evaluatePeriod` to check for voluntary dormant members and return shield-earn signal
3. Update collapse path to check shieldCount and return shield-consumed signal instead of collapse
4. Update DB functions to increment/decrement shieldCount
