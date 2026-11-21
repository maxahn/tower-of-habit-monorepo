import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  meResponseSchema,
  meSessionsResponseSchema,
  updateMeRequestSchema,
  type MeResponse,
  type UpdateMeRequest,
} from '../index.js';

/*
 * 2.11: GET /me, PATCH /me, GET /me/sessions. Email is NOT patchable in Phase
 * 2: it is the login credential, so changing it needs a verify-new-address
 * flow and therefore email delivery (Phase 3).
 */

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'me@example.com',
  timezone: 'America/Edmonton',
  displayName: 'Max',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('updateMeRequestSchema', () => {
  it('accepts a display name and/or a timezone', () => {
    expect(updateMeRequestSchema.safeParse({ displayName: 'Max' }).success).toBe(true);
    expect(updateMeRequestSchema.safeParse({ timezone: 'Asia/Kolkata' }).success).toBe(true);
    expect(
      updateMeRequestSchema.safeParse({ displayName: 'Max', timezone: 'Asia/Kolkata' }).success
    ).toBe(true);
  });

  it('accepts clearing the display name with null', () => {
    expect(updateMeRequestSchema.safeParse({ displayName: null }).success).toBe(true);
  });

  it('rejects an unknown IANA zone rather than falling back', () => {
    for (const timezone of ['PST', 'Mars/Olympus', '', 'utc']) {
      expect(updateMeRequestSchema.safeParse({ timezone }).success).toBe(false);
    }
  });

  it('rejects an email change and any other unknown key', () => {
    expect(updateMeRequestSchema.safeParse({ email: 'new@example.com' }).success).toBe(false);
    expect(updateMeRequestSchema.safeParse({ id: USER.id }).success).toBe(false);
  });

  it('rejects an empty or over-long display name', () => {
    expect(updateMeRequestSchema.safeParse({ displayName: '' }).success).toBe(false);
    expect(updateMeRequestSchema.safeParse({ displayName: 'x'.repeat(61) }).success).toBe(false);
  });

  it('infers the request type', () => {
    expectTypeOf<UpdateMeRequest>().toEqualTypeOf<{
      displayName?: string | null | undefined;
      timezone?: string | undefined;
    }>();
  });
});

describe('meResponseSchema', () => {
  it('is the session user plus a count of active towers', () => {
    const r = meResponseSchema.safeParse({ user: USER, activeTowerCount: 2 });
    expect(r.success).toBe(true);
    expectTypeOf<MeResponse['activeTowerCount']>().toEqualTypeOf<number>();
  });

  it('rejects a negative count', () => {
    expect(meResponseSchema.safeParse({ user: USER, activeTowerCount: -1 }).success).toBe(false);
  });
});

describe('meSessionsResponseSchema', () => {
  const SESSION = {
    id: '22222222-2222-4222-8222-222222222222',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-02T00:00:00.000Z',
    expiresAt: '2026-04-01T00:00:00.000Z',
    userAgent: 'Expo/1.0',
    current: true,
  };

  it('lists sessions with their timestamps, user agent and the current flag', () => {
    expect(meSessionsResponseSchema.safeParse({ sessions: [SESSION] }).success).toBe(true);
    expect(
      meSessionsResponseSchema.safeParse({ sessions: [{ ...SESSION, userAgent: null }] }).success
    ).toBe(true);
  });

  it('never carries a token or token hash', () => {
    expect(
      meSessionsResponseSchema.safeParse({ sessions: [{ ...SESSION, tokenHash: 'abc' }] }).success
    ).toBe(false);
  });
});
