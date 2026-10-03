import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  type CustomerHelmetDetailDto,
  type DamageReason,
  type PendingTransferDto,
  type TransferCreatedResponse,
} from '@helmet/types';
import { Button, Card, CardContent, Field, Input, Select, Textarea } from '@helmet/ui';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { postWithRecentAuth } from '../../lib/recent-auth';
import { ACTION_PAGES, type ActionSlug } from '../helmets/lifecycle-labels';
import { RecentAuthGate } from './ConfirmPassword';

const SLUG_ACTION = Object.fromEntries(
  Object.entries(ACTION_PAGES).map(([action, page]) => [page!.slug, action]),
) as Record<ActionSlug, string>;

/** Confirmation pages for owner lifecycle actions — never one-click. */
export function HelmetActionPage() {
  const { id = '', action = '' } = useParams();
  const slug = action as ActionSlug;
  const {
    data: helmet,
    isLoading,
    error,
  } = useQuery({
    queryKey: keys.helmet(id),
    queryFn: () => api.get<CustomerHelmetDetailDto>(`/customer/helmets/${id}`),
  });
  if (isLoading) return <LoadingState />;
  if (error || !helmet) return <ErrorState error={error} />;
  const allowed = helmet.availableActions.includes(SLUG_ACTION[slug] as never);

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Link to={`/app/helmets/${id}`} className="text-sm font-medium text-body hover:text-ink">
        ← {helmet.helmetCode}
      </Link>
      {!allowed ? (
        <Card>
          <CardContent>
            <p className="font-bold">This action isn’t available</p>
            <p className="mt-1 text-body">It doesn’t apply to this helmet in its current state.</p>
          </CardContent>
        </Card>
      ) : slug === 'transfer' ? (
        <TransferPanel helmet={helmet} />
      ) : (
        <LifecycleConfirm helmet={helmet} slug={slug} />
      )}
    </div>
  );
}

function useAfterChange(id: string) {
  const qc = useQueryClient();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.helmets }),
      qc.invalidateQueries({ queryKey: keys.dashboard }),
    ]);
    await qc.invalidateQueries({ queryKey: keys.helmet(id) });
  };
}

const COPY: Record<
  Exclude<ActionSlug, 'transfer'>,
  { title: string; body: ReactNode; button: string; sensitive: boolean }
> = {
  lost: {
    title: 'Mark this helmet as lost?',
    body: (
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Anyone who scans it will see “This helmet has been reported lost” — no personal or medical
          information.
        </li>
        <li>You stay the owner. This does not transfer the helmet.</li>
        <li>If you find it, mark it as found to restore it.</li>
      </ul>
    ),
    button: 'Report lost',
    sensitive: false,
  },
  found: {
    title: 'Mark this helmet as found?',
    body: 'It returns to the state it was in before it was reported lost.',
    button: 'Mark as found',
    sensitive: false,
  },
  stolen: {
    title: 'Report this helmet stolen?',
    body: (
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Scans will show “This helmet has been reported stolen” — your name, phone and medical
          information are hidden.
        </li>
        <li>Transfers are blocked and any pending transfer code is cancelled.</li>
        <li>You stay the owner and can mark it recovered later.</li>
      </ul>
    ),
    button: 'Report stolen',
    sensitive: true,
  },
  recovered: {
    title: 'Mark this helmet as recovered?',
    body: 'It returns to the state it was in before it was reported stolen.',
    button: 'Mark as recovered',
    sensitive: true,
  },
  damaged: {
    title: 'Mark this helmet as damaged?',
    body: 'A damaged helmet may not protect you. Scans will show that it is marked as damaged, without your information, and it can no longer be transferred. Contact support if you marked it by mistake.',
    button: 'Mark damaged',
    sensitive: false,
  },
  retire: {
    title: 'Retire this helmet permanently?',
    body: 'Retiring removes it from active use for good: scans will show it is no longer active. Your history is kept. Only support can undo this.',
    button: 'Retire helmet',
    sensitive: true,
  },
};

const ENDPOINT: Record<Exclude<ActionSlug, 'transfer'>, string> = {
  lost: 'lost',
  found: 'found',
  stolen: 'stolen',
  recovered: 'recovered',
  damaged: 'damaged',
  retire: 'deactivate',
};

