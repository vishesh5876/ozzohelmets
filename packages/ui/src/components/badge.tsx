import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import type { HelmetStatus } from '@helmet/types';
import { cn } from '../cn';

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        solid: 'bg-ink text-on-dark',
        soft: 'bg-canvas-soft text-ink',
        outline: 'border border-hairline-mid/40 text-hairline-mid',
        muted: 'bg-canvas-softer text-body',
        danger: 'bg-danger-soft text-danger',
        success: 'bg-success-soft text-success',
      },
    },
    defaultVariants: { tone: 'soft' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

type Tone = NonNullable<BadgeProps['tone']>;

const STATUS_TONE: Record<HelmetStatus, Tone> = {
  GENERATED: 'outline',
  PRINTED: 'soft',
  IN_INVENTORY: 'soft',
  SOLD: 'soft',
  ACTIVATED: 'success',
  ACTIVE: 'solid',
  LOST: 'danger',
  STOLEN: 'danger',
  DAMAGED: 'muted',
  REPLACED: 'muted',
  DEACTIVATED: 'muted',
  RECALLED: 'danger',
};

export function humanizeEnum(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function HelmetStatusBadge({
  status,
  className,
}: {
  status: HelmetStatus;
  className?: string;
}) {
  return (
    <Badge tone={STATUS_TONE[status]} className={className}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {humanizeEnum(status)}
    </Badge>
  );
}
