import { Resend } from 'resend';
import type { EmailService } from './email.js';

export function createResendEmailService(apiKey: string): EmailService {
  const resend = new Resend(apiKey);

  return {
    async sendEmail(params) {
      const result = await resend.emails.send({
        from: params.from,
        to: params.to,
        subject: params.subject,
        text: params.text,
        html: params.html,
      });
      if (result.error) {
        throw new Error(`Resend error: ${result.error.message}`);
      }
      return { id: result.data!.id };
    },
  };
}
