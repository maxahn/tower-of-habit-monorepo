import { config, configs } from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default config(
  { ignores: ['**/dist/**', '**/.expo/**', '**/node_modules/**', '**/coverage/**'] },
  ...configs.recommended,
  // The mobile firewall.
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tower-of-habit/db', '@tower-of-habit/db/*'],
              message: 'Mobile must not import the database package — Metro will try to bundle pg.',
            },
            {
              group: ['@tower-of-habit/api', '@tower-of-habit/worker'],
              message: 'Server apps are not importable from mobile.',
            },
            {
              group: ['drizzle-orm', 'drizzle-orm/*', 'pg', 'postgres', 'ioredis', 'bullmq'],
              message: 'Server-only dependency.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tower-of-habit/db', 'pg', 'postgres', 'drizzle-orm', '@prisma/*'],
              message: 'The evaluator is pure. No database access in @tower-of-habit/shared.',
            },
            {
              group: ['node:*', 'fs', 'path', 'crypto'],
              message: 'No Node built-ins — this package runs in Hermes too.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'Pass the evaluation instant in as a parameter.',
        },
        {
          object: 'Math',
          property: 'random',
          message: 'Evaluator must be deterministic. Inject randomness if you need it.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'new Date() reads the system clock. Pass the instant in.',
        },
      ],
    },
  },
  // Packaging tests (build output, consumer compile) shell out and read files,
  // so they get Node built-ins back. They still may not touch the database.
  {
    files: ['packages/shared/test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tower-of-habit/db', 'pg', 'postgres', 'drizzle-orm', '@prisma/*'],
              message: 'No database access in @tower-of-habit/shared, tests included.',
            },
          ],
        },
      ],
    },
  },
  // The deterministic clock (1.11): domain code takes `now` as a parameter so
  // time-travel tests (3.16) never mock the system clock. Tests, the test db
  // handle and schema files ($onUpdate bookkeeping) are exempt; so is the dev
  // seed, which is the edge that reads the real clock and passes it in.
  {
    files: ['packages/db/src/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      'packages/db/src/test-utils.ts',
      'packages/db/src/**/schema.ts',
      'packages/db/src/seed/**',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'Take `now: Date` as a parameter instead.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'new Date() reads the system clock. Take `now: Date` as a parameter.',
        },
      ],
    },
  },
  // 2.10: handlers never read the clock. `now` is captured once per request by
  // the clock middleware (context.ts) and passed to every service and
  // evaluator call, so a request is reproducible and the test clock works.
  // Exempt: tests and test helpers, the composition root, the logger's line
  // timestamp, and context.ts itself (the one read per request).
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      'apps/api/src/testing/**',
      'apps/api/src/**/testing.ts',
      'apps/api/src/index.ts',
      'apps/api/src/logger.ts',
      'apps/api/src/context.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'Read the request instant from ctxOf(c).now / withTx (2.10).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'new Date() reads the system clock. Use ctxOf(c).now / withTx (2.10).',
        },
      ],
    },
  },
  {
    files: ['**/metro.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  eslintConfigPrettier
);
