import { describe, expect, it } from 'vitest';
import { createMemoryLogger } from '../testing/harness.js';
import { assertAuthCodeLogDisabled, createLogLoginCodeSender } from './sender.js';

/*
 * 2.9 log sender. The single place a login code may ever appear in a log, and
 * only when AUTH_CODE_LOG is true. GREEN from Pass 1 (the sender is real).
 */

const CODE = '428913';
const EMAIL = 'me@example.com';

describe('createLogLoginCodeSender', () => {
  it('logs the code when logCode is true', async () => {
    const logger = createMemoryLogger();
    await createLogLoginCodeSender(logger, { logCode: true }).sendLoginCode(EMAIL, CODE);

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: 'info', email: EMAIL, code: CODE });
  });

  it('never logs the code when logCode is false', async () => {
    const logger = createMemoryLogger();
    await createLogLoginCodeSender(logger, { logCode: false }).sendLoginCode(EMAIL, CODE);

    // It still records that a code was sent, with the email but not the code.
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: 'info', email: EMAIL });
    const serialized = JSON.stringify(logger.lines);
    expect(serialized).not.toContain(CODE);
  });
});

/*
 * 3.14: AUTH_CODE_LOG production assertion.
 *
 * Extracted to a testable function so the invariant is proven without starting
 * the full API process.
 */
describe('assertAuthCodeLogDisabled', () => {
  it('throws when AUTH_CODE_LOG is true in production', () => {
    expect(() => assertAuthCodeLogDisabled({ production: true, authCodeLog: true })).toThrow(
      'AUTH_CODE_LOG'
    );
  });

  it('allows AUTH_CODE_LOG=true in non-production', () => {
    expect(() => assertAuthCodeLogDisabled({ production: false, authCodeLog: true })).not.toThrow();
  });

  it('allows AUTH_CODE_LOG=false in production', () => {
    expect(() => assertAuthCodeLogDisabled({ production: true, authCodeLog: false })).not.toThrow();
  });
});
