import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.expo/**", "**/node_modules/**"] },
  ...tseslint.configs.recommended,
  // The mobile firewall.
  {
    files: ["apps/mobile/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tower-of-habit/db", "@tower-of-habit/db/*"],
              message:
                "Mobile must not import the database package — Metro will try to bundle pg.",
            },
            {
              group: ["@tower-of-habit/api", "@tower-of-habit/worker"],
              message: "Server apps are not importable from mobile.",
            },
            {
              group: [
                "drizzle-orm",
                "drizzle-orm/*",
                "pg",
                "postgres",
                "ioredis",
                "bullmq",
              ],
              message: "Server-only dependency.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@tower-of-habit/db",
                "pg",
                "postgres",
                "drizzle-orm",
                "@prisma/*",
              ],
              message:
                "The evaluator is pure. No database access in @tower-of-habit/shared.",
            },
            {
              group: ["node:*", "fs", "path", "crypto"],
              message: "No Node built-ins — this package runs in Hermes too.",
            },
          ],
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Date",
          property: "now",
          message: "Pass the evaluation instant in as a parameter.",
        },
        {
          object: "Math",
          property: "random",
          message:
            "Evaluator must be deterministic. Inject randomness if you need it.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "new Date() reads the system clock. Pass the instant in.",
        },
      ],
    },
  },
);
