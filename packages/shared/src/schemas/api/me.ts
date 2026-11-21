import { z } from 'zod';
import { sessionUserSchema } from './auth.js';
import { displayText, ianaTimeZone, nonNegativeInt, timestamp, uuid } from './common.js';

/*
 * 2.11: the profile endpoints. Email is deliberately absent from the patch:
 * it is the login credential, and changing it needs a verify-new-address flow
 * (Phase 3). The patch is strict so an email (or anything else) sent along is
 * rejected, not silently dropped.
 */

/** PATCH /me. Both fields optional; displayName null clears it. */
export const updateMeRequestSchema = z.strictObject({
  displayName: displayText.nullable().optional(),
  // Validated against the IANA database; an unknown zone is 400, never a fallback.
  timezone: ianaTimeZone.optional(),
});
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;

/** GET /me and PATCH /me: the user plus a count of towers they are active in. */
export const meResponseSchema = z.strictObject({
  user: sessionUserSchema,
  activeTowerCount: nonNegativeInt,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** One live session as GET /me/sessions lists it. No token, no hash, ever. */
export const meSessionSchema = z.strictObject({
  id: uuid,
  createdAt: timestamp,
  lastSeenAt: timestamp,
  expiresAt: timestamp,
  userAgent: z.string().nullable(),
  /** The session the request was made with. */
  current: z.boolean(),
});
export type MeSession = z.infer<typeof meSessionSchema>;

export const meSessionsResponseSchema = z.strictObject({
  sessions: z.array(meSessionSchema),
});
export type MeSessionsResponse = z.infer<typeof meSessionsResponseSchema>;
