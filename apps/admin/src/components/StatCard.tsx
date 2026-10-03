import type { ReactNode } from 'react';
import { cn } from '@helmet/ui';

export function StatCard({
  label,
  value,
  hint,
  inverted = false,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  inverted?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-xl p-5',
        inverted ? 'bg-ink text-on-dark' : 'border border-hairline bg-canvas',
      )}
    >
      <p className={cn('text-sm font-medium', inverted ? 'text-mute' : 'text-body')}>{label}</p>
      <p className="mt-2 text-display-lg font-bold tabular-nums">{value}</p>
      {hint && <p className={cn('mt-1 text-xs', inverted ? 'text-mute' : 'text-body')}>{hint}</p>}
    </div>
  );
}
