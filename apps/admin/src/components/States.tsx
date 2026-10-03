import type { ReactNode } from 'react';
import { AlertTriangle, Inbox } from 'lucide-react';
import { Button, Spinner } from '@helmet/ui';
import { errorMessage } from '../lib/api';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-body">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-hairline bg-canvas px-6 py-12 text-center"
    >
      <AlertTriangle className="h-6 w-6 text-danger" aria-hidden />
      <p className="font-medium">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="subtle" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-hairline bg-canvas px-6 py-14 text-center">
      <Inbox className="h-6 w-6 text-mute" aria-hidden />
      <p className="font-bold">{title}</p>
      {description && <p className="max-w-md text-sm text-body">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
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
