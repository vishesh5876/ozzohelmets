import { cn } from '@helmet/ui';

/**
 * One progress indicator for the whole first-time journey, shared by activation (/activate) and
 * emergency setup (/app/onboarding) so the customer sees a single path instead of two flows.
 */
export const SETUP_STEPS = [
  'Verify helmet',
  'Create account',
  'Emergency details',
  'Emergency contact',
  'Privacy',
  'Finish',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export function SetupProgress({
  current,
  skip = [],
}: {
  current: SetupStep;
  /** Steps that do not apply (e.g. "Create account" when adding a helmet to an existing account). */
  skip?: SetupStep[];
}) {
  const steps = SETUP_STEPS.filter((s) => !skip.includes(s));
  const index = steps.indexOf(current);
  return (
    <div className="mt-4" data-testid="setup-progress">
      <p className="text-sm font-medium text-body">
        Step {index + 1} of {steps.length}: <span className="text-ink">{current}</span>
      </p>
      <ol className="mt-2 flex gap-1.5" aria-label="Setup progress">
        {steps.map((s, i) => (
          <li
            key={s}
            className={cn('h-1.5 flex-1 rounded-pill', i <= index ? 'bg-ink' : 'bg-canvas-soft')}
            aria-current={i === index ? 'step' : undefined}
          >
            <span className="sr-only">
              {s}
              {i < index ? ' (done)' : i === index ? ' (current step)' : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
