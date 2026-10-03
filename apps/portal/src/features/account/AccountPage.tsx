import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CustomerProfile, CustomerSessionDto } from '@helmet/types';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { PageTitle } from '../../components/AppLayout';
import { InlineError, LoadingState, SavedNote } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { keys, queryClient } from '../../lib/query';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function describeDevice(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${browser} on ${os}`;
}

export function AccountPage() {
  const { customer, setCustomer, signOut } = useCustomerAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState(customer?.name ?? '');
  const [saved, setSaved] = useState(false);
  useEffect(() => setName(customer?.name ?? ''), [customer?.name]);

  const sessions = useQuery({
    queryKey: keys.sessions,
    queryFn: () => api.get<CustomerSessionDto[]>('/customer/auth/sessions'),
  });
  const saveName = useMutation({
    mutationFn: () => api.patch<CustomerProfile>('/customer/auth/me', { name }),
    onSuccess: (c) => {
      setCustomer(c);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/customer/auth/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.sessions }),
  });
  const logoutAll = useMutation({
    mutationFn: () => api.post('/customer/auth/logout-all'),
    onSuccess: async () => {
      queryClient.clear();
      await signOut().catch(() => undefined);
      navigate('/login');
    },
  });

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageTitle title="Account" />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-body">
            Mobile number <span className="font-medium text-ink">{customer?.mobile}</span>
          </p>
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              saveName.mutate();
            }}
          >
            <Field label="Account name" htmlFor="acc-name" className="flex-1">
              <Input
                id="acc-name"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Button type="submit" loading={saveName.isPending} disabled={!name.trim()}>
              Save
            </Button>
            <SavedNote show={saved} />
          </form>
          <InlineError error={saveName.error} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <p className="text-display-sm font-bold">Signed-in devices</p>
          {sessions.isLoading && <LoadingState />}
          <ul className="flex flex-col divide-y divide-hairline">
            {sessions.data?.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium">
                    {describeDevice(s.userAgent)}{' '}
                    {s.current && (
                      <span className="ml-1 rounded-pill bg-ink px-2 py-0.5 text-xs text-on-dark">
                        This device
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-body">
                    Last active {dateFmt.format(new Date(s.lastUsedAt))}
                  </p>
                </div>
                {!s.current && (
                  <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.id)}>
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <InlineError error={revoke.error ?? logoutAll.error} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="subtle" onClick={() => void signOut().then(() => navigate('/'))}>
              Sign out
            </Button>
            <Button
              variant="secondary"
              loading={logoutAll.isPending}
              onClick={() => logoutAll.mutate()}
            >
              Sign out of all devices
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
