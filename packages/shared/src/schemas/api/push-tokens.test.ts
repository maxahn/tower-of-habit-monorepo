import { describe, expect, expectTypeOf, it } from 'vitest';
import { registerPushTokenRequestSchema, type RegisterPushTokenRequest } from '../index.js';

// Mirrors NewPushToken (users/push-tokens/push-tokens.ts) and the
// push_tokens_token_length / push_tokens_token_trimmed checks. userId comes
// from auth.

const BODY = { token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]', platform: 'ios' };

describe('registerPushTokenRequestSchema', () => {
  it.each(['ios', 'android'])('accepts a %s token', (platform) => {
    expect(registerPushTokenRequestSchema.safeParse({ ...BODY, platform }).success).toBe(true);
  });

  it.each(['web', 'IOS', ''])('rejects a platform of %p', (platform) => {
    expect(registerPushTokenRequestSchema.safeParse({ ...BODY, platform }).success).toBe(false);
  });

  it('accepts a token at 512 characters and rejects one past it', () => {
    const at = 'x'.repeat(512);
    expect(registerPushTokenRequestSchema.safeParse({ ...BODY, token: at }).success).toBe(true);
    expect(registerPushTokenRequestSchema.safeParse({ ...BODY, token: `${at}x` }).success).toBe(
      false
    );
  });

  // Rejected, not trimmed: a silently trimmed token is a different token.
  it.each(['', ' abc', 'abc ', '\tabc'])('rejects a token of %p', (token) => {
    expect(registerPushTokenRequestSchema.safeParse({ ...BODY, token }).success).toBe(false);
  });

  it('rejects a client-supplied userId', () => {
    const body = { ...BODY, userId: '3f1c6d32-6a4e-4a9e-bb1f-8f0f5a4f2c11' };
    expect(registerPushTokenRequestSchema.safeParse(body).success).toBe(false);
  });

  it('infers the shared platform union', () => {
    expectTypeOf<RegisterPushTokenRequest>().not.toBeAny();
    expectTypeOf<RegisterPushTokenRequest['platform']>().toEqualTypeOf<'ios' | 'android'>();
  });
});
