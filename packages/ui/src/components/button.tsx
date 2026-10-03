import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn';
import { Spinner } from './spinner';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 cursor-pointer select-none',
  {
    variants: {
      variant: {
        primary: 'bg-ink text-on-dark hover:bg-black-elevated',
        secondary:
          'bg-canvas text-ink border border-hairline hover:bg-canvas-softer active:bg-surface-pressed',
        subtle: 'bg-canvas-soft text-ink hover:bg-surface-pressed',
        ghost: 'bg-transparent text-ink hover:bg-canvas-soft',
        danger: 'bg-danger text-on-dark hover:opacity-90',
        onDark: 'bg-canvas text-ink hover:bg-surface-pressed',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-11 px-5 text-base',
        lg: 'h-14 px-6 text-lg',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, loading = false, disabled, children, type = 'button', ...props },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';
