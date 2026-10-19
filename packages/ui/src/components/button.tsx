import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn';
import { Spinner } from './spinner';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 cursor-pointer select-none',
  {
    variants: {
      variant: {
        /** The orange conversion CTA. */
        primary: 'bg-primary text-on-primary hover:bg-primary-hover',
        /** Dark coffee-ink CTA. */
        dark: 'bg-ink text-on-dark hover:bg-ink-soft',
        /** Outline CTA: 1px ink border on canvas. */
        secondary:
          'bg-canvas text-ink border border-ink hover:bg-canvas-soft active:bg-surface-pressed',
        subtle: 'bg-canvas-soft text-ink hover:bg-surface-pressed',
        ghost: 'bg-transparent text-ink hover:bg-canvas-soft',
        danger: 'bg-danger text-on-dark hover:opacity-90',
        onDark: 'bg-canvas text-ink hover:bg-surface-pressed',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-12 px-6 text-base',
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
