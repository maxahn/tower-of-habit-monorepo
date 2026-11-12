import type { z } from 'zod';
import type { PushPlatform } from '../enums.js';
import { notImplemented } from '../todo.js';

/*
 * Push token registration. Mirrors NewPushToken in @tower-of-habit/db
 * (users/push-tokens/push-tokens.ts). userId comes from auth.
 *
 * TODO(2.1): implement, then replace the hand-written type with z.infer.
 * Rules (tests: ./push-tokens.test.ts):
 *   - strict: userId rejected;
 *   - platform: pushPlatformSchema;
 *   - token: 1..512 chars, no leading/trailing whitespace — REJECT, don't trim
 *     (push_tokens_token_length / push_tokens_token_trimmed).
 */

export type RegisterPushTokenRequest = { token: string; platform: PushPlatform };

export const registerPushTokenRequestSchema = notImplemented<z.ZodType<RegisterPushTokenRequest>>(
  'registerPushTokenRequestSchema'
);
