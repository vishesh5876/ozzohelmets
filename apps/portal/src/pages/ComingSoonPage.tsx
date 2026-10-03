import { Link, useSearchParams } from 'react-router-dom';
import { buttonVariants, Card, CardContent } from '@helmet/ui';
import { SiteFrame } from './SiteFrame';

/** Simple placeholder page (used for not-found routes). */
export function ComingSoonPage({ title, description }: { title: string; description: string }) {
  const [params] = useSearchParams();
  const fromQr = params.has('t');
  return (
    <SiteFrame>
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-8">
        <Card>
          <CardContent className="p-8">
            <h1 className="text-display-lg font-bold">{title}</h1>
            <p className="mt-3 text-lg text-body">{description}</p>
            {fromQr && (
              <p className="mt-3 rounded-md bg-canvas-soft p-4 text-sm">
                Keep the Helmet ID and activation PIN from your helmet label safe — you will need
                them to activate.
              </p>
            )}
            <Link to="/" className={buttonVariants({ variant: 'subtle', className: 'mt-6' })}>
              Back to home
            </Link>
          </CardContent>
        </Card>
      </div>
    </SiteFrame>
  );
}
