import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Integration tests need Postgres and run under vitest.integration.config.ts.
    exclude: ['src/**/*.integration.test.ts', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      // json-summary feeds scripts/coverage-readme.mjs.
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      // Still report while some tests are red.
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Test helpers would only inflate the numbers.
        'src/testing/**',
        // The composition root wires real Postgres, Redis, env and
        // process.exit; it can't be imported without DATABASE_URL, so it is
        // checked by running the server, not by unit tests. Everything it
        // wires is covered through createApp.
        'src/index.ts',
        // Exercised only by the integration suite (test:integration).
        'src/compose.ts',
      ],
    },
  },
});
