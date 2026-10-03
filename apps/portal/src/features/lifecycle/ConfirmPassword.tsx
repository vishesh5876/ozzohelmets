import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Button, Field, Input } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { confirmPassword, recentAuthToken } from '../../lib/recent-auth';

/**
 * Renders `children` once the password was confirmed recently; otherwise asks for it first.
 * Sensitive actions (transfer, stolen, recovered, retire) sit behind this gate.
 */
export function RecentAuthGate({ children, intro }: { children: ReactNode; intro?: string }) {
  const [, setConfirmed] = useState(0);
  const [password, setPassword] = useState('');
  const confirm = useMutation({
    mutationFn: () => confirmPassword(password),
    onSuccess: () => {
      setPassword('');
      setConfirmed((n) => n + 1);
    },
  });
  if (recentAuthToken()) return <>{children}</>;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        confirm.mutate();
      }}
    >
      <p className="text-body">
        {intro ?? 'This is a sensitive action. Confirm your password to continue.'}
      </p>
      <Field label="Your password" htmlFor="confirm-password">
        <Input
          id="confirm-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <InlineError error={confirm.error} />
      <Button type="submit" loading={confirm.isPending} disabled={!password}>
        Confirm password
      </Button>
    </form>
  );
}
