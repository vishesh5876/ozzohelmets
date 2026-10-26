import { type FormEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { CustomerProfile } from '@helmet/types';
import { Button } from '@helmet/ui';
import { InlineError } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { MobileField } from '../auth/MobileField';
import { mobileClientProblem } from '../auth/mobile-check';

/**
 * Accounts created before the mobile number was collected at sign-up are asked for it once, on
 * the dashboard. Disappears as soon as a number is saved.
 */
export function AddMobileCard() {
  const { customer, setCustomer } = useCustomerAuth();
  const [mobile, setMobile] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.patch<CustomerProfile>('/customer/auth/me', { mobile: mobile.trim() }),
    onSuccess: setCustomer,
  });
  if (!customer || customer.mobile) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = mobileClientProblem(mobile);
    setError(problem);
    if (!problem) save.mutate();
  };
  return (
    <section
      aria-labelledby="add-mobile-h"
      data-testid="add-mobile"
      className="rounded-xl border border-hairline bg-canvas-soft p-5 sm:p-6"
    >
      <h2 id="add-mobile-h" className="text-display-sm font-semibold">
        Add your mobile number
      </h2>
      <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-4">
        <MobileField id="add-mobile" value={mobile} onChange={setMobile} error={error} />
        <InlineError error={save.error} />
        <Button type="submit" className="self-start" loading={save.isPending}>
          Save mobile number
        </Button>
      </form>
    </section>
  );
}
