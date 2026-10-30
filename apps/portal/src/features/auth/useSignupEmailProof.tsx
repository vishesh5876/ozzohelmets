import { useState } from 'react';
import type { EmailCodeSentResponse, EmailProofResponse } from '@helmet/types';
import { api } from '../../lib/api';
import { EMAIL_VERIFICATION_ENABLED } from '../../lib/config';
import { EmailCodeBox } from './EmailCodeBox';
import { sameEmail } from './email-check';

/**
 * Sign-up email verification (activation, claims): the code box plus the proof to send with the
 * registration. `problem` is the message to show when submitting without a verified address.
 */
export function useSignupEmailProof(email: string, idPrefix: string) {
  const [proof, setProof] = useState<{ email: string; token: string } | null>(null);
  const verified = !!proof && sameEmail(proof.email, email);
  const box = EMAIL_VERIFICATION_ENABLED ? (
    <EmailCodeBox
      email={email}
      idPrefix={idPrefix}
      verified={verified}
      send={() =>
        api.post<EmailCodeSentResponse>('/customer/auth/email/send-code', { email: email.trim() })
      }
      verify={async (code) => {
        const res = await api.post<EmailProofResponse>('/customer/auth/email/verify-code', {
          email: email.trim(),
          code,
        });
        setProof({ email, token: res.emailProof });
      }}
    />
  ) : null;
  return {
    box,
    token: verified ? proof!.token : undefined,
    problem:
      EMAIL_VERIFICATION_ENABLED && !verified
        ? 'Verify your email with the 6-digit code first.'
        : null,
  };
}
