Status: open
Type: task

# Add shieldCount to towers, remove voluntaryAbsenceDaysUsed from memberships

1. Add `shieldCount` integer column (default 0) to `towers` table with check constraint `shieldCount >= 0 AND shieldCount <= 3`
2. Remove `voluntaryAbsenceDaysUsed` column from `memberships` table
3. Generate and apply migration
4. Update `towerActiveResponseSchema` to include `shieldCount`
5. Update seed data if needed
