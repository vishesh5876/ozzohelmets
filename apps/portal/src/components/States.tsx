import type { ReactNode } from 'react';
import { Spinner } from '@helmet/ui';
import { errorMessage } from '../lib/api';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-body" role="status">
      <Spinner /> {label}
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">
      {errorMessage(error)}
    </p>
  );
}

export function ErrorState({ error, action }: { error: unknown; action?: ReactNode }) {
  return (
    <div role="alert" className="rounded-xl border border-hairline p-6 text-center">
      <p className="font-medium">{errorMessage(error)}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function SavedNote({ show }: { show: boolean }) {
  return (
    <span
      aria-live="polite"
      className={`text-sm text-success transition-opacity ${show ? 'opacity-100' : 'opacity-0'}`}
    >
      Saved
    </span>
  );
}
