import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { ApiError } from '@helmet/api-client';
import {
  type ActivationResultDto,
  type ActivationValidateResponse,
  isValidHelmetCode,
  normalizeHelmetCode,
} from '@helmet/types';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { InlineError, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { queryClient } from '../../lib/query';
import { SiteFrame } from '../../pages/SiteFrame';
import { PhoneOtpForm } from '../auth/PhoneOtpForm';

type Target = { publicToken: string } | { helmetCode: string };
type Step = 'identify' | 'pin' | 'verify' | 'done';

/**
 * Activation: QR scan (token from /e/:token → ?t=) or manual Helmet ID → PIN → mobile OTP →
 * atomic activation. The PIN stays in memory only and is checked solely by the authenticated
 * completion call.
 */
export function ActivatePage() {
  const [params] = useSearchParams();
  const token = params.get('t');
  const { status, signIn } = useCustomerAuth();
  const navigate = useNavigate();

  const [target, setTarget] = useState<Target | null>(token ? { publicToken: token } : null);
  const [helmet, setHelmet] = useState<ActivationValidateResponse['helmet'] | null>(null);
  const [step, setStep] = useState<Step>('identify');
  const [pin, setPin] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [result, setResult] = useState<ActivationResultDto | null>(null);

  const validate = useMutation({
    mutationFn: (t: Target) =>
      api.post<ActivationValidateResponse>('/customer/activation/validate', t),
    onSuccess: (res) => {
      setHelmet(res.helmet);
      setStep('pin');
    },
  });
  const complete = useMutation({
    mutationFn: () =>
      api.post<ActivationResultDto>('/customer/activation/complete', { ...target, pin }),
    onSuccess: async (res) => {
      setResult(res);
      setPin('');
      setStep('done');
      await queryClient.invalidateQueries();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'INVALID_ACTIVATION_PIN') setStep('pin');
    },
  });

  useEffect(() => {
    if (
      token &&
      step === 'identify' &&
      !validate.isPending &&
      !validate.isSuccess &&
      !validate.isError
    )
      validate.mutate({ publicToken: token });
  }, [token, step, validate]);

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    const code = normalizeHelmetCode(manualCode);
    // Client-side checksum validation catches typos before any API call.
    if (!code || !isValidHelmetCode(code)) {
      setCodeError('That Helmet ID doesn’t look right. Check the characters on your label.');
      return;
    }
    setCodeError(null);
    const t = { helmetCode: code };
    setTarget(t);
    validate.mutate(t);
  };

  const submitPin = (e: FormEvent) => {
    e.preventDefault();
    if (status === 'authenticated') complete.mutate();
    else setStep('verify');
  };

  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-4 py-10 sm:py-14">
        <h1 className="text-display-lg font-bold">
          {step === 'done' ? 'Helmet activated' : 'Activate your helmet'}
        </h1>
        {step !== 'done' && <Stepper step={step} />}

        {helmet && step !== 'done' && (
          <div className="mt-6 rounded-xl bg-canvas-soft p-4">
            <p className="text-sm text-body">
              {helmet.brand} {helmet.modelName}
            </p>
            <p className="font-mono text-lg font-bold">{helmet.helmetCode}</p>
          </div>
        )}

        <Card className="mt-6">
          <CardContent>
            {step === 'identify' &&
              (token ? (
                validate.isError ? (
                  <div className="flex flex-col gap-4">
                    <InlineError error={validate.error} />
                    <Link to="/activate" className="font-medium underline underline-offset-4">
                      Enter a Helmet ID instead
                    </Link>
                  </div>
                ) : (
                  <LoadingState label="Finding your helmet…" />
                )
              ) : (
                <form onSubmit={submitManual} noValidate className="flex flex-col gap-4">
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
                  <InlineError error={validate.error} />
                  <Button type="submit" size="lg" loading={validate.isPending}>
                    Continue
                  </Button>
                  <p className="text-sm text-body">
                    Have the QR code? Scan it with your phone camera instead.
                  </p>
                </form>
              ))}

            {step === 'pin' && (
              <form onSubmit={submitPin} noValidate className="flex flex-col gap-4">
                <Field
                  label="Activation PIN"
                  htmlFor="pin"
                  hint="The 8-character code on your helmet label or card. It works only once."
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
                <InlineError error={complete.error} />
                <Button
                  type="submit"
                  size="lg"
                  disabled={pin.length < 8}
                  loading={complete.isPending}
                >
                  {status === 'authenticated' ? 'Activate helmet' : 'Continue'}
                </Button>
              </form>
            )}

            {step === 'verify' && (
              <div className="flex flex-col gap-4">
                <p className="text-body">
                  Verify your mobile number. This account will own the helmet.
                </p>
                <PhoneOtpForm
                  submitLabel="Verify and activate"
                  onVerified={(session) => {
                    signIn(session);
                    complete.mutate();
                  }}
                />
                {complete.isPending && <LoadingState label="Activating…" />}
                <InlineError error={complete.error} />
              </div>
            )}

            {step === 'done' && result && (
              <div className="flex flex-col items-start gap-4">
                <CheckCircle2 className="h-10 w-10" aria-hidden />
                <div>
                  <p className="text-display-sm font-bold">{result.helmet.helmetCode} is yours.</p>
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
          </CardContent>
        </Card>
      </div>
    </SiteFrame>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'identify', label: 'Helmet' },
    { key: 'pin', label: 'PIN' },
    { key: 'verify', label: 'Mobile' },
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
