import type { BatchDto } from '@helmet/types';
import { Badge } from '@helmet/ui';

export function GenerationBadge({ status }: { status: BatchDto['generationStatus'] }) {
  const map = {
    PENDING: { tone: 'outline', label: 'Not generated' },
    GENERATING: { tone: 'soft', label: 'Generating' },
    COMPLETED: { tone: 'solid', label: 'Generated' },
    FAILED: { tone: 'danger', label: 'Failed' },
  } as const;
  const { tone, label } = map[status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function PrintBadge({ status }: { status: BatchDto['printStatus'] }) {
  return status === 'PRINTED' ? (
    <Badge tone="success">Printed</Badge>
  ) : (
    <Badge tone="muted">Not printed</Badge>
  );
}

export function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-pill bg-canvas-soft"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div
        className="h-full rounded-pill bg-ink transition-[width] duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
