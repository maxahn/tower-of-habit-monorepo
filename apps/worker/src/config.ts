import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(4000),
  TICK_INTERVAL_MS: z.coerce.number().default(30_000),
  TICK_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  NODE_ENV: z.string().default('development'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().default(20_000),
  EXPO_ACCESS_TOKEN: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
});

export type Config = z.infer<typeof schema>;

const result = schema.safeParse(process.env);
if (!result.success) {
  const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Worker config validation failed:\n${issues}`);
}

export const config: Config = result.data;

export function redactedConfig(cfg: Config): Record<string, unknown> {
  let redactedUrl: string;
  try {
    const url = new URL(cfg.DATABASE_URL);
    url.password = '***';
    url.username = url.username ? '***' : '';
    redactedUrl = url.toString();
  } catch {
    redactedUrl = '(invalid URL)';
  }
  return {
    ...cfg,
    DATABASE_URL: redactedUrl,
    ...(cfg.EXPO_ACCESS_TOKEN ? { EXPO_ACCESS_TOKEN: '***' } : {}),
    ...(cfg.RESEND_API_KEY ? { RESEND_API_KEY: '***' } : {}),
  };
}
