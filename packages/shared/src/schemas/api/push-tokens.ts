import { z } from 'zod';
import { pushPlatformSchema } from '../enums.js';

/*
 * Push token registration. Mirrors NewPushToken in @tower-of-habit/db
 * (users/push-tokens/push-tokens.ts). userId comes from the session.
 */

export const registerPushTokenRequestSchema = z.strictObject({
  // push_tokens_token_length / push_tokens_token_trimmed. Rejected rather than
  // trimmed: a silently trimmed token is a different token.
  token: z
    .string()
    .min(1)
    .max(512)
    .refine((s) => s === s.trim(), { message: 'token must not have surrounding whitespace' }),
  platform: pushPlatformSchema,
});
export type RegisterPushTokenRequest = z.infer<typeof registerPushTokenRequestSchema>;
