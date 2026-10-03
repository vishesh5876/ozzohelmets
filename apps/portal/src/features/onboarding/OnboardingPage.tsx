import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { Button, buttonVariants, Card, CardContent, cn } from '@helmet/ui';
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

/** Post-activation onboarding, one focused step at a time (step kept in the URL for back/forward). */
export function OnboardingPage() {
  const [params, setParams] = useSearchParams();
  const current = (STEPS.find((s) => s.key === params.get('step'))?.key ?? 'details') as StepKey;
  const index = STEPS.findIndex((s) => s.key === current);
  const step = STEPS[index]!;
  const go = (key: StepKey) => {
    setParams({ step: key });
    window.scrollTo({ top: 0 });
  };
  const next = () => go(STEPS[Math.min(index + 1, STEPS.length - 1)]!.key);
  const contacts = useContacts();

  return (
    <div className="mx-auto max-w-2xl">
      {current !== 'done' && (
        <ol className="mb-6 flex gap-1.5" aria-label="Setup progress">
          {STEPS.slice(0, -1).map((s, i) => (
            <li
              key={s.key}
              className={cn('h-1.5 flex-1 rounded-pill', i <= index ? 'bg-ink' : 'bg-canvas-soft')}
              aria-current={i === index ? 'step' : undefined}
            >
              <span className="sr-only">{s.title}</span>
            </li>
          ))}
        </ol>
      )}
      {current !== 'done' && (
        <>
          <p className="text-sm font-medium text-body">
            Step {index + 1} of {STEPS.length - 1}
          </p>
          <h1 className="text-display-md font-bold">{step.title}</h1>
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
      {current === 'done' && (
        <Card className="border-ink">
          <CardContent className="flex flex-col items-start gap-4 py-10">
            <CheckCircle2 className="h-12 w-12" aria-hidden />
            <h1 className="text-display-md font-bold">Your helmet emergency profile is active.</h1>
            <p className="text-body">
              Anyone who scans your helmet’s QR code will now see the information you chose to
              share. You can change it any time.
            </p>
            <Link to="/app" className={buttonVariants({ size: 'lg' })}>
              Go to dashboard
            </Link>
          </CardContent>
        </Card>
      )}
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
