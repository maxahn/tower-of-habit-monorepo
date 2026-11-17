import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Server-side crypto for email-OTP auth (2.9). Thin wrappers over node:crypto
 * (OpenSSL under the hood) — not home-grown primitives. Lives in apps/api
 * because node:crypto is unavailable in @tower-of-habit/shared (the
 * Hermes/mobile ESLint firewall bans it there).
 */

/** Number of decimal digits in a login code. */
export const CODE_DIGITS = 6;
const CODE_UPPER_BOUND = 1_000_000; // 10 ** CODE_DIGITS

/**
 * A fresh login code: six decimal digits, zero-padded. randomInt is CSPRNG-
 * backed and rejection-samples internally, so the distribution over
 * [0, 1_000_000) is uniform — NOT `randomBytes % 1_000_000`, which biases low.
 */
export function generateCode(): string {
  return String(randomInt(CODE_UPPER_BOUND)).padStart(CODE_DIGITS, '0');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** SHA-256 hex digest of a login code, for storage and constant-time compare. */
export function hashCode(code: string): string {
  return sha256Hex(code);
}

/** SHA-256 hex digest of a session token, the only form ever persisted. */
export function hashToken(token: string): string {
  return sha256Hex(token);
}

/**
 * SHA-256 hex digest of a normalised email, for keys stored outside Postgres
 * (rate-limit counters in Redis), so no raw address sits in Redis.
 */
export function hashEmail(email: string): string {
  return sha256Hex(email);
}

/** A session token: 32 bytes of CSPRNG output, base64url-encoded (no padding). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Whether a submitted code matches a stored SHA-256 hex digest. Hashes the
 * submission, then compares the two 32-byte digest buffers in constant time.
 * Comparing the digests (not the raw codes) keeps both operands equal-length,
 * so timingSafeEqual never throws and nothing leaks via length.
 */
export function codeMatches(submitted: string, storedHex: string): boolean {
  const a = Buffer.from(hashCode(submitted), 'hex');
  const b = Buffer.from(storedHex, 'hex');
  if (a.length !== b.length) return false; // malformed stored hash
  return timingSafeEqual(a, b);
}

/**
 * Normalises an email for storage and comparison: trim + lowercase, nothing
 * else. No dot-stripping or plus-tag removal — those are provider-specific and
 * wrong as often as right. Idempotent with the shared `email` schema primitive.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
