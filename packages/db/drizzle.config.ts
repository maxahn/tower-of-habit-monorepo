import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// Host-run tooling only (generate / migrate / studio). In CI/prod, DATABASE_URL
// is injected directly into the process env and this is a no-op.
const envLocal = resolve(process.cwd(), "../../.env.local");
if (existsSync(envLocal)) {
  process.loadEnvFile(envLocal);
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local at the repo root " +
      "and fill it in, or export DATABASE_URL before running drizzle-kit.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
