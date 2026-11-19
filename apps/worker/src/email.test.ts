import { describe, expect, it, vi } from 'vitest';
import { deliverLoginEmail, type EmailService } from './email.js';

/*
 * 3.14: Email delivery for login codes — RED phase.
 *
 * Tests assert the email format spec from the ticket:
 *   - Bare code first in subject, unpunctuated: "123456 is your Tower code"
 *   - Same in the text and HTML bodies
 *   - EmailService.sendEmail called with the right to/from/subject
 *
 * The stub returns { resendId: '' } and never calls the service, so these FAIL.
 */

function fakeEmailService(): EmailService & { calls: Parameters<EmailService['sendEmail']>[] } {
  const calls: Parameters<EmailService['sendEmail']>[] = [];
  return {
    calls,
    sendEmail: vi.fn(async (params) => {
      calls.push([params]);
      return { id: 'fake-resend-id' };
    }),
  };
}

describe('deliverLoginEmail', () => {
  const FROM = 'Tower of Habit <noreply@auth.example.com>';

  it('calls emailService.sendEmail with correct to and from', async () => {
    const svc = fakeEmailService();
    await deliverLoginEmail(svc, { email: 'alice@example.com', code: '123456' }, FROM);

    expect(svc.sendEmail).toHaveBeenCalledOnce();
    const params = svc.calls[0]![0];
    expect(params.to).toBe('alice@example.com');
    expect(params.from).toBe(FROM);
  });

  it('subject starts with the bare code unpunctuated', async () => {
    const svc = fakeEmailService();
    await deliverLoginEmail(svc, { email: 'alice@example.com', code: '789012' }, FROM);

    const params = svc.calls[0]![0];
    expect(params.subject).toBe('789012 is your Tower code');
  });

  it('text body starts with the bare code', async () => {
    const svc = fakeEmailService();
    await deliverLoginEmail(svc, { email: 'alice@example.com', code: '345678' }, FROM);

    const params = svc.calls[0]![0];
    expect(params.text).toMatch(/^345678 is your Tower code/);
  });

  it('html body contains the code', async () => {
    const svc = fakeEmailService();
    await deliverLoginEmail(svc, { email: 'alice@example.com', code: '901234' }, FROM);

    const params = svc.calls[0]![0];
    expect(params.html).toContain('901234');
  });
});
