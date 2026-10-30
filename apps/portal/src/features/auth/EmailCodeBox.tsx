import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { EmailCodeSentResponse } from '@helmet/types';
import { Button, Field, Input } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { emailClientProblem, sameEmail } from './email-check';

/**
 * "Send code" → six-digit code input, with a resend countdown. With `verify`, the code is
 * checked right away (sign-up: the parent keeps the returned proof); with `onCode` the typed code
 * is handed to the parent, which sends it with its own request (email change).
 */
export function EmailCodeBox({
  email,
  idPrefix,
  send,
  verify,
  onCode,
  verified = false,
  sendLabel = 'Send verification code',
}: {
  email: string;
  idPrefix: string;
  send: () => Promise<EmailCodeSentResponse>;
  verify?: (code: string) => Promise<void>;
  onCode?: (code: string) => void;
  verified?: boolean;
  sendLabel?: string;
}) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(0);

  // A different address needs a new code.
  const sent = sentTo !== null && sameEmail(sentTo, email);
  useEffect(() => {
    if (sentTo !== null && !sameEmail(sentTo, email)) {
      setSentTo(null);
      setCode('');
      onCode?.('');
    }
  }, [email, sentTo, onCode]);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const sendMut = useMutation({
    mutationFn: send,
    onSuccess: (res) => {
      setSentTo(email);
      setCode('');
      onCode?.('');
      setWait(res.resendIn);
    },
  });
  const verifyMut = useMutation({ mutationFn: (c: string) => verify!(c) });

  if (verified)
    return (
      <p
        className="flex items-center gap-2 text-sm font-medium"
        data-testid={`${idPrefix}-verified`}
      >
        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> Email verified
      </p>
    );

  const invalid = !!emailClientProblem(email);
  return (
    <div
      className="flex flex-col gap-3 rounded-xl bg-canvas-soft p-3"
      data-testid={`${idPrefix}-otp`}
    >
      {!sent ? (
        <>
          <p className="text-sm text-body">
            We’ll email you a 6-digit code to confirm this address.
          </p>
          <InlineError error={sendMut.error} />
          <Button
            type="button"
            variant="subtle"
            disabled={invalid}
            loading={sendMut.isPending}
            onClick={() => sendMut.mutate()}
          >
            {sendLabel}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-body">
            We sent a code to <span className="font-medium text-ink">{email.trim()}</span>. It can
            take a minute; check spam too.
          </p>
          <Field label="6-digit code" htmlFor={`${idPrefix}-code`}>
            <Input
              id={`${idPrefix}-code`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="text-center font-mono text-2xl tracking-[0.4em]"
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                setCode(v);
                onCode?.(v);
              }}
            />
          </Field>
          <InlineError error={verifyMut.error ?? sendMut.error} />
          {verify && (
            <Button
              type="button"
              disabled={code.length !== 6}
              loading={verifyMut.isPending}
              onClick={() => verifyMut.mutate(code)}
            >
              Verify email
            </Button>
          )}
          <button
            type="button"
            className="self-start text-sm font-medium underline underline-offset-4 disabled:no-underline disabled:opacity-60"
            disabled={wait > 0 || sendMut.isPending}
            onClick={() => sendMut.mutate()}
          >
            {wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}
          </button>
        </>
      )}
    </div>
  );
}
