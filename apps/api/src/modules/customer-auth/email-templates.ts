import type { EmailOtpPurpose } from './email-otp.service';

/**
 * Transactional email copy. Plain, brand-light HTML (inline styles, no images or links to
 * click: the code is typed into the portal, so a phishing copy has nothing to imitate).
 */

const COPY: Record<EmailOtpPurpose, { subject: string; lead: string }> = {
  signup: {
    subject: 'Your OZZO Safety ID verification code',
    lead: 'Use this code to verify your email and finish setting up your OZZO Safety ID account.',
  },
  'email-change': {
    subject: 'Confirm your new email for OZZO Safety ID',
    lead: 'Use this code to confirm this address as the new sign-in email of your OZZO Safety ID account.',
  },
  'password-reset': {
    subject: 'Your OZZO Safety ID password reset code',
    lead: 'Use this code to reset the password of your OZZO Safety ID account.',
  },
};

const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function emailCodeMessage(
  purpose: EmailOtpPurpose,
  code: string,
  ttlSeconds: number,
): { subject: string; text: string; html: string } {
  const { subject, lead } = COPY[purpose];
  const minutes = Math.round(ttlSeconds / 60);
  const ignore =
    purpose === 'password-reset'
      ? 'If you did not ask to reset your password, ignore this email: your password stays the same.'
      : 'If this was not you, you can ignore this email.';
  const text = [
    lead,
    '',
    `Your code: ${code}`,
    '',
    `It expires in ${minutes} minutes and can be used once. Never share it: OZZO will never ask you for it.`,
    ignore,
    '',
    '— OZZO Helmets',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#F4F4F2;font-family:Helvetica,Arial,sans-serif;color:#1F1A17">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border-radius:12px;overflow:hidden">
<tr><td style="background:#E84A0C;padding:16px 24px;color:#FFFFFF;font-weight:700;font-size:18px">OZZO Safety ID</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${esc(lead)}</p>
<p style="margin:0 0 16px;font-size:34px;font-weight:700;letter-spacing:8px;font-family:'Courier New',monospace">${esc(code)}</p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#5F5A55">It expires in ${minutes} minutes and can be used once. Never share it: OZZO will never ask you for it.</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#5F5A55">${esc(ignore)}</p>
</td></tr></table>
<p style="font-size:12px;color:#8A8580;margin:16px 0 0">OZZO Helmets</p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}
