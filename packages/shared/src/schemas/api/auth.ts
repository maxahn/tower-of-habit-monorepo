import { z } from 'zod';
import { email, ianaTimeZone, timestamp, uuid } from './common.js';

/*
 * Email-OTP authentication (2.9). Request/response contracts for the four auth
 * endpoints. No passwords appear anywhere in this surface.
 */

/** POST /auth/request-code. Always answered 202 with an empty body. */
export const requestCodeRequestSchema = z.strictObject({
  email,
});
export type RequestCodeRequest = z.infer<typeof requestCodeRequestSchema>;

/**
 * POST /auth/verify-code. The code is exactly six digits (the generator
 * zero-pads). timezone is validated against the IANA database and defaults to
 * UTC when omitted; it is used only when this verification creates the user.
 */
export const verifyCodeRequestSchema = z.strictObject({
  email,
  code: z.string().regex(/^\d{6}$/, 'code must be six digits'),
  timezone: ianaTimeZone.default('UTC'),
});
export type VerifyCodeRequest = z.infer<typeof verifyCodeRequestSchema>;

/** The authenticated user as returned by verify-code. displayName may be null. */
export const sessionUserSchema = z.strictObject({
  id: uuid,
  email: z.string(),
  timezone: z.string(),
  displayName: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/** POST /auth/verify-code success body: the raw bearer token plus the user. */
export const verifyCodeResponseSchema = z.strictObject({
  token: z.string(),
  user: sessionUserSchema,
});
export type VerifyCodeResponse = z.infer<typeof verifyCodeResponseSchema>;
