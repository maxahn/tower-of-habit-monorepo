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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _emailService: EmailService,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _payload: { email: string; code: string },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _fromAddress: string
): Promise<LoginEmailResult> {
  return { resendId: '' }; // stub — red phase
}
