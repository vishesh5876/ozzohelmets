import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  type CustomerRecoverResponse,
  type CustomerResetPasswordResponse,
  type EmailCodeSentResponse,
  parseAccountIdentifier,
} from '@helmet/types';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { SiteFrame } from '../../pages/SiteFrame';
import { EmailCodeBox } from './EmailCodeBox';
import { EmailField } from './EmailField';
import { emailClientProblem } from './email-check';
import { PasswordFields } from './PasswordFields';
import { passwordClientProblem, type PasswordValue } from './password-check';
import { RecoveryCodeNotice } from './RecoveryCodeNotice';

type Step = 'email' | 'verify' | 'reset' | 'code';

/**
 * Forgot password: a 6-digit code emailed to the account address (default), or — without the
 * mailbox — email / Customer ID / Helmet ID + Recovery Code. Then a new password and a new
 * Recovery Code (shown once).
 */
export function RecoverPage() {
  const navigate = useNavigate();
  const { signIn, restored } = useCustomerAuth();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [helmetCode, setHelmetCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState('');
  const [pw, setPw] = useState<PasswordValue>({ password: '', confirm: '' });
  const [pwError, setPwError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState('');

  const verify = useMutation({
    mutationFn: (code: string) =>
      api.post<CustomerRecoverResponse>('/customer/auth/recover', {
        identifier: code,
        recoveryCode,
      }),
    onSuccess: (res) => {
      setResetToken(res.resetToken);
      setRecoveryCode('');
      setStep('reset');
    },
  });
  const verifyEmail = useMutation({
    mutationFn: () =>
      api.post<CustomerRecoverResponse>('/customer/auth/recover/email/verify', {
        email: email.trim(),
        code: emailCode,
      }),
    onSuccess: (res) => {
      setResetToken(res.resetToken);
      setEmailCode('');
      setStep('reset');
    },
  });
  const reset = useMutation({
    mutationFn: async () => {
      await restored();
      return api.post<CustomerResetPasswordResponse>('/customer/auth/reset-password', {
        resetToken,
        newPassword: pw.password,
      });
    },
    onSuccess: (res) => {
      signIn(res);
      setNewCode(res.recoveryCode);
      setPw({ password: '', confirm: '' });
      setStep('code');
    },
  });

  const submitVerify = (e: FormEvent) => {
    e.preventDefault();
    const id = parseAccountIdentifier(helmetCode);
    if (!id) return setCodeError('Enter a valid email, Customer ID or Helmet ID.');
    const code = id.code;
    setCodeError(null);
    verify.mutate(code);
  };
  const submitReset = (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordClientProblem(pw);
    setPwError(problem);
    if (!problem) reset.mutate();
  };

  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-4 py-12 sm:py-16">
        <h1 className="text-display-lg font-medium">
          {step === 'code' ? 'Password changed' : 'Reset your password'}
        </h1>
        {step === 'email' && (
          <p className="mt-2 text-body">
            Enter your account email. We’ll send you a 6-digit code to reset your password.
          </p>
        )}
        {step === 'verify' && (
          <p className="mt-2 text-body">
            Enter your account email (or Customer ID / Helmet ID) and the Recovery Code you saved.
          </p>
        )}
        <Card className="mt-8">
          <CardContent>
            {step === 'email' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (emailCode.length === 6) verifyEmail.mutate();
                }}
                noValidate
                className="flex flex-col gap-4"
                data-testid="recover-email"
              >
                <EmailField
                  id="rec-email"
                  label="Account email"
                  value={email}
                  onChange={setEmail}
                  hint=""
                  autoFocus
                />
                <EmailCodeBox
                  email={email}
                  idPrefix="rec-email"
                  onCode={setEmailCode}
                  sendLabel="Email me a code"
                  send={() =>
                    api.post<EmailCodeSentResponse>('/customer/auth/recover/email', {
                      email: email.trim(),
                    })
                  }
                />
                <InlineError error={verifyEmail.error} />
                <Button
                  type="submit"
                  size="lg"
                  loading={verifyEmail.isPending}
                  disabled={!!emailClientProblem(email) || emailCode.length !== 6}
                >
                  Continue
                </Button>
                <p className="text-sm text-body">
                  No access to this email?{' '}
                  <button
                    type="button"
                    className="font-medium text-ink underline underline-offset-4"
                    onClick={() => setStep('verify')}
                  >
                    Use your Recovery Code instead
                  </button>
                </p>
              </form>
            )}
            {step === 'verify' && (
              <form onSubmit={submitVerify} noValidate className="flex flex-col gap-4">
                <Field
                  label="Email, Customer ID or Helmet ID"
                  htmlFor="rec-identifier"
                  error={codeError ?? undefined}
                >
                  <Input
                    id="rec-identifier"
                    autoCapitalize="none"
                    autoComplete="username"
                    spellCheck={false}
                    placeholder="you@example.com"
                    value={helmetCode}
                    onChange={(e) => setHelmetCode(e.target.value)}
                  />
                </Field>
                <Field
                  label="Recovery Code"
                  htmlFor="rec-code"
                  hint="Looks like RK-XXXX-XXXX-XXXX. If support gave you a one-time code (AR-…), enter it here with your Customer ID."
                >
                  <Input
                    id="rec-code"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono uppercase"
                    placeholder="RK-XXXX-XXXX-XXXX"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                  />
                </Field>
                <InlineError error={verify.error} />
                <Button
                  type="submit"
                  size="lg"
                  loading={verify.isPending}
                  disabled={!helmetCode || !recoveryCode}
                >
                  Continue
                </Button>
                <p className="text-sm text-body">
                  Lost your Recovery Code too? Contact support. After verifying your identity they
                  can give you a one-time code by phone — never by email.
                </p>
                <button
                  type="button"
                  className="self-start text-sm font-medium underline underline-offset-4"
                  onClick={() => setStep('email')}
                >
                  ← Get a code by email instead
                </button>
              </form>
            )}
            {step === 'reset' && (
              <form onSubmit={submitReset} noValidate className="flex flex-col gap-4">
                <PasswordFields value={pw} onChange={setPw} idPrefix="reset" label="New password" />
                {pwError && <p className="text-sm text-danger">{pwError}</p>}
                <InlineError error={reset.error} />
                <Button type="submit" size="lg" loading={reset.isPending}>
                  Set new password
                </Button>
                <p className="text-sm text-body">
                  You’ll be signed out on every other device, and you’ll get a new Recovery Code.
                </p>
              </form>
            )}
            {step === 'code' && (
              <RecoveryCodeNotice
                code={newCode}
                continueLabel="Go to my account"
                onContinue={() => navigate('/app', { replace: true })}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </SiteFrame>
  );
}
