import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import type { CustomerHelmetDto } from '@helmet/types';
import { Button, buttonVariants, Card, CardContent } from '@helmet/ui';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { SetupProgress, type SetupStep } from '../activation/SetupProgress';
import { ContactsManager } from '../emergency/ContactsManager';
import { EnableProfileCard } from '../emergency/EnableProfileCard';
import { useContacts } from '../emergency/hooks';
import { ProfileForm } from '../emergency/ProfileForm';
import { PublicPreview } from '../emergency/PublicPreview';
import { VisibilityForm } from '../emergency/VisibilityForm';

const STEPS = [
  {
    key: 'details',
    title: 'Emergency details',
    description: 'Only your name is required. Add what would help a first responder.',
  },
  {
    key: 'contacts',
    title: 'Emergency contacts',
    description: 'Who should be called first? Add at least one — two is better.',
  },
  {
    key: 'privacy',
    title: 'Choose public information',
    description: 'Decide exactly what anyone scanning your helmet can see.',
  },
  {
    key: 'review',
    title: 'Review your emergency page',
    description: 'This is what responders will see.',
  },
  {
    key: 'enable',
    title: 'Turn on your emergency profile',
    description: 'Your helmet’s QR code will start showing this information.',
  },
  { key: 'done', title: 'All set', description: '' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];
const PROGRESS: Record<StepKey, SetupStep> = {
  details: 'Emergency details',
  contacts: 'Emergency contact',
  privacy: 'Privacy',
  review: 'Privacy',
  enable: 'Finish',
  done: 'Finish',
};

/** Post-activation onboarding, one focused step at a time (step kept in the URL for back/forward). */
export function OnboardingPage() {
  const [params, setParams] = useSearchParams();
  const current = (STEPS.find((s) => s.key === params.get('step'))?.key ?? 'details') as StepKey;
  const index = STEPS.findIndex((s) => s.key === current);
  const step = STEPS[index]!;
  const helmetId = params.get('helmet');
  const go = (key: StepKey) => {
    setParams(helmetId ? { step: key, helmet: helmetId } : { step: key });
    window.scrollTo({ top: 0 });
  };
  const next = () => go(STEPS[Math.min(index + 1, STEPS.length - 1)]!.key);
  const contacts = useContacts();

  return (
    <div className="mx-auto max-w-2xl">
      {current !== 'done' && <SetupProgress current={PROGRESS[current]} />}
      {current !== 'done' && (
        <>
          <h1 className="mt-4 text-display-md font-bold">{step.title}</h1>
          <p className="mb-6 mt-1 text-body">{step.description}</p>
        </>
      )}

      {current === 'details' && <ProfileForm submitLabel="Save and continue" onSaved={next} />}
      {current === 'contacts' && (
        <div className="flex flex-col gap-6">
          <ContactsManager />
          <Button size="lg" disabled={!contacts.data?.length} onClick={next}>
            Continue
          </Button>
        </div>
      )}
      {current === 'privacy' && <VisibilityForm submitLabel="Save and continue" onSaved={next} />}
      {current === 'review' && (
        <div className="flex flex-col gap-6">
          <PublicPreview />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button size="lg" onClick={next} className="flex-1">
              Looks good
            </Button>
            <Button variant="subtle" size="lg" onClick={() => go('privacy')}>
              Change what’s shown
            </Button>
          </div>
        </div>
      )}
      {current === 'enable' && <EnableProfileCard onEnabled={() => go('done')} />}
      {current === 'done' && <SetupComplete helmetId={helmetId} />}
      {current !== 'done' && index > 0 && (
        <button
          type="button"
          className="mt-6 text-sm font-medium text-body underline underline-offset-4"
          onClick={() => go(STEPS[index - 1]!.key)}
        >
          Back
        </button>
      )}
    </div>
  );
}

/** Factual summary after setup: what is now true for this helmet, and where to go next. */
function SetupComplete({ helmetId }: { helmetId: string | null }) {
  const contacts = useContacts();
  const helmets = useQuery({
    queryKey: keys.helmets,
    queryFn: () => api.get<CustomerHelmetDto[]>('/customer/helmets'),
  });
  const [copied, setCopied] = useState(false);
  const list = helmets.data ?? [];
  const helmet =
    list.find((h) => h.id === helmetId) ??
    list.find((h) => h.group === 'ACTIVE' && h.emergencyEnabled) ??
    list[0];
  const sharing = helmet?.emergencyEnabled ?? false;
  return (
    <Card className="border-ink" data-testid="setup-complete">
      <CardContent className="flex flex-col items-start gap-5 py-8">
        <CheckCircle2 className="h-12 w-12" aria-hidden />
        <div>
          <h1 className="text-display-md font-bold">
            {sharing ? 'Emergency information is active' : 'Emergency profile saved'}
          </h1>
          <p className="mt-1 text-body">
            {sharing
              ? 'Anyone who scans the QR code on this helmet now sees the information you chose to share. You can change it any time.'
              : 'Your profile is saved, but it is not shown on this helmet yet. Turn sharing on from the helmet page.'}
          </p>
        </div>
        {helmet && (
          <dl className="grid w-full gap-3 rounded-xl bg-canvas-soft p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-body">Helmet ID</dt>
              <dd className="font-mono text-lg font-bold">{helmet.helmetCode}</dd>
            </div>
            <div>
              <dt className="text-body">Emergency profile</dt>
              <dd className="font-bold">
                {helmet.emergencyProfileStatus === 'ACTIVE' ? 'Active' : 'Not active'}
              </dd>
            </div>
            <div>
              <dt className="text-body">Emergency contacts</dt>
              <dd className="font-bold tabular-nums">{contacts.data?.length ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-body">QR emergency sharing</dt>
              <dd className="font-bold">{sharing ? 'On' : 'Off'}</dd>
            </div>
          </dl>
        )}
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap">
          {helmet && (
            <Link
              to={`/app/helmets/${helmet.id}`}
              className={buttonVariants({ size: 'lg', className: 'sm:flex-1' })}
            >
              View my helmet
            </Link>
          )}
          {helmet && sharing && (
            <a
              href={helmet.publicUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'secondary', size: 'lg' })}
            >
              View emergency page
            </a>
          )}
          {helmet && (
            <Button
              variant="subtle"
              size="lg"
              onClick={() =>
                void navigator.clipboard?.writeText(helmet.helmetCode).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
              }
            >
              {copied ? 'Helmet ID copied' : 'Copy Helmet ID'}
            </Button>
          )}
        </div>
        <Link to="/app" className="font-medium underline underline-offset-4">
          Go to dashboard
        </Link>
      </CardContent>
    </Card>
  );
}
