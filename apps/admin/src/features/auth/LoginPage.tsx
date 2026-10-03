import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation } from 'react-router-dom';
import { z } from 'zod';
import { Activity } from 'lucide-react';
import { Button, Field, Input } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { useAuth } from '../../lib/auth-context';
import { useState } from 'react';

const schema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});
type FormValues = z.infer<typeof schema>;

export function LoginPage() {
  const { status, login } = useAuth();
  const location = useLocation();
  const [error, setError] = useState<unknown>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await login(values.email, values.password);
    } catch (err) {
      setError(err);
    }
  });

  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <section className="hidden flex-col justify-between bg-ink p-12 text-on-dark lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-canvas text-ink">
            <Activity className="h-5 w-5" aria-hidden />
          </span>
          <span className="font-bold">Helmet ID</span>
        </div>
        <div>
          <h1 className="text-display-xxl font-bold">Every helmet, accounted for.</h1>
          <p className="mt-4 max-w-md text-lg text-mute">
            Manufacturing, identity and authenticity for every helmet that leaves the line.
          </p>
        </div>
        <p className="text-sm text-mute">Authorised personnel only. All actions are audited.</p>
      </section>
      <section className="flex items-center justify-center px-4 py-12">
        <form onSubmit={onSubmit} noValidate className="w-full max-w-sm">
          <h2 className="text-display-lg font-bold">Sign in</h2>
          <p className="mt-1 text-body">Use your admin account.</p>
          <div className="mt-8 flex flex-col gap-4">
            <Field label="Email" htmlFor="email" error={errors.email?.message}>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                aria-invalid={!!errors.email}
                {...register('email')}
              />
            </Field>
            <Field label="Password" htmlFor="password" error={errors.password?.message}>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                aria-invalid={!!errors.password}
                {...register('password')}
              />
            </Field>
            <InlineError error={error} />
            <Button type="submit" size="lg" loading={isSubmitting} className="mt-2 w-full">
              Sign in
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
