import type { Db } from '@tower-of-habit/db';
import type { Logger } from '../logger.js';

/**
 * Delivers a login code to an email address. One method, so Phase 3 can swap a
 * real email provider in without touching the handler or the service.
 */
export interface LoginCodeSender {
  sendLoginCode(email: string, code: string): Promise<void>;
}

/**
 * The Phase-2 sender: there is no email provider yet, so it writes to the
 * application log.
 *
 * The code is logged ONLY when `logCode` is true (AUTH_CODE_LOG, which the
 * composition root asserts false in production). This is the single place in the
 * system where a code may ever appear in a log — a field allowlist, not a
 * denylist: no other call site constructs a log line that contains a code, so a
 * code can only be logged here, on purpose. When `logCode` is false the sender
 * still records that a code was sent, with the email but never the code.
 */
export function assertAuthCodeLogDisabled(opts: {
  production: boolean;
  authCodeLog: boolean;
}): void {
  if (opts.production && opts.authCodeLog) {
    throw new Error('AUTH_CODE_LOG must not be true when NODE_ENV=production');
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createEmailLoginCodeSender(db: Db): LoginCodeSender {
  return {
    async sendLoginCode() {
      // stub — red phase
    },
  };
}

export function createLogLoginCodeSender(
  logger: Logger,
  opts: { logCode: boolean }
): LoginCodeSender {
  return {
    async sendLoginCode(email, code) {
      if (opts.logCode) {
        logger.info({ email, code }, 'login code (AUTH_CODE_LOG)');
      } else {
        logger.info({ email }, 'login code sent');
      }
    },
  };
}
