import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import type { CustomerLoginResponse, OtpRequestResponse } from '@helmet/types';
import { Button, Field, Input } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { api } from '../../lib/api';

interface PhoneOtpFormProps {
  onVerified: (session: CustomerLoginResponse) => void;
  submitLabel?: string;
}

/** Two-step mobile verification: number → 6-digit code. Used by sign-in and activation. */
export function PhoneOtpForm({
  onVerified,
  submitLabel = 'Verify and continue',
}: PhoneOtpFormProps) {
  const [mobile, setMobile] = useState('');
  const [sent, setSent] = useState<OtpRequestResponse | null>(null);
  const [otp, setOtp] = useState('');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const request = useMutation({
    mutationFn: () => api.post<OtpRequestResponse>('/customer/auth/otp/request', { mobile }),
    onSuccess: (res) => {
      setSent(res);
      setOtp('');
      setCooldown(res.resendAfter);
    },
  });
  const verify = useMutation({
    mutationFn: () =>
      api.post<CustomerLoginResponse>('/customer/auth/otp/verify', {
        mobile: sent?.mobile ?? mobile,
        otp,
      }),
    onSuccess: onVerified,
  });

  if (!sent) {
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          request.mutate();
        }}
      >
        <Field
          label="Mobile number"
          htmlFor="mobile"
          hint="We’ll text you a 6-digit code. Include your country code if outside India."
        >
          <Input
            id="mobile"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+91 98765 43210"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            required
          />
        </Field>
        <InlineError error={request.error} />
        <Button
          type="submit"
          size="lg"
          loading={request.isPending}
          disabled={mobile.trim().length < 6}
        >
          Send code
        </Button>
      </form>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        verify.mutate();
      }}
    >
      <p className="text-body">
        Code sent to <span className="font-medium text-ink">{sent.mobile}</span>.{' '}
        <button
          type="button"
          className="font-medium underline underline-offset-4"
          onClick={() => setSent(null)}
        >
          Change
        </button>
      </p>
      {sent.devOtp && (
        <p
          className="rounded-md border border-dashed border-hairline-mid/40 bg-canvas-soft px-4 py-3 text-sm"
          data-testid="dev-otp"
        >
          Development only — your code is <strong className="font-mono">{sent.devOtp}</strong>
        </p>
      )}
      <Field label="6-digit code" htmlFor="otp">
        <Input
          id="otp"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          className="text-center font-mono text-2xl tracking-[0.5em]"
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
          autoFocus
          required
        />
      </Field>
      <InlineError error={verify.error ?? request.error} />
      <Button type="submit" size="lg" loading={verify.isPending} disabled={otp.length !== 6}>
        {submitLabel}
      </Button>
      <Button
        variant="ghost"
        disabled={cooldown > 0 || request.isPending}
        onClick={() => request.mutate()}
      >
        {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
      </Button>
    </form>
  );
}
