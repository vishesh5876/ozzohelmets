import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PublicEmergencyDto } from '@helmet/types';
import { EMERGENCY_NUMBER } from '../lib/config';
import { type EmergencyLookup, lookupEmergency } from '../lib/public-api';

/**
 * Public page opened by scanning a helmet QR code. Optimised for first responders:
 * no login, no web fonts, no query library, huge tap targets, and the emergency call button
 * is visible immediately — before (and regardless of) the lookup result.
 */
export function EmergencyPage() {
  const { token = '' } = useParams();
  const [result, setResult] = useState<EmergencyLookup | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setResult(null);
      lookupEmergency(token, signal)
        .then(setResult)
        .catch(() => undefined);
    },
    [token],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    document.title = 'Emergency information · Helmet ID';
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <header className="bg-ink px-5 pb-5 pt-[max(1.25rem,env(safe-area-inset-top))] text-on-dark">
        <p className="text-sm font-medium uppercase tracking-wide text-mute">Helmet ID</p>
        <h1 className="mt-1 text-[28px] font-bold leading-tight">Emergency information</h1>
      </header>

      <main
        className="flex flex-1 flex-col gap-5 px-5 py-6"
        aria-live="polite"
        aria-busy={result === null}
      >
        {result === null && <LoadingCard />}
        {result?.kind === 'ok' && <StateCard data={result.data} token={token} />}
        {result?.kind === 'not-found' && (
          <Message title="QR code not recognised">
            This code is not registered with Helmet ID. If this helmet carries our label, it may not
            be genuine.
          </Message>
        )}
        {result?.kind === 'rate-limited' && (
          <Message title="Please wait a moment">
            Too many requests from this network. Try again in a minute.
          </Message>
        )}
        {result?.kind === 'error' && (
          <Message title="Couldn’t load information">
            Check your connection and try again.
            <button
              type="button"
              onClick={() => load()}
              className="mt-4 block h-14 w-full rounded-pill bg-canvas-soft text-lg font-medium active:bg-surface-pressed"
            >
              Try again
            </button>
          </Message>
        )}
      </main>

      <footer className="sticky bottom-0 border-t border-hairline bg-canvas px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
        <a
          href={`tel:${EMERGENCY_NUMBER}`}
          aria-label={`Call emergency services on ${EMERGENCY_NUMBER}`}
          className="flex h-16 w-full items-center justify-center gap-3 whitespace-nowrap rounded-pill bg-danger text-xl font-bold text-on-dark active:opacity-90"
        >
          <PhoneIcon /> Call emergency {EMERGENCY_NUMBER}
        </a>
      </footer>
    </div>
  );
}

function StateCard({ data, token }: { data: PublicEmergencyDto; token: string }) {
  const model = `${data.helmet.brand} ${data.helmet.modelName}`;
  switch (data.state) {
    case 'NOT_ACTIVATED':
      return (
        <section className="rounded-xl border-2 border-ink p-6">
          <p className="text-sm font-medium text-body">{model}</p>
          <h2 className="mt-2 text-display-md font-bold">Helmet not activated</h2>
          <p className="mt-2 text-lg">{data.message}</p>
          <p className="mt-1 text-body">No emergency profile is linked to this helmet yet.</p>
          <Link
            to={`/activate?t=${encodeURIComponent(token)}`}
            className="mt-6 flex h-14 w-full items-center justify-center rounded-pill bg-ink text-lg font-medium text-on-dark active:bg-black-elevated"
          >
            Activate helmet
          </Link>
        </section>
      );
    case 'LOST':
    case 'STOLEN':
      return (
        <section className="rounded-xl bg-danger-soft p-6">
          <p className="text-sm font-medium text-danger">{model}</p>
          <h2 className="mt-2 text-display-md font-bold text-danger">
            {data.state === 'LOST' ? 'Reported lost' : 'Reported stolen'}
          </h2>
          <p className="mt-2 text-lg">{data.message}</p>
        </section>
      );
    case 'ACTIVE':
    case 'UNAVAILABLE':
      return (
        <section className="rounded-xl border border-hairline p-6">
          <p className="text-sm font-medium text-body">{model}</p>
          <p className="mt-2 text-lg">{data.message}</p>
        </section>
      );
  }
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-hairline p-6" role="status">
      <h2 className="text-display-sm font-bold">{title}</h2>
      <div className="mt-2 text-lg text-body">{children}</div>
    </section>
  );
}

function LoadingCard() {
  return (
    <section className="rounded-xl border border-hairline p-6">
      <div className="h-4 w-32 animate-pulse rounded-pill bg-canvas-soft" />
      <div className="mt-4 h-7 w-56 animate-pulse rounded-pill bg-canvas-soft" />
      <p className="mt-4 text-lg text-body">Loading emergency information…</p>
    </section>
  );
}

function PhoneIcon() {
  return (
    <svg
      aria-hidden
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}
