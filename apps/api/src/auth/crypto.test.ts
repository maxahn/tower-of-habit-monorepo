import { describe, expect, it } from 'vitest';
import {
  codeMatches,
  generateCode,
  generateSessionToken,
  hashCode,
  hashToken,
  normalizeEmail,
} from './crypto.js';

/*
 * 2.9 crypto. RED until Pass 3 (the functions throw 'not implemented').
 *
 * fast-check is not a dependency of apps/api, so the "property" checks are
 * plain sampling loops over many draws — enough to catch a biased generator, a
 * wrong length, or a broken comparison.
 */

const SIX_DIGITS = /^\d{6}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

describe('generateCode', () => {
  it('is always exactly six decimal digits, zero-padded', () => {
    for (let i = 0; i < 2000; i++) {
      expect(generateCode()).toMatch(SIX_DIGITS);
    }
  });

  it('produces more than one distinct value (not a constant)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateCode());
    expect(seen.size).toBeGreaterThan(1);
  });

  it('can produce low, leading-zero codes (no low-end truncation)', () => {
    // A `% 1_000_000` bug still reaches the low end; a different truncation that
    // dropped sub-100000 values would never emit a leading zero. Over many draws
    // at least one value below 100000 (a leading zero) is overwhelmingly likely.
    let sawLeadingZero = false;
    for (let i = 0; i < 20000 && !sawLeadingZero; i++) {
      if (generateCode().startsWith('0')) sawLeadingZero = true;
    }
    expect(sawLeadingZero).toBe(true);
  });
});

describe('hashCode / hashToken', () => {
  it('hashCode is a deterministic 64-char hex SHA-256 digest', () => {
    const a = hashCode('123456');
    expect(a).toMatch(HEX_64);
    expect(hashCode('123456')).toBe(a);
    expect(hashCode('123457')).not.toBe(a);
  });

  it('hashToken is a deterministic 64-char hex SHA-256 digest', () => {
    const a = hashToken('some-token');
    expect(a).toMatch(HEX_64);
    expect(hashToken('some-token')).toBe(a);
    expect(hashToken('other-token')).not.toBe(a);
  });
});

describe('generateSessionToken', () => {
  it('is base64url encoding 32 bytes', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet, no padding
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('is unique across draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateSessionToken());
    expect(seen.size).toBe(1000);
  });
});

describe('codeMatches', () => {
  it('is true for the matching code and false otherwise', () => {
    const stored = hashCode('424242');
    expect(codeMatches('424242', stored)).toBe(true);
    expect(codeMatches('424243', stored)).toBe(false);
    expect(codeMatches('000000', stored)).toBe(false);
  });
  // Constant-time behaviour (timingSafeEqual) is not asserted here — timing is
  // not reliably unit-testable; correctness is.
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Me@Example.COM ')).toBe('me@example.com');
  });

  it('is idempotent', () => {
    const once = normalizeEmail('  User+Tag@Mail.Co ');
    expect(normalizeEmail(once)).toBe(once);
  });

  it('does not strip dots or plus-tags (those are provider-specific)', () => {
    expect(normalizeEmail('first.last+promo@gmail.com')).toBe('first.last+promo@gmail.com');
  });
});
