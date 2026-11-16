/**
 * Server-side crypto for email-OTP auth (2.9). Lives in apps/api because
 * node:crypto is unavailable in @tower-of-habit/shared (the Hermes/mobile ESLint
 * firewall bans it there).
 *
 * NOTE(2.9, Pass 1): signatures only — the implementations land in Pass 3, and
 * the crypto.test.ts suite is red until then. The `void` guards mark the
 * parameters as deliberately unused while the bodies are stubs.
 */

/** Number of decimal digits in a login code. */
export const CODE_DIGITS = 6;

/**
 * A fresh login code: `CODE_DIGITS` decimal digits, zero-padded, drawn from a
 * CSPRNG with rejection sampling so every value is equally likely. MUST NOT use
 * `rand % 1_000_000`, which biases the low end.
 */
export function generateCode(): string {
  throw new Error('not implemented');
}

/** SHA-256 hex digest of a login code, for storage and constant-time compare. */
export function hashCode(code: string): string {
  void code;
  throw new Error('not implemented');
}

/** SHA-256 hex digest of a session token, the only form ever persisted. */
export function hashToken(token: string): string {
  void token;
  throw new Error('not implemented');
}

/** A session token: 32 bytes of CSPRNG output, base64url-encoded. */
export function generateSessionToken(): string {
  throw new Error('not implemented');
}

/**
 * Whether a submitted code matches a stored SHA-256 hex digest, compared in
 * constant time (hash the submission, then timingSafeEqual the two digests).
 */
export function codeMatches(submitted: string, storedHex: string): boolean {
  void [submitted, storedHex];
  throw new Error('not implemented');
}

/**
 * Normalises an email for storage and comparison: trim + lowercase, nothing
 * else. No dot-stripping or plus-tag removal — those are provider-specific and
 * wrong as often as right.
 */
export function normalizeEmail(raw: string): string {
  void raw;
  throw new Error('not implemented');
}
