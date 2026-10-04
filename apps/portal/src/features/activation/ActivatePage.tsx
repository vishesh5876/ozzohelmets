import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import {
  type ActivationAddHelmetResponse,
  type ActivationRegisterResponse,
  type ActivationValidateResponse,
  type CustomerHelmetDto,
  isValidHelmetCode,
  normalizeHelmetCode,
} from '@helmet/types';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { InlineError, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { queryClient } from '../../lib/query';
import { SiteFrame } from '../../pages/SiteFrame';
import { EmailField } from '../auth/EmailField';
import { emailClientProblem } from '../auth/email-check';
import { PasswordFields } from '../auth/PasswordFields';
import { passwordClientProblem, type PasswordValue } from '../auth/password-check';
import { RecoveryCodeNotice } from '../auth/RecoveryCodeNotice';

type Target = { publicToken: string } | { helmetCode: string };
type Step = 'identify' | 'pin' | 'account' | 'recovery' | 'done';

/**
 * Activation with the concealed one-time PIN as proof of possession:
 *  QR (?t=token) or manual Helmet ID → PIN (validated) →
 *    new customer: email + password → account + ownership → recovery code shown once
 *    signed-in customer: helmet added to the existing account (no email/password needed)
 * The PIN is the proof of possession; the email is only the sign-in identifier. The PIN and
 * password live only in component state.
 */
export function ActivatePage() {
  const [params] = useSearchParams();
  const token = params.get('t');
  const { status, signIn, restored } = useCustomerAuth();
  const navigate = useNavigate();
  const signedIn = status === 'authenticated';

  const [target, setTarget] = useState<Target | null>(token ? { publicToken: token } : null);
  const [helmet, setHelmet] = useState<ActivationValidateResponse['helmet'] | null>(null);
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
  const [activated, setActivated] = useState<CustomerHelmetDto | null>(null);

  const validate = useMutation({
    mutationFn: () =>
      api.post<ActivationValidateResponse>('/customer/activation/validate', { ...target, pin }),
    onSuccess: (res) => {
      setHelmet(res.helmet);
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
      setActivated(res.helmet);
      setRecoveryCode(res.recoveryCode);
      setStep('recovery');
      await queryClient.invalidateQueries();
    },
  });
  const addHelmet = useMutation({
    mutationFn: () =>
      api.post<ActivationAddHelmetResponse>('/customer/activation/add-helmet', { ...target, pin }),
    onSuccess: async (res) => {
      setPin('');
      setActivated(res.helmet);
      setStep('done');
      await queryClient.invalidateQueries();
    },
  });

  useEffect(() => {
    if (token) setTarget({ publicToken: token });
  }, [token]);

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    const code = normalizeHelmetCode(manualCode);
    // Client-side checksum validation catches typos before any API call.
    if (!code || !isValidHelmetCode(code)) {
      setCodeError('That Helmet ID doesn’t look right. Check the characters on your label.');
      return;
    }
    setCodeError(null);
    setTarget({ helmetCode: code });
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
      ? 'Helmet activated'
      : signedIn
        ? 'Add a helmet'
        : 'Activate your helmet';

  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-4 py-10 sm:py-14">
        <h1 className="text-display-lg font-bold">{title}</h1>
        {['identify', 'pin', 'account'].includes(step) && (
          <Stepper step={step} signedIn={signedIn} />
        )}

        {(helmet || target) && ['pin', 'account'].includes(step) && (
          <div className="mt-6 rounded-xl bg-canvas-soft p-4">
            {helmet ? (
              <>
                <p className="text-sm text-body">
                  {helmet.brand} {helmet.modelName}
                </p>
                <p className="font-mono text-lg font-bold">{helmet.helmetCode}</p>
              </>
            ) : (
              <p className="text-sm text-body">
                {target && 'helmetCode' in target ? (
                  <span className="font-mono text-lg font-bold text-ink">{target.helmetCode}</span>
                ) : (
                  'Helmet identified from its QR code'
                )}
              </p>
            )}
          </div>
        )}

        <Card className="mt-6">
          <CardContent>
            {step === 'identify' && (
              <form onSubmit={submitManual} noValidate className="flex flex-col gap-4">
                <p className="font-medium">I have a Helmet ID</p>
                <Field
                  label="Helmet ID"
                  htmlFor="helmet-code"
                  error={codeError ?? undefined}
                  hint="Printed on the label inside your helmet, e.g. HM-A8F3-KL92."
                >
                  <Input
                    id="helmet-code"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono uppercase"
                    placeholder="HM-XXXX-XXXX"
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
                  hint="The 8-character code under the scratch-off panel or on the activation card in the box. It works only once."
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
                <Button type="submit" size="lg" disabled={pin.length < 8} loading={busy}>
                  {signedIn ? 'Add helmet to my account' : 'Continue'}
                </Button>
                {!signedIn && (
                  <p className="text-sm text-body">
                    Already have an account for another helmet?{' '}
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
                  Activate helmet
                </Button>
              </form>
            )}

            {step === 'recovery' && (
              <RecoveryCodeNotice code={recoveryCode} onContinue={() => setStep('done')} />
            )}

            {step === 'done' && activated && (
              <div className="flex flex-col items-start gap-4">
                <CheckCircle2 className="h-10 w-10" aria-hidden />
                <div>
                  <p className="text-display-sm font-bold">{activated.helmetCode} is yours.</p>
                  <p className="mt-1 text-body">
                    Next, set up the emergency information first responders will see when they scan
                    your helmet.
                  </p>
                </div>
                <Button size="lg" className="w-full" onClick={() => navigate('/app/onboarding')}>
                  Set up emergency profile
                </Button>
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

function Stepper({ step, signedIn }: { step: Step; signedIn: boolean }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'identify', label: 'Helmet' },
    { key: 'pin', label: 'PIN' },
    ...(signedIn ? [] : [{ key: 'account' as Step, label: 'Account' }]),
  ];
  const index = steps.findIndex((s) => s.key === step);
  return (
    <ol className="mt-4 flex gap-2" aria-label="Activation steps">
      {steps.map((s, i) => (
        <li
          key={s.key}
          className={`flex-1 border-t-4 pt-2 text-sm font-medium ${i <= index ? 'border-ink text-ink' : 'border-hairline text-body'}`}
          aria-current={i === index ? 'step' : undefined}
        >
          {s.label}
        </li>
      ))}
    </ol>
  );
}
