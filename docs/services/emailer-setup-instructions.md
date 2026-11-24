### 1. Resend account + API key

- Sign up at [https://resend.com](https://resend.com/)
- Go to API Keys → Create — copy the key
- Set `RESEND_API_KEY=re_...` in the worker's `.env.dev`

### 2. Sending domain (dedicated subdomain)

- In Resend dashboard → Domains → Add Domain
- Use a subdomain like `auth.towerofhabit.com` or `mail.towerofhabit.com` (the ticket requires a dedicated subdomain so deliverability issues never contaminate the apex)
- Resend gives you DNS records to add: SPF (TXT), DKIM (CNAME x3), and optionally DMARC
- Add them to your DNS provider — verification takes a few minutes to a few hours
- Once verified, set `EMAIL_FROM="Tower of Habit <noreply@auth.towerofhabit.com>"` in `.env.dev`

### 3. Bounce webhook (for the bounce → undeliverable flow)

- In Resend dashboard → Webhooks → Add Webhook
- Endpoint URL: `https://<your-api-domain>/webhooks/resend`
- Events: `email.bounced`, `email.complained`
- Copy the signing secret → set `RESEND_WEBHOOK_SECRET=whsec_...` in the API's `.env.dev`
- Requires `svix` package for signature verification (Resend uses Svix under the hood)

### 4. Test real delivery

- With Resend configured, request a login code via the app — it should arrive in your real inbox within ~10 seconds
- Check email headers for SPF/DKIM pass
- Test on an iPhone to confirm one-tap code entry works (bare code first in subject: `123456 is your Tower code`)

## Testing Strategy

### What's testable locally (no Resend needed)

| What                                       | How                                                                | Where                                              |
| ------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------- |
| Email formatting (code-first subject/body) | Unit test with fake `EmailService`                                 | `apps/worker/src/email.test.ts`                    |
| `deliverLoginEmail` logic                  | Unit test with fake `EmailService`                                 | `apps/worker/src/email.test.ts`                    |
| Job enqueueing from API sender             | Integration test — call sender, query `graphile_worker.jobs` table | `apps/api/src/auth/sender.integration.test.ts`     |
| `send_email` task wiring                   | Integration test — insert job, run task with fake `EmailService`   | `apps/worker/src/email.integration.test.ts`        |
| Bounce webhook marks email undeliverable   | Integration test — POST fake bounce event, check DB                | `apps/api/src/webhooks/resend.integration.test.ts` |
| `requestCode` rejects bounced email        | Integration test — mark email, call requestCode                    | existing auth integration tests                    |
| `AUTH_CODE_LOG` production assertion       | Unit test — pure function                                          | `apps/api/src/auth/sender.test.ts`                 |

### What requires real infrastructure (manual testing)

- Actual email arriving in an inbox (Resend + DNS configured)
- SPF/DKIM passing (check email headers)
- One-tap code entry on iOS/Android (device test)
- Delivery timing (<10 seconds)
- Bounce handling end-to-end (trigger a real bounce)

**Bottom line:** All correctness logic is fully testable locally. Real infrastructure is only needed for the "done when" acceptance criteria (delivery, spam score, one-tap).
