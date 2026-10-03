import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  type CustomerRecoverResponse,
  type CustomerResetPasswordResponse,
  isValidHelmetCode,
  normalizeHelmetCode,
} from '@helmet/types';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { SiteFrame } from '../../pages/SiteFrame';
import { PasswordFields } from './PasswordFields';
import { passwordClientProblem, type PasswordValue } from './password-check';
import { RecoveryCodeNotice } from './RecoveryCodeNotice';

type Step = 'verify' | 'reset' | 'code';

/** Forgot password: Helmet ID + recovery code → new password → new recovery code (shown once). */
export function RecoverPage() {
  const navigate = useNavigate();
  const { signIn, restored } = useCustomerAuth();
  const [step, setStep] = useState<Step>('verify');
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
        helmetCode: code,
        recoveryCode,
      }),
    onSuccess: (res) => {
      setResetToken(res.resetToken);
      setRecoveryCode('');
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
    const code = normalizeHelmetCode(helmetCode);
    if (!code || !isValidHelmetCode(code))
      return setCodeError('That Helmet ID doesn’t look right.');
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
        <h1 className="text-display-lg font-bold">
          {step === 'code' ? 'Password changed' : 'Reset your password'}
        </h1>
        {step === 'verify' && (
          <p className="mt-2 text-body">
            You need one of your Helmet IDs and the recovery code you saved when you activated.
          </p>
        )}
        <Card className="mt-8">
          <CardContent>
            {step === 'verify' && (
              <form onSubmit={submitVerify} noValidate className="flex flex-col gap-4">
                <Field label="Helmet ID" htmlFor="rec-helmet" error={codeError ?? undefined}>
                  <Input
                    id="rec-helmet"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="font-mono uppercase"
                    placeholder="HM-XXXX-XXXX"
                    value={helmetCode}
                    onChange={(e) => setHelmetCode(e.target.value)}
                  />
                </Field>
                <Field
                  label="Recovery code"
                  htmlFor="rec-code"
                  hint="Looks like RK-XXXX-XXXX-XXXX."
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
                  Lost your recovery code too? Contact support with your helmet’s proof of purchase.
                </p>
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
                  You’ll be signed out on every other device, and you’ll get a new recovery code.
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
