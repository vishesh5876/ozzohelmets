import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import {
  type ActivationAddSafetyIdResponse,
  type ActivationRegisterResponse,
  type ActivationValidateResponse,
  type EmergencyReadinessDto,
  isValidHelmetCode,
  isValidSafetyCode,
  normalizeHelmetCode,
  normalizeSafetyCode,
  isAcceptedActivationPin,
} from '@helmet/types';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { InlineError, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { keys, queryClient } from '../../lib/query';
import { SiteFrame } from '../../pages/SiteFrame';
import { EmailField } from '../auth/EmailField';
import { emailClientProblem } from '../auth/email-check';
import { PasswordFields } from '../auth/PasswordFields';
import { passwordClientProblem, type PasswordValue } from '../auth/password-check';
import { RecoveryCodeNotice } from '../auth/RecoveryCodeNotice';
import { SetupProgress, type SetupStep } from './SetupProgress';

type Target = { publicToken: string } | { safetyCode: string } | { helmetCode: string };
type Step = 'identify' | 'pin' | 'account' | 'recovery' | 'done';
const PROGRESS: Record<Exclude<Step, 'done'>, SetupStep> = {
  identify: 'Verify Safety ID',
  pin: 'Verify Safety ID',
  account: 'Create account',
  recovery: 'Create account',
};

/**
 * Phase 9: activation starts from the Safety ID; the one-time Activation PIN printed with it is
 * the proof of possession:
 *  QR (?t=token) or manual Safety ID (or the Helmet ID on older cards) → PIN (validated) →
 *    new customer: email + password → account + ownership → Recovery Code shown once
 *    signed-in customer: Safety ID added to the existing account (no email/password needed)
 * A helmet that came with the Safety ID becomes the customer's in the same step. The PIN and
 * password live only in component state.
 */
export function ActivatePage() {
  const [params] = useSearchParams();
  const token = params.get('t');
  const { status, signIn, restored } = useCustomerAuth();
  const navigate = useNavigate();
  const signedIn = status === 'authenticated';

  const [target, setTarget] = useState<Target | null>(token ? { publicToken: token } : null);
  const [validated, setValidated] = useState<ActivationValidateResponse | null>(null);
  const [step, setStep] = useState<Step>(token ? 'pin' : 'identify');
  const [manualCode, setManualCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pw, setPw] = useState<PasswordValue>({ password: '', confirm: '' });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [activated, setActivated] = useState<ActivationAddSafetyIdResponse | null>(null);

  const validate = useMutation({
    mutationFn: () =>
      api.post<ActivationValidateResponse>('/customer/activation/validate', { ...target, pin }),
    onSuccess: (res) => {
      setValidated(res);
      if (signedIn) addHelmet.mutate();
      else setStep('account');
    },
  });
  const register = useMutation({
    mutationFn: async () => {
      await restored();
      return api.post<ActivationRegisterResponse>('/customer/activation/register', {
        ...target,
        pin,
        email: email.trim(),
        password: pw.password,
        name: name.trim() || undefined,
      });
    },
    onSuccess: async (res) => {
      signIn(res);
      setPin('');
      setPw({ password: '', confirm: '' });
      setActivated({ safetyId: res.safetyId, helmet: res.helmet });
      setRecoveryCode(res.recoveryCode);
      setStep('recovery');
      await queryClient.invalidateQueries();
    },
  });
  const addHelmet = useMutation({
    mutationFn: () =>
      api.post<ActivationAddSafetyIdResponse>('/customer/activation/add-safety-id', {
        ...target,
        pin,
      }),
    onSuccess: async (res) => {
      setPin('');
      setActivated(res);
      setStep('done');
      await queryClient.invalidateQueries();
    },
  });

  useEffect(() => {
    if (token) setTarget({ publicToken: token });
  }, [token]);
  // After activation: an existing customer whose profile is ready only needs this switch.
  const readiness = useQuery({
    queryKey: keys.readiness,
    queryFn: () => api.get<EmergencyReadinessDto>('/customer/emergency-profile/readiness'),
    enabled: step === 'done',
  });

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    // Client-side checksum validation catches typos before any API call. A Helmet ID is still
    // accepted for activation cards printed before Safety IDs.
    const safety = normalizeSafetyCode(manualCode);
    const helmetCode = safety ? null : normalizeHelmetCode(manualCode);
    if (safety && isValidSafetyCode(safety)) setTarget({ safetyCode: safety });
    else if (helmetCode && isValidHelmetCode(helmetCode)) setTarget({ helmetCode });
    else {
      setCodeError(
        'That Safety ID doesn’t look right. Check the characters printed next to the QR code.',
      );
      return;
    }
    setCodeError(null);
    setStep('pin');
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    const emailProblem = emailClientProblem(email);
    const problem = passwordClientProblem(pw);
    setEmailError(emailProblem);
    setPwError(problem);
    if (!problem && !emailProblem) register.mutate();
  };

  const busy = validate.isPending || addHelmet.isPending;
  const title =
    step === 'done' || step === 'recovery'
      ? 'Your Safety ID is activated.'
      : signedIn
        ? 'Add a Safety ID'
        : 'Activate your Safety ID';

  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-4 py-10 sm:py-14">
        <h1 className="text-display-lg font-bold">{title}</h1>
        {step !== 'done' && (
          <SetupProgress
            current={PROGRESS[step]}
            skip={signedIn && !recoveryCode ? ['Create account'] : []}
          />
        )}

        {(validated || target) && ['pin', 'account'].includes(step) && (
          <div className="mt-6 rounded-xl bg-canvas-soft p-4" data-testid="activation-target">
            {validated ? (
              <>
                <p className="text-sm text-body">Safety ID</p>
                <p className="font-mono text-lg font-bold">{validated.safetyId.safetyCode}</p>
                {validated.linkedHelmet && (
                  <p className="mt-1 text-sm text-body">
                    Comes with {validated.linkedHelmet.brand} {validated.linkedHelmet.modelName}{' '}
                    <span className="font-mono">{validated.linkedHelmet.helmetCode}</span>. The
                    helmet will be registered to you too.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-body">
                {target && 'safetyCode' in target ? (
                  <span className="font-mono text-lg font-bold text-ink">{target.safetyCode}</span>
                ) : target && 'helmetCode' in target ? (
                  <span className="font-mono text-lg font-bold text-ink">{target.helmetCode}</span>
                ) : (
                  'Safety ID identified from its QR code'
                )}
              </p>
            )}
          </div>
        )}

        <Card className="mt-6">
          <CardContent>
            {step === 'identify' && (
              <form onSubmit={submitManual} noValidate className="flex flex-col gap-4">
                <p className="font-medium">I have a Safety ID</p>
                <Field
                  label="Safety ID"
                  htmlFor="safety-code"
                  error={codeError ?? undefined}
                  hint="Printed next to the QR code, e.g. SI-CD69-GXXR. Older activation cards show a Helmet ID (HM-…), which works too."
                >
                  <Input
                    id="safety-code"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono uppercase"
                    placeholder="SI-XXXX-XXXX"
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value)}
                    aria-invalid={!!codeError}
                  />
                </Field>
                <Button type="submit" size="lg">
                  Continue
                </Button>
                <p className="text-sm text-body">
                  Have the QR code? Scan it with your phone camera instead.
                </p>
              </form>
            )}

            {step === 'pin' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  validate.mutate();
                }}
                noValidate
                className="flex flex-col gap-4"
              >
                <Field
                  label="Activation PIN"
                  htmlFor="pin"
                  hint="Enter the Activation PIN printed with your Safety ID. New stickers have a 6-digit PIN. It works only once."
                >
                  <Input
                    id="pin"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={12}
                    className="text-center font-mono text-2xl uppercase tracking-[0.3em]"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    autoFocus
                  />
                </Field>
                <InlineError error={validate.error ?? addHelmet.error} />
                <Button
                  type="submit"
                  size="lg"
                  disabled={!isAcceptedActivationPin(pin)}
                  loading={busy}
                >
                  {signedIn ? 'Add Safety ID to my account' : 'Continue'}
                </Button>
                {!signedIn && (
                  <p className="text-sm text-body">
                    Already have an account?{' '}
                    <Link
                      className="font-medium text-ink underline underline-offset-4"
                      to={`/login?next=${encodeURIComponent(`/activate${token ? `?t=${encodeURIComponent(token)}` : ''}`)}`}
                    >
                      Sign in first
                    </Link>{' '}
                    to add this one.
                  </p>
                )}
              </form>
            )}

            {step === 'account' && (
              <form onSubmit={submitPassword} noValidate className="flex flex-col gap-4">
                <p className="text-body">
                  PIN accepted. Create your account — you’ll sign in with your email and password.
                </p>
                <EmailField
                  id="reg-email"
                  value={email}
                  onChange={setEmail}
                  error={emailError}
                  autoFocus
                />
                <Field label="Your name (optional)" htmlFor="reg-name">
                  <Input
                    id="reg-name"
                    autoComplete="name"
                    value={name}
                    maxLength={120}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <PasswordFields value={pw} onChange={setPw} idPrefix="reg" />
                {pwError && <p className="text-sm text-danger">{pwError}</p>}
                <InlineError error={register.error} />
                <Button type="submit" size="lg" loading={register.isPending}>
                  Activate Safety ID
                </Button>
              </form>
            )}

            {step === 'recovery' && (
              <RecoveryCodeNotice code={recoveryCode} onContinue={() => setStep('done')} />
            )}

            {step === 'done' && activated && (
              <div className="flex flex-col items-start gap-4" data-testid="activation-done">
                <CheckCircle2 className="h-10 w-10" aria-hidden />
                <dl className="grid w-full gap-3 rounded-xl bg-canvas-soft p-4">
                  <div>
                    <dt className="text-sm text-body">Safety ID</dt>
                    <dd className="font-mono text-lg font-bold">{activated.safetyId.safetyCode}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-body">Emergency Sharing</dt>
                    <dd className="font-medium">
                      {activated.safetyId.emergencySharing ? 'On' : 'Not enabled yet'}
                    </dd>
                  </div>
                  {activated.helmet && (
                    <div>
                      <dt className="text-sm text-body">Linked helmet</dt>
                      <dd className="font-medium">
                        {activated.helmet.model.brand} {activated.helmet.model.name}{' '}
                        <span className="font-mono">{activated.helmet.helmetCode}</span>
                      </dd>
                    </div>
                  )}
                </dl>
                <p className="text-body">
                  Finish your emergency setup so first responders see your information when they
                  scan this Safety ID.
                </p>
                {readiness.data?.canEnable ? (
                  // Profile already set up (e.g. a second Safety ID): only this switch is left.
                  <Button
                    size="lg"
                    className="w-full"
                    onClick={() => navigate(`/app/safety-ids/${activated.safetyId.id}`)}
                  >
                    Turn on sharing for this Safety ID
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    className="w-full"
                    onClick={() =>
                      navigate(
                        `/app/onboarding?safetyId=${encodeURIComponent(activated.safetyId.id)}`,
                      )
                    }
                  >
                    Complete emergency setup
                  </Button>
                )}
                <Link to="/app" className="font-medium underline underline-offset-4">
                  Do it later
                </Link>
              </div>
            )}
            {step === 'done' && !activated && <LoadingState />}
          </CardContent>
        </Card>
      </div>
    </SiteFrame>
  );
}
