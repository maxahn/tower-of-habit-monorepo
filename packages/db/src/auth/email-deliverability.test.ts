import { describe, expect, it } from 'vitest';
import { db } from '../test-utils.js';
import {
  clearEmailDeliverability,
  isEmailDeliverable,
  markEmailUndeliverable,
} from './email-deliverability.js';

/*
 * 3.14 email_deliverability — RED phase.
 *
 * Tracks bounced / complained email addresses independently of the users table,
 * since an email can bounce before a user row exists (login codes are sent
 * before account creation).
 */

const freshEmail = () => `bounce.${crypto.randomUUID()}@example.com`;

describe('email deliverability', () => {
  it('markEmailUndeliverable makes isEmailDeliverable return false', async () => {
    const email = freshEmail();
    expect(await isEmailDeliverable(db, email)).toBe(true);

    await markEmailUndeliverable(db, email, 'bounce');

    expect(await isEmailDeliverable(db, email)).toBe(false);
  });

  it('clearEmailDeliverability restores deliverability', async () => {
    const email = freshEmail();
    await markEmailUndeliverable(db, email, 'complaint');
    expect(await isEmailDeliverable(db, email)).toBe(false);

    await clearEmailDeliverability(db, email);

    expect(await isEmailDeliverable(db, email)).toBe(true);
  });

  it('double-mark upserts without error', async () => {
    const email = freshEmail();
    await markEmailUndeliverable(db, email, 'bounce');
    await markEmailUndeliverable(db, email, 'complaint');

    expect(await isEmailDeliverable(db, email)).toBe(false);
  });

  it('clearing a never-marked email is a no-op', async () => {
    const email = freshEmail();
    await clearEmailDeliverability(db, email);
    expect(await isEmailDeliverable(db, email)).toBe(true);
  });
});
