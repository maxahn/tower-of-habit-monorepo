import { db } from '@tower-of-habit/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { useIntegrationApp } from '../testing/integration.js';

/*
 * 3.14: Email deliverability gate on request-code — RED phase.
 *
 * When an email address has previously bounced (marked in email_deliverability),
 * requestCode should reject the request with 422 so the user knows why no code
 * is arriving. The stub service does not check deliverability, so this FAILS.
 */

const it_ = useIntegrationApp();

describe('request-code deliverability', () => {
  it('rejects request-code for a bounced email', async () => {
    const email = 'bounced@example.com';

    // Seed the bounce directly (the DB function is a stub in red phase, but we
    // also insert via raw SQL so the test proves the SERVICE checks).
    await db.execute(
      sql`INSERT INTO email_deliverability (email, reason) VALUES (${email}, 'bounce') ON CONFLICT DO NOTHING`
    );

    const res = await it_.request('/v1/auth/request-code', {
      method: 'POST',
      json: { email },
    });

    // Green: 422 with error code 'email_undeliverable'.
    // Red: 202 because the service does not check.
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('email_undeliverable');
  });

  it('allows request-code for a non-bounced email', async () => {
    const res = await it_.request('/v1/auth/request-code', {
      method: 'POST',
      json: { email: 'fresh@example.com' },
    });
    expect(res.status).toBe(202);
  });
});
