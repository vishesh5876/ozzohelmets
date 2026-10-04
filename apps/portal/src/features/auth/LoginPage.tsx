import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { type CustomerLoginResponse, parseAccountIdentifier } from '@helmet/types';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { SiteFrame } from '../../pages/SiteFrame';
import { safeNext } from './safe-next';

/**
 * Sign in with your account email and password. The Customer ID or a currently owned Helmet ID
 * also work in the same field.
 */
export function LoginPage() {
  const { status, signIn, restored } = useCustomerAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: (code: string) =>
      restored().then(() =>
        api.post<CustomerLoginResponse>('/customer/auth/login', { identifier: code, password }),
      ),
    onSuccess: (session) => {
      signIn(session);
      navigate(next, { replace: true });
    },
  });

  if (status === 'authenticated') return <Navigate to={next} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = parseAccountIdentifier(identifier);
    if (!id) {
      setCodeError(
        identifier.includes('@')
          ? 'Enter a valid email address.'
          : 'That doesn’t look right. Enter your email, Customer ID or Helmet ID.',
      );
      return;
    }
    setCodeError(null);
    login.mutate(id.code);
  };

  return (
    <SiteFrame>
      <div className="mx-auto max-w-md px-4 py-12 sm:py-16">
        <h1 className="text-display-lg font-bold">Sign in</h1>
        <p className="mt-2 text-body">Use the email and password you chose at activation.</p>
        <Card className="mt-8">
          <CardContent>
            <form onSubmit={submit} noValidate className="flex flex-col gap-4">
              <Field
                label="Email"
                htmlFor="login-identifier"
                error={codeError ?? undefined}
                hint="You can also use your Customer ID (CU-…) or the Helmet ID of a helmet you own."
              >
                <Input
                  id="login-identifier"
                  type="text"
                  inputMode="email"
                  autoCapitalize="none"
                  autoComplete="username"
                  spellCheck={false}
                  placeholder="you@example.com"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
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
                disabled={!identifier || !password}
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
                <Link to="/claim" className="font-medium underline underline-offset-4">
                  Received a helmet? Claim it
                </Link>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </SiteFrame>
  );
}