function LifecycleConfirm({
  helmet,
  slug,
}: {
  helmet: CustomerHelmetDetailDto;
  slug: Exclude<ActionSlug, 'transfer'>;
}) {
  const navigate = useNavigate();
  const afterChange = useAfterChange(helmet.id);
  const copy = COPY[slug];
  const [reason, setReason] = useState<DamageReason | ''>('');
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');
  const run = useMutation({
    mutationFn: () => {
      const path = `/customer/helmets/${helmet.id}/${ENDPOINT[slug]}`;
      const body =
        slug === 'damaged'
          ? { reason: reason || undefined, note: note.trim() || undefined }
          : slug === 'retire'
            ? { confirmHelmetCode: typed }
            : {};
      return copy.sensitive ? postWithRecentAuth(path, body) : api.post(path, body);
    },
    onSuccess: async () => {
      await afterChange();
      navigate(`/app/helmets/${helmet.id}`);
    },
  });

  const form = (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        run.mutate();
      }}
    >
      <div className="text-body">{copy.body}</div>
      {slug === 'damaged' && (
        <>
          <Field label="What happened? (optional)" htmlFor="damage-reason">
            <Select
              id="damage-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as DamageReason)}
            >
              <option value="">Prefer not to say</option>
              <option value="ACCIDENT">Accident</option>
              <option value="IMPACT">Impact</option>
              <option value="CRACKED">Cracked</option>
              <option value="OTHER">Other</option>
            </Select>
          </Field>
          <Field
            label="Note (optional)"
            htmlFor="damage-note"
            hint="Up to 200 characters. No medical details."
          >
            <Textarea
              id="damage-note"
              maxLength={200}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </>
      )}
      {slug === 'retire' && (
        <Field label={`Type ${helmet.helmetCode} to confirm`} htmlFor="retire-confirm">
          <Input
            id="retire-confirm"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>
      )}
      <InlineError error={run.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          loading={run.isPending}
          disabled={
            slug === 'retire' && typed.trim().toUpperCase().replace(/\s/g, '') !== helmet.helmetCode
          }
        >
          {copy.button}
        </Button>
        <Link
          to={`/app/helmets/${helmet.id}`}
          className="inline-flex items-center px-4 text-sm font-medium text-body hover:text-ink"
        >
          Cancel
        </Link>
      </div>
    </form>
  );

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <h1 className="text-display-sm font-bold">{copy.title}</h1>
        {copy.sensitive ? <RecentAuthGate>{form}</RecentAuthGate> : form}
      </CardContent>
    </Card>
  );
}

function useCountdown(until: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return '';
  const left = Math.max(0, new Date(until).getTime() - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function TransferPanel({ helmet }: { helmet: CustomerHelmetDetailDto }) {
  const qc = useQueryClient();
  const afterChange = useAfterChange(helmet.id);
  const [issued, setIssued] = useState<TransferCreatedResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const pending = useQuery({
    queryKey: ['helmets', helmet.id, 'transfer'],
    queryFn: () => api.get<PendingTransferDto>(`/customer/helmets/${helmet.id}/transfer`),
  });
  const create = useMutation({
    mutationFn: () =>
      postWithRecentAuth<TransferCreatedResponse>(`/customer/helmets/${helmet.id}/transfer`),
    onSuccess: async (r) => {
      setIssued(r);
      await qc.invalidateQueries({ queryKey: ['helmets', helmet.id, 'transfer'] });
      await afterChange();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.delete(`/customer/helmets/${helmet.id}/transfer`),
    onSuccess: async () => {
      setIssued(null);
      await qc.invalidateQueries({ queryKey: ['helmets', helmet.id, 'transfer'] });
      await afterChange();
    },
  });
  const expiresAt = issued?.expiresAt ?? pending.data?.expiresAt ?? null;
  const countdown = useCountdown(expiresAt);
  const active = !!expiresAt && countdown !== '0:00';

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div>
          <h1 className="text-display-sm font-bold">Transfer this helmet</h1>
          <p className="mt-1 text-body">
            Transfer this helmet to another owner. Give them the Helmet ID and a one-time transfer
            code; they enter both under “Claim a helmet”. Your emergency information stops showing
            on this helmet the moment they claim it.
          </p>
        </div>
        {issued && active ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-body">Transfer code — shown only once</p>
            <p
              className="rounded-xl border-2 border-dashed border-ink bg-canvas-softer px-4 py-5 text-center font-mono text-2xl font-bold tracking-wider"
              data-testid="transfer-code"
            >
              {issued.transferCode}
            </p>
            <p className="text-sm">
              Helmet ID <span className="font-mono font-bold">{helmet.helmetCode}</span> · expires
              in <span data-testid="transfer-countdown">{countdown}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="subtle"
                size="sm"
                onClick={() =>
                  void navigator.clipboard?.writeText(issued.transferCode).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })
                }
              >
                {copied ? 'Copied' : 'Copy code'}
              </Button>
            </div>
            <p className="text-xs text-body">
              This is not your recovery code. Never share your recovery code with anyone.
            </p>
          </div>
        ) : active ? (
          <p className="rounded-md bg-canvas-soft px-4 py-3 text-sm">
            A transfer code is active for another {countdown}. For security it can’t be shown again
            — generate a new one if needed (the old one stops working).
          </p>
        ) : null}
        <InlineError error={create.error ?? cancel.error} />
        <RecentAuthGate intro="Transferring ownership is sensitive. Confirm your password to continue.">
          <div className="flex flex-wrap gap-2">
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              {active ? 'Generate new code' : 'Generate transfer code'}
            </Button>
            {active && (
              <Button
                variant="secondary"
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel transfer
              </Button>
            )}
          </div>
        </RecentAuthGate>
      </CardContent>
    </Card>
  );
}
