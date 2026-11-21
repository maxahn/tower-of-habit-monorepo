export interface EmailService {
  sendEmail(params: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ id: string }>;
}

export interface LoginEmailResult {
  resendId: string;
}

export async function deliverLoginEmail(
  emailService: EmailService,
  payload: { email: string; code: string },
  fromAddress: string
): Promise<LoginEmailResult> {
  const subject = `${payload.code} is your Tower code`;
  const text = [
    `${payload.code} is your Tower code`,
    '',
    'Enter this code to sign in. It expires in 10 minutes.',
    '',
    'If you did not request this, ignore this email.',
  ].join('\n');
  const html = [
    `<p>${payload.code} is your Tower code</p>`,
    '<p>Enter this code to sign in. It expires in 10 minutes.</p>',
    '<p style="color:#666;font-size:12px">If you did not request this, ignore this email.</p>',
  ].join('');

  const result = await emailService.sendEmail({
    from: fromAddress,
    to: payload.email,
    subject,
    text,
    html,
  });

  return { resendId: result.id };
}
