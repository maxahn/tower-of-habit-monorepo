import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      // Still report while some tests are red.
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      // Test helpers and barrel re-exports would only inflate the numbers.
      exclude: ['src/**/*.test.ts', 'src/testing/**', 'src/**/index.ts'],
      // 2.7: the domain modules (evaluator, time) stay >= 90% lines, and every
      // branch of evaluatePeriod is exercised.
      thresholds: {
        'src/evaluator/**/*.ts': { lines: 90 },
        'src/time/**/*.ts': { lines: 90 },
        'src/evaluator/evaluate.ts': { branches: 100 },
      },
    },
  },
});
