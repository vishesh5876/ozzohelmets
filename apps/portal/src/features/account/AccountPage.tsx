import { type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CustomerProfile, CustomerSessionDto, RecoveryCodeIssued } from '@helmet/types';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { PageTitle } from '../../components/AppLayout';
import { InlineError, LoadingState, SavedNote } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { PasswordFields } from '../auth/PasswordFields';
import { passwordClientProblem } from '../auth/password-check';
import { RecoveryCodeNotice } from '../auth/RecoveryCodeNotice';
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
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageTitle title="Account" />
      <DetailsCard />
      <ChangePasswordCard />
      <RecoveryCodeCard />
      <SessionsCard />
    </div>
  );
}

/** Name, email and mobile are optional contact details. They are never verified and never used to sign in. */
function DetailsCard() {
  const { customer, setCustomer } = useCustomerAuth();
  const [form, setForm] = useState({ name: '', email: '', mobile: '' });
  const [saved, setSaved] = useState(false);
  useEffect(
    () =>
      setForm({
        name: customer?.name ?? '',
        email: customer?.email ?? '',
        mobile: customer?.mobile ?? '',
      }),
    [customer?.name, customer?.email, customer?.mobile],
  );
  const save = useMutation({
    mutationFn: () =>
      api.patch<CustomerProfile>('/customer/auth/me', {
        name: form.name.trim() || null,
        email: form.email.trim() || null,
        mobile: form.mobile.trim() || null,
      }),
    onSuccess: (c) => {
      setCustomer(c);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });
  return (
    <Card>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <p className="text-display-sm font-bold">Your details</p>
          <p className="text-sm text-body">
            You sign in with any of your Helmet IDs and your password. Email and mobile are
            optional, not verified, and never used to sign in or recover your account.
          </p>
          <Field label="Name" htmlFor="acc-name">
            <Input
              id="acc-name"
              value={form.name}
              maxLength={120}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Email (optional, not verified)" htmlFor="acc-email">
            <Input
              id="acc-email"
              type="email"
              value={form.email}
              maxLength={254}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="Mobile (optional, not verified)" htmlFor="acc-mobile">
            <Input
              id="acc-mobile"
              type="tel"
              inputMode="tel"
              value={form.mobile}
              maxLength={32}
              onChange={(e) => setForm({ ...form, mobile: e.target.value })}
            />
          </Field>
          <InlineError error={save.error} />
          <div className="flex items-center gap-3">
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
            <SavedNote show={saved} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState({ password: '', confirm: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: () =>
      api.post('/customer/auth/change-password', {
        currentPassword: current,
        newPassword: next.password,
      }),
    onSuccess: () => {
      setCurrent('');
      setNext({ password: '', confirm: '' });
      setDone(true);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = passwordClientProblem(next);
    setProblem(p);
    setDone(false);
    if (!p) change.mutate();
  };
  return (
    <Card>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <p className="text-display-sm font-bold">Change password</p>
          <Field label="Current password" htmlFor="cp-current">
            <Input
              id="cp-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <PasswordFields value={next} onChange={setNext} idPrefix="cp" label="New password" />
          {problem && <p className="text-sm text-danger">{problem}</p>}
          <InlineError error={change.error} />
          {done && (
            <p className="text-sm font-medium">
              Password changed. Your other devices were signed out.
            </p>
          )}
          <Button type="submit" loading={change.isPending} disabled={!current || !next.password}>
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function RecoveryCodeCard() {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const rotate = useMutation({
    mutationFn: () => api.post<RecoveryCodeIssued>('/customer/auth/recovery-code', { password }),
    onSuccess: (r) => {
      setPassword('');
      setCode(r.recoveryCode);
    },
  });
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {code ? (
          <RecoveryCodeNotice code={code} continueLabel="Done" onContinue={() => setCode(null)} />
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              rotate.mutate();
            }}
          >
            <p className="text-display-sm font-bold">Recovery code</p>
            <p className="text-sm text-body">
              Lost your recovery code? Generate a new one. The old code stops working immediately.
            </p>
            <Field label="Confirm with your password" htmlFor="rc-password">
              <Input
                id="rc-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <InlineError error={rotate.error} />
            <Button type="submit" variant="subtle" loading={rotate.isPending} disabled={!password}>
              Generate new recovery code
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function SessionsCard() {
  const { signOut } = useCustomerAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const sessions = useQuery({
    queryKey: keys.sessions,
    queryFn: () => api.get<CustomerSessionDto[]>('/customer/auth/sessions'),
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
  );
}
