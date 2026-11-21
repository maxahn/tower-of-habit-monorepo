import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// 2.20: integration tests hit the real Postgres from Compose. Same ENV_FILE
// convention as packages/db, defaulting to .env.test. The db client throws on
// import without DATABASE_URL, so the env must be loaded here, before any
// test module imports it.
const envPath = resolve(process.cwd(), '../../', process.env.ENV_FILE ?? '.env.test');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    // Test files share one database and truncate it between tests.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
