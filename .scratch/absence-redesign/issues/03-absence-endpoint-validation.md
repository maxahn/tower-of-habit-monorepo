Status: open
Type: task
Blocked by: 01

# Update absence endpoint: remove budget, add advance-declaration rule

1. Remove `annual_budget_exceeded` validation from `POST /towers/:id/absence`
2. Add validation: `from` date must be >= next period's start date (1 full period in advance)
3. Keep 14-day max per single absence
4. Keep "one active absence at a time" check
5. Update tests
