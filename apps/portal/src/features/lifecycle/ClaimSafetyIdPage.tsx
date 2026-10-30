import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  type CustomerLoginResponse,
  type CustomerSafetyIdDto,
  isValidSafetyCode,
  normalizeSafetyCode,
  normalizeTransferCode,
  type RecoveryCodeIssued,
} from '@helmet/types';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { queryClient } from '../../lib/query';
import { SiteFrame } from '../../pages/SiteFrame';
import { useSignupEmailProof } from '../auth/useSignupEmailProof';
import { EmailField } from '../auth/EmailField';
import { emailClientProblem } from '../auth/email-check';
import { MobileField } from '../auth/MobileField';
import { mobileClientProblem } from '../auth/mobile-check';
import { PasswordFields } from '../auth/PasswordFields';
import { passwordClientProblem, type PasswordValue } from '../auth/password-check';
import { RecoveryCodeNotice } from '../auth/RecoveryCodeNotice';

type Step = 'code' | 'account' | 'recovery';

/**
 * Claim a standalone Safety ID someone gave you: Safety ID + one-time Transfer Code. Signed-in
 * customers claim it directly; new customers create an account in the same step. Emergency
 * sharing starts off for the new owner. The code stays in memory only.
 */
export function ClaimSafetyIdPage() {
  const { status, signIn, restored } = useCustomerAuth();
  const navigate = useNavigate();
  const signedIn = status === 'authenticated';
  const [step, setStep] = useState<Step>('code');
  const [safetyCode, setSafetyCode] = useState('');
  const [transferCode, setTransferCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const emailProof = useSignupEmailProof(email, 'claim-email');
  const [mobile, setMobile] = useState('');
  const [name, setName] = useState('');
  const [pw, setPw] = useState<PasswordValue>({ password: '', confirm: '' });
  const [recoveryCode, setRecoveryCode] = useState('');
  const [claimedId, setClaimedId] = useState('');

  const done = (id: string) => {
    void queryClient.invalidateQueries();
    navigate(`/app/safety-ids/${id}`, { replace: true });
  };
  const claim = useMutation({
    mutationFn: () =>
      api.post<{ safetyId: CustomerSafetyIdDto }>('/customer/safety-id-transfers/claim', {
        safetyCode,
        transferCode,
      }),
    onSuccess: (r) => done(r.safetyId.id),
  });
  const register = useMutation({
    mutationFn: async () => {
      await restored();
      return api.post<
        CustomerLoginResponse & RecoveryCodeIssued & { safetyId: CustomerSafetyIdDto }
      >('/customer/safety-id-transfers/claim/register', {
        safetyCode,
        transferCode,
        email: email.trim(),
        mobile: mobile.trim(),
        password: pw.password,
        name: name.trim() || undefined,
        emailProof: emailProof.token,
      });
    },
    onSuccess: (r) => {
      signIn(r);
      setPw({ password: '', confirm: '' });
      setRecoveryCode(r.recoveryCode);
      setClaimedId(r.safetyId.id);
      setStep('recovery');
    },
  });

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    const s = normalizeSafetyCode(safetyCode);
    const t = normalizeTransferCode(transferCode);
    if (!s || !isValidSafetyCode(s))
      return setFormError('Check the Safety ID printed next to the QR code.');
    if (!t) return setFormError('A Transfer Code looks like TR-XXXX-XXXX-XXXX.');
    setFormError(null);
    setSafetyCode(s);
    setTransferCode(t);
    if (signedIn) claim.mutate();
    else setStep('account');
  };
  const submitAccount = (e: FormEvent) => {
    e.preventDefault();
    const p =
      emailClientProblem(email) ??
      emailProof.problem ??
      mobileClientProblem(mobile) ??
      passwordClientProblem(pw);
    setFormError(p);
    if (!p) register.mutate();
  };

  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-4 py-12 sm:py-16">
        <h1 className="text-display-lg font-medium">Claim a Safety ID</h1>
        {step === 'code' && (
          <p className="mt-2 text-body">
            Received a Safety ID sticker or card from someone? Enter the Safety ID and the Transfer
            Code they gave you.
          </p>
        )}
        <Card className="mt-8">
          <CardContent>
            {step === 'code' && (
              <form onSubmit={submitCode} noValidate className="flex flex-col gap-4">
                <Field label="Safety ID" htmlFor="claim-safety">
                  <Input
                    id="claim-safety"
                    autoCapitalize="characters"
                    className="font-mono uppercase"
                    placeholder="SI-XXXX-XXXX"
                    value={safetyCode}
                    onChange={(e) => setSafetyCode(e.target.value)}
                  />
                </Field>
                <Field label="Transfer Code" htmlFor="claim-safety-code" hint="Valid once.">
                  <Input
                    id="claim-safety-code"
                    autoCapitalize="characters"
                    className="font-mono uppercase"
                    value={transferCode}
                    onChange={(e) => setTransferCode(e.target.value)}
                  />
                </Field>
                {formError && <p className="text-sm text-danger">{formError}</p>}
                <InlineError error={claim.error} />
                <Button type="submit" size="lg" loading={claim.isPending}>
                  {signedIn ? 'Claim Safety ID' : 'Continue'}
                </Button>
                {!signedIn && (
                  <p className="text-sm text-body">
                    Already have an account?{' '}
                    <Link
                      className="font-medium text-ink underline underline-offset-4"
                      to={`/login?next=${encodeURIComponent('/claim?type=safety-id')}`}
                    >
                      Sign in first
                    </Link>
                    .
                  </p>
                )}
              </form>
            )}
            {step === 'account' && (
              <form onSubmit={submitAccount} noValidate className="flex flex-col gap-4">
                <p className="text-body">Create your account to claim this Safety ID.</p>
                <EmailField id="claim-email" value={email} onChange={setEmail} autoFocus />
                {emailProof.box}
                <MobileField id="claim-mobile" value={mobile} onChange={setMobile} />
                <Field label="Your name (optional)" htmlFor="claim-name">
                  <Input
                    id="claim-name"
                    autoComplete="name"
                    maxLength={120}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <PasswordFields value={pw} onChange={setPw} idPrefix="claim" />
                {formError && <p className="text-sm text-danger">{formError}</p>}
                <InlineError error={register.error} />
                <Button type="submit" size="lg" loading={register.isPending}>
                  Create account and claim
                </Button>
              </form>
            )}
            {step === 'recovery' && (
              <RecoveryCodeNotice code={recoveryCode} onContinue={() => done(claimedId)} />
            )}
          </CardContent>
        </Card>
      </div>
    </SiteFrame>
  );
}
