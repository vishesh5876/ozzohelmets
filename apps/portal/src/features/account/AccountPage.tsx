import { type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  type AccountDeletionRequestDto,
  type CustomerProfile,
  type CustomerSecurityEventDto,
  type CustomerSecurityStatusDto,
  type CustomerSessionDto,
  normalizeEmail,
  type RecoveryCodeIssued,
} from '@helmet/types';
import { RecentAuthGate } from '../lifecycle/ConfirmPassword';
import { recentAuthToken } from '../../lib/recent-auth';
import { Button, Card, CardContent, Field, Input } from '@helmet/ui';
import { PageTitle } from '../../components/AppLayout';
import { InlineError, LoadingState, SavedNote } from '../../components/States';
import { api } from '../../lib/api';
import { useCustomerAuth } from '../../lib/auth-context';
import { EmailField } from '../auth/EmailField';
import { EMAIL_WARNING, emailClientProblem } from '../auth/email-check';
import { PasswordFields } from '../auth/PasswordFields';
import { passwordClientProblem } from '../auth/password-check';
import { RecoveryCodeNotice } from '../auth/RecoveryCodeNotice';
import { keys, queryClient } from '../../lib/query';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function AccountPage() {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageTitle title="Account" />
      <AccountEmailCard />
      <CustomerIdCard />
      <DetailsCard />
      <ChangePasswordCard />
      <RecoveryCodeCard />
      <SessionsCard />
      <ActivityCard />
      <DataExportCard />
      <DeletionCard />
    </div>
  );
}

