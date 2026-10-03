import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { type CustomerLoginResponse, isValidHelmetCode, normalizeHelmetCode } from '@helmet/types';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { SiteFrame } from '../../pages/SiteFrame';
import { safeNext } from './safe-next';

/** Sign in with any Helmet ID you own + your password. */
export function LoginPage() {
  const { status, signIn, restored } = useCustomerAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const [helmetCode, setHelmetCode] = useState('');
  const [password, setPassword] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: (code: string) =>
      restored().then(() =>
        api.post<CustomerLoginResponse>('/customer/auth/login', { helmetCode: code, password }),
      ),
    onSuccess: (session) => {
      signIn(session);
      navigate(next, { replace: true });
    },
  });

  if (status === 'authenticated') return <Navigate to={next} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = normalizeHelmetCode(helmetCode);
    if (!code || !isValidHelmetCode(code)) {
      setCodeError('That Helmet ID doesn’t look right. Check the characters on your label.');
      return;
    }
    setCodeError(null);
    login.mutate(code);
  };

  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-4 py-12 sm:py-16">
        <h1 className="text-display-lg font-bold">Sign in</h1>
        <p className="mt-2 text-body">Use the Helmet ID of any helmet you own and your password.</p>
        <Card className="mt-8">
          <CardContent>
            <form onSubmit={submit} noValidate className="flex flex-col gap-4">
              <Field
                label="Helmet ID"
                htmlFor="login-helmet"
                error={codeError ?? undefined}
                hint="Printed on your helmet label, e.g. HM-A8F3-KL92."
              >
                <Input
                  id="login-helmet"
                  autoCapitalize="characters"
                  autoComplete="username"
                  spellCheck={false}
                  className="font-mono uppercase"
                  placeholder="HM-XXXX-XXXX"
                  value={helmetCode}
                  onChange={(e) => setHelmetCode(e.target.value)}
                  aria-invalid={!!codeError}
                />
              </Field>
              <Field label="Password" htmlFor="login-password">
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <InlineError error={login.error} />
              <Button
                type="submit"
                size="lg"
                loading={login.isPending}
                disabled={!helmetCode || !password}
              >
                Sign in
              </Button>
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <Link to="/recover" className="font-medium underline underline-offset-4">
                  Forgot password?
                </Link>
                <Link to="/activate" className="font-medium underline underline-offset-4">
                  New helmet? Activate it
                </Link>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </SiteFrame>
  );
}
