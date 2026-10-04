import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  type CustomerLoginResponse,
  isValidHelmetCode,
  normalizeHelmetCode,
  normalizeTransferCode,
  type TransferClaimPreviewResponse,
  type TransferClaimRegisterResponse,
  type TransferClaimResponse,
} from '@helmet/types';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { queryClient } from '../../lib/query';
import { SiteFrame } from '../../pages/SiteFrame';
import { EmailField } from '../auth/EmailField';
import { emailClientProblem } from '../auth/email-check';
import { PasswordFields } from '../auth/PasswordFields';
import { passwordClientProblem, type PasswordValue } from '../auth/password-check';
import { RecoveryCodeNotice } from '../auth/RecoveryCodeNotice';

type Step = 'code' | 'confirm' | 'recovery';

/**
 * Claim a helmet someone transferred to you: Helmet ID + one-time transfer code, then sign in
 * (existing customer) or create an account with email + password (new customer). The code stays in memory only.
 */
export function ClaimPage() {
  const { status, signIn, restored } = useCustomerAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('code');
  const [helmetCode, setHelmetCode] = useState('');
  const [transferCode, setTransferCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TransferClaimPreviewResponse['helmet'] | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [loginHelmet, setLoginHelmet] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState<PasswordValue>({ password: '', confirm: '' });
  const [recoveryCode, setRecoveryCode] = useState('');
  const [claimedId, setClaimedId] = useState('');

  const body = () => ({ helmetCode, transferCode });
  const done = (helmetId: string) => {
    void queryClient.invalidateQueries();
    navigate(`/app/helmets/${helmetId}`, { replace: true });
  };

  const check = useMutation({
    mutationFn: () => api.post<TransferClaimPreviewResponse>('/customer/transfers/preview', body()),
    onSuccess: (r) => {
      setPreview(r.helmet);
      setStep('confirm');
    },
  });
  const claim = useMutation({
    mutationFn: () => api.post<TransferClaimResponse>('/customer/transfers/claim', body()),
    onSuccess: (r) => done(r.helmet.id),
  });
  const signInAndClaim = useMutation({
    mutationFn: async () => {
      await restored();
      const session = await api.post<CustomerLoginResponse>('/customer/auth/login', {
        identifier: loginHelmet,
        password: loginPassword,
      });
      signIn(session);
      return api.post<TransferClaimResponse>('/customer/transfers/claim', body());
    },
    onSuccess: (r) => done(r.helmet.id),
  });
  const register = useMutation({
    mutationFn: async () => {
      await restored();
      return api.post<TransferClaimRegisterResponse>('/customer/transfers/claim/register', {
        ...body(),
        email: email.trim(),
        password: pw.password,
        name: name.trim() || undefined,
      });
    },
    onSuccess: (r) => {
      signIn(r);
      setPw({ password: '', confirm: '' });
      setRecoveryCode(r.recoveryCode);
      setClaimedId(r.helmet.id);
      setStep('recovery');
    },
  });

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    const h = normalizeHelmetCode(helmetCode);
    const t = normalizeTransferCode(transferCode);
    if (!h || !isValidHelmetCode(h)) return setFormError('Check the Helmet ID on the label.');
    if (!t) return setFormError('A transfer code looks like TR-XXXX-XXXX-XXXX.');
    setFormError(null);
    setHelmetCode(h);
    setTransferCode(t);
    check.mutate();
  };
  const submitNew = (e: FormEvent) => {
    e.preventDefault();
    const p = emailClientProblem(email) ?? passwordClientProblem(pw);
    setFormError(p);
    if (!p) register.mutate();
  };

  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-4 py-12 sm:py-16">
        <h1 className="text-display-lg font-bold">Claim a helmet</h1>
        {step === 'code' && (
          <p className="mt-2 text-body">
            Received a helmet from its previous owner? Enter its Helmet ID and the transfer code
            they gave you.
          </p>
        )}
        <Card className="mt-8">
          <CardContent>
            {step === 'code' && (
              <form onSubmit={submitCode} noValidate className="flex flex-col gap-4">
                <Field label="Helmet ID" htmlFor="claim-helmet">
                  <Input
                    id="claim-helmet"
                    autoCapitalize="characters"
                    value={helmetCode}
                    onChange={(e) => setHelmetCode(e.target.value)}
                  />
                </Field>
                <Field
                  label="Transfer code"
                  htmlFor="claim-code"
                  hint="Valid once, for a limited time."
                >
                  <Input
                    id="claim-code"
                    autoCapitalize="characters"
                    autoComplete="off"
                    value={transferCode}
                    onChange={(e) => setTransferCode(e.target.value)}
                  />
                </Field>
                {formError && <p className="text-sm text-danger">{formError}</p>}
                <InlineError error={check.error} />
                <Button
                  type="submit"
                  size="lg"
                  loading={check.isPending}
                  disabled={!helmetCode || !transferCode}
                >
                  Continue
                </Button>
              </form>
            )}

            {step === 'confirm' && preview && (
              <div className="flex flex-col gap-5">
                <div className="rounded-md bg-canvas-soft p-4">
                  <p className="text-sm text-body">
                    {preview.brand} {preview.modelName}
                  </p>
                  <p className="font-mono text-lg font-bold">{preview.helmetCode}</p>
                </div>
                {status === 'authenticated' ? (
                  <>
                    <p className="text-body">
                      The helmet will be added to your account. The previous owner’s emergency
                      information will no longer be shown on it.
                    </p>
                    <InlineError error={claim.error} />
                    <Button size="lg" loading={claim.isPending} onClick={() => claim.mutate()}>
                      Claim helmet
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2" role="tablist">
                      <Button
                        variant={mode === 'existing' ? 'primary' : 'subtle'}
                        onClick={() => setMode('existing')}
                      >
                        Existing customer
                      </Button>
                      <Button
                        variant={mode === 'new' ? 'primary' : 'subtle'}
                        onClick={() => setMode('new')}
                      >
                        New customer
                      </Button>
                    </div>
                    {mode === 'existing' ? (
                      <form
                        className="flex flex-col gap-4"
                        onSubmit={(e) => {
                          e.preventDefault();
                          signInAndClaim.mutate();
                        }}
                      >
                        <Field
                          label="Email (or Customer ID / Helmet ID you own)"
                          htmlFor="claim-login-helmet"
                        >
                          <Input
                            id="claim-login-helmet"
                            autoCapitalize="none"
                            autoComplete="username"
                            spellCheck={false}
                            value={loginHelmet}
                            onChange={(e) => setLoginHelmet(e.target.value)}
                          />
                        </Field>
                        <Field label="Password" htmlFor="claim-login-password">
                          <Input
                            id="claim-login-password"
                            type="password"
                            autoComplete="current-password"
                            value={loginPassword}
                            onChange={(e) => setLoginPassword(e.target.value)}
                          />
                        </Field>
                        <InlineError error={signInAndClaim.error} />
                        <Button
                          type="submit"
                          size="lg"
                          loading={signInAndClaim.isPending}
                          disabled={!loginHelmet || !loginPassword}
                        >
                          Sign in and claim
                        </Button>
                      </form>
                    ) : (
                      <form onSubmit={submitNew} noValidate className="flex flex-col gap-4">
                        <Field label="Your name (optional)" htmlFor="claim-name">
                          <Input
                            id="claim-name"
                            autoComplete="name"
                            maxLength={120}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                          />
                        </Field>
                        <EmailField id="claim-email" value={email} onChange={setEmail} />
                        <PasswordFields value={pw} onChange={setPw} idPrefix="claim" />
                        {formError && <p className="text-sm text-danger">{formError}</p>}
                        <InlineError error={register.error} />
                        <Button type="submit" size="lg" loading={register.isPending}>
                          Create account and claim
                        </Button>
                      </form>
                    )}
                  </>
                )}
              </div>
            )}

            {step === 'recovery' && (
              <RecoveryCodeNotice
                code={recoveryCode}
                continueLabel="Go to my helmet"
                onContinue={() => done(claimedId)}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </SiteFrame>
  );
}