/** Name and mobile are optional details. Mobile is never verified and never used to sign in. */
function DetailsCard() {
  const { customer, setCustomer } = useCustomerAuth();
  const [form, setForm] = useState({ name: '', mobile: '' });
  const [saved, setSaved] = useState(false);
  useEffect(
    () =>
      setForm({
        name: customer?.name ?? '',
        mobile: customer?.mobile ?? '',
      }),
    [customer?.name, customer?.mobile],
  );
  const save = useMutation({
    mutationFn: () =>
      api.patch<CustomerProfile>('/customer/auth/me', {
        name: form.name.trim() || null,
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
            Optional. Your mobile number is not verified and is never used to sign in.
          </p>
          <Field label="Name" htmlFor="acc-name">
            <Input
              id="acc-name"
              value={form.name}
              maxLength={120}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
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
  const qc = useQueryClient();
  const security = useQuery({
    queryKey: keys.security,
    queryFn: () => api.get<CustomerSecurityStatusDto>('/customer/account/security'),
  });
  const rotate = useMutation({
    mutationFn: () => api.post<RecoveryCodeIssued>('/customer/auth/recovery-code', { password }),
    onSuccess: (r) => {
      setPassword('');
      setCode(r.recoveryCode);
      void qc.invalidateQueries({ queryKey: ['account'] });
    },
  });
  const status = security.data
    ? !security.data.recoveryCodeConfigured
      ? 'Missing'
      : security.data.recoveryCodeAcknowledged
        ? 'Configured'
        : 'Configured — not confirmed as saved'
    : '…';
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {code ? (
          <RecoveryCodeNotice
            code={code}
            continueLabel="Done"
            onContinue={() => {
              setCode(null);
              void qc.invalidateQueries({ queryKey: ['account'] });
            }}
          />
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              rotate.mutate();
            }}
          >
            <p className="text-display-sm font-bold">Recovery code</p>
            <p className="font-medium" data-testid="recovery-status">
              Recovery code: {status}
            </p>
            <p className="text-sm text-body">
              The code itself is never shown again. Lost it? Generate a new one — the old code stops
              working immediately and the new one is shown once.
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
  const refresh = () => qc.invalidateQueries({ queryKey: keys.sessions });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/customer/auth/sessions/${id}`),
    onSuccess: refresh,
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.post('/customer/auth/sessions/revoke-others'),
    onSuccess: refresh,
  });
  const logoutAll = useMutation({
    mutationFn: () => api.post('/customer/auth/logout-all'),
    onSuccess: async () => {
      queryClient.clear();
      await signOut().catch(() => undefined);
      navigate('/login');
    },
  });
  const others = sessions.data?.filter((s) => !s.current) ?? [];

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <p className="text-display-sm font-bold">Signed-in devices</p>
        <p className="text-sm text-body">
          Only a browser and system name is kept for each sign-in — no device fingerprint.
        </p>
        {sessions.isLoading && <LoadingState />}
        <ul className="flex flex-col divide-y divide-hairline" data-testid="sessions">
          {sessions.data?.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="font-medium">
                  {s.device ?? 'Unknown device'}{' '}
                  {s.current && (
                    <span className="ml-1 rounded-pill bg-ink px-2 py-0.5 text-xs text-on-dark">
                      This device
                    </span>
                  )}
                </p>
                <p className="text-sm text-body">
                  Signed in {dateFmt.format(new Date(s.createdAt))} · last active{' '}
                  {dateFmt.format(new Date(s.lastUsedAt))}
                </p>
              </div>
              {!s.current && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => revoke.mutate(s.id)}
                  aria-label={`Sign out ${s.device ?? 'device'}`}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
        <InlineError error={revoke.error ?? revokeOthers.error ?? logoutAll.error} />
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button variant="subtle" onClick={() => void signOut().then(() => navigate('/'))}>
            Sign out
          </Button>
          {others.length > 0 && (
            <Button
              variant="subtle"
              loading={revokeOthers.isPending}
              onClick={() => revokeOthers.mutate()}
            >
              Sign out other devices
            </Button>
          )}
          <Button
            variant="secondary"
            loading={logoutAll.isPending}
            onClick={() => logoutAll.mutate()}
          >
            Sign out everywhere
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ActivityCard() {
  const activity = useQuery({
    queryKey: keys.activity,
    queryFn: () => api.get<CustomerSecurityEventDto[]>('/customer/account/activity', { limit: 20 }),
  });
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <p id="activity" className="text-display-sm font-bold">
          Account activity
        </p>
        {activity.isLoading && <LoadingState />}
        {activity.data?.length === 0 && <p className="text-body">No activity yet.</p>}
        <ul className="flex flex-col divide-y divide-hairline" data-testid="activity">
          {activity.data?.map((e) => (
            <li key={e.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
              <span className="font-medium">{e.label}</span>
              <span className="text-body">
                {dateFmt.format(new Date(e.createdAt))}
                {e.device ? ` · ${e.device}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** JSON download of your own data (requires a recent password confirmation). */
function DataExportCard() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const download = useMutation({
    mutationFn: async () => {
      const { blob, headers } = await api.blob('/customer/account/export', {
        headers: { 'X-Recent-Auth': recentAuthToken() ?? '' },
      });
      const name =
        /filename="([^"]+)"/.exec(headers.get('Content-Disposition') ?? '')?.[1] ??
        'helmet-account-export.json';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    onSuccess: () => setDone(true),
  });
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <p className="text-display-sm font-bold">Download your data</p>
        <p className="text-sm text-body">
          A JSON file with your account, helmets, ownership history, emergency profile, contacts,
          privacy settings, warranties and account activity. It never contains passwords or recovery
          codes. Keep it safe — it includes your medical information.
        </p>
        {!open ? (
          <div>
            <Button variant="subtle" onClick={() => setOpen(true)}>
              Request data export
            </Button>
          </div>
        ) : (
          <RecentAuthGate intro="Confirm your password to download your data.">
            <div className="flex flex-col gap-2">
              <InlineError error={download.error} />
              {done && <p className="text-sm font-medium">Your download has started.</p>}
              <div>
                <Button loading={download.isPending} onClick={() => download.mutate()}>
                  Download my data (JSON)
                </Button>
              </div>
            </div>
          </RecentAuthGate>
        )}
      </CardContent>
    </Card>
  );
}

/** Deletion is a reviewed request; nothing is erased automatically. */
function DeletionCard() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const request = useQuery({
    queryKey: keys.deletion,
    queryFn: () => api.get<AccountDeletionRequestDto | null>('/customer/account/deletion-request'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['account'] });
  const create = useMutation({
    mutationFn: () =>
      api.request<AccountDeletionRequestDto>('/customer/account/deletion-request', {
        method: 'POST',
        body: { reason: reason.trim() || undefined },
        headers: { 'X-Recent-Auth': recentAuthToken() ?? '' },
      }),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      void refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.delete('/customer/account/deletion-request'),
    onSuccess: () => void refresh(),
  });
  const current = request.data;
  const pending = current && (current.status === 'REQUESTED' || current.status === 'APPROVED');
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <p className="text-display-sm font-bold">Delete account</p>
        {pending ? (
          <div className="flex flex-col gap-3" data-testid="deletion-pending">
            <p className="font-medium">
              Deletion requested on {dateFmt.format(new Date(current.requestedAt))} (
              {current.status === 'APPROVED' ? 'approved, awaiting completion' : 'awaiting review'}
              ).
            </p>
            <p className="text-sm text-body">You can cancel the request until it is completed.</p>
            <InlineError error={cancel.error} />
            <div>
              <Button
                variant="secondary"
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel deletion request
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-body">
              Support reviews deletion requests. Helmet, warranty and other records we must keep for
              product safety or legal reasons may be retained or anonymised. Your emergency
              information stops being shared when the deletion is completed.
            </p>
            {current?.status === 'CANCELLED' && (
              <p className="text-sm">Your previous request was cancelled.</p>
            )}
            {current?.status === 'REJECTED' && (
              <p className="text-sm">Your previous request was declined by support.</p>
            )}
            {!open ? (
              <div>
                <Button variant="ghost" onClick={() => setOpen(true)}>
                  Request account deletion
                </Button>
              </div>
            ) : (
              <RecentAuthGate intro="Confirm your password to request account deletion.">
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    create.mutate();
                  }}
                >
                  <Field label="Reason (optional)" htmlFor="del-reason">
                    <Input
                      id="del-reason"
                      value={reason}
                      maxLength={500}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </Field>
                  <InlineError error={create.error} />
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button type="submit" variant="secondary" loading={create.isPending}>
                      Request deletion
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                      Keep my account
                    </Button>
                  </div>
                </form>
              </RecentAuthGate>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Permanent public Customer ID — not a secret; the password is still required to sign in. */
function CustomerIdCard() {
  const { customer } = useCustomerAuth();
  const [copied, setCopied] = useState(false);
  if (!customer) return null;
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <p className="text-display-sm font-bold">Customer ID</p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-xl font-bold tracking-wide" data-testid="customer-id">
            {customer.customerId}
          </span>
          <Button
            variant="subtle"
            size="sm"
            onClick={() =>
              void navigator.clipboard?.writeText(customer.customerId).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-sm text-body">
          You can also sign in with your Customer ID, and share it with support. Your password is
          still needed to sign in, and your recovery code remains the way to reset it.
        </p>
      </CardContent>
    </Card>
  );
}

type EmailStep = 'view' | 'edit' | 'confirm';

/**
 * The account email is the normal sign-in identifier. Changing it needs the current password and
 * the new address typed twice; there is no verification email (no OTP). Other devices are
 * signed out after a change.
 */
function AccountEmailCard() {
  const { customer, setCustomer } = useCustomerAuth();
  const [step, setStep] = useState<EmailStep>('view');
  const [email, setEmail] = useState('');
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const change = useMutation({
    mutationFn: () =>
      api.post<CustomerProfile>('/customer/auth/email', {
        currentPassword: password,
        newEmail: email.trim(),
        confirmEmail: confirm.trim(),
      }),
    onSuccess: (c) => {
      setCustomer(c);
      setEmail('');
      setConfirm('');
      setPassword('');
      setChanged(true);
      setStep('view');
      void queryClient.invalidateQueries({ queryKey: keys.sessions });
    },
  });
  if (!customer) return null;
  const reset = () => {
    setStep('view');
    setProblem(null);
    setPassword('');
    change.reset();
  };
  const review = (e: FormEvent) => {
    e.preventDefault();
    const p =
      emailClientProblem(email) ??
      (normalizeEmail(email)?.normalized !== normalizeEmail(confirm)?.normalized
        ? 'The two email addresses do not match.'
        : null) ??
      (password ? null : 'Enter your current password.');
    setProblem(p);
    if (!p) setStep('confirm');
  };
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <p className="text-display-sm font-bold">Account email</p>
        {step === 'view' && (
          <>
            <p className="break-all text-lg font-medium" data-testid="account-email">
              {customer.email ?? 'No email set'}
            </p>
            <p className="text-sm text-body">You sign in with this email and your password.</p>
            {changed && (
              <p className="text-sm font-medium">
                Email updated. Your other devices were signed out.
              </p>
            )}
            <div>
              <Button
                variant="subtle"
                onClick={() => {
                  setChanged(false);
                  setStep('edit');
                }}
              >
                {customer.email ? 'Change email' : 'Add email'}
              </Button>
            </div>
          </>
        )}
        {step === 'edit' && (
          <form className="flex flex-col gap-4" onSubmit={review} noValidate>
            <EmailField
              id="ce-email"
              label="New email"
              value={email}
              onChange={setEmail}
              autoFocus
            />
            <EmailField
              id="ce-confirm"
              label="Confirm new email"
              value={confirm}
              onChange={setConfirm}
              hint=""
            />
            <Field label="Current password" htmlFor="ce-password">
              <Input
                id="ce-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {problem && <p className="text-sm text-danger">{problem}</p>}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit">Continue</Button>
              <Button type="button" variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {step === 'confirm' && (
          <div className="flex flex-col gap-4">
            <p className="text-body">You will sign in with:</p>
            <p className="break-all text-lg font-bold" data-testid="confirm-new-email">
              {normalizeEmail(email)?.email ?? email}
            </p>
            <p className="rounded-xl bg-canvas-soft p-3 text-sm font-medium">{EMAIL_WARNING}</p>
            <p className="text-sm text-body">Your other signed-in devices will be signed out.</p>
            <InlineError error={change.error} />
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button loading={change.isPending} onClick={() => change.mutate()}>
                Confirm email change
              </Button>
              <Button variant="ghost" onClick={() => setStep('edit')}>
                Back
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
