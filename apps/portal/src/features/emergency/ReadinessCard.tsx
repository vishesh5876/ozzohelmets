import { Link } from 'react-router-dom';
import type { EmergencyReadinessDto } from '@helmet/types';
import { Card, CardContent, cn } from '@helmet/ui';

const STEP_LABELS: Record<EmergencyReadinessDto['steps'][number]['key'], string> = {
  ACTIVATED: 'Helmet activated',
  DETAILS: 'Emergency details',
  CONTACTS: 'Emergency contacts',
  PRIVACY: 'Privacy reviewed',
  ENABLED: 'Profile turned on',
};

/** Progress is a UX hint only; the API decides whether the profile can be enabled. */
export function ReadinessCard({ readiness }: { readiness: EmergencyReadinessDto }) {
  const done = readiness.status === 'ACTIVE';
  return (
    <Card className={done ? 'border-ink' : ''}>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-body">Emergency profile</p>
            <p className="text-display-sm font-bold">{done ? 'Active' : 'Not active yet'}</p>
          </div>
          <p className="text-display-lg font-bold tabular-nums">{readiness.completionPercent}%</p>
        </div>
        <div
          className="h-2 overflow-hidden rounded-pill bg-canvas-soft"
          role="progressbar"
          aria-valuenow={readiness.completionPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Profile completion"
        >
          <div
            className="h-full rounded-pill bg-ink transition-[width]"
            style={{ width: `${readiness.completionPercent}%` }}
          />
        </div>
        <ul className="grid gap-2 sm:grid-cols-5">
          {readiness.steps.map((s) => (
            <li
              key={s.key}
              className={cn('flex items-center gap-2 text-sm', s.done ? 'text-ink' : 'text-body')}
            >
              <span
                aria-hidden
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold',
                  s.done ? 'bg-ink text-on-dark' : 'border border-hairline-mid/40',
                )}
              >
                {s.done ? '✓' : ''}
              </span>
              {STEP_LABELS[s.key]}
              <span className="sr-only">{s.done ? '(done)' : '(to do)'}</span>
            </li>
          ))}
        </ul>
        {!done && (
          <Link
            to="/app/onboarding"
            className="inline-flex h-11 items-center justify-center rounded-pill bg-ink px-5 font-medium text-on-dark hover:bg-black-elevated"
          >
            Continue setup
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
