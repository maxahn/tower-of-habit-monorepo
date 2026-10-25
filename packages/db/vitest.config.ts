import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests hit a real Postgres (check constraints can't be mocked). Same
// ENV_FILE convention as drizzle.config.ts, defaulting to .env.test.
const envPath = resolve(process.cwd(), '../../', process.env.ENV_FILE ?? '.env.test');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Test files share one database.
    fileParallelism: false,
  },
});
