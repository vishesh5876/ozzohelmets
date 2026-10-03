import { Link } from 'react-router-dom';
import type { CustomerHelmetDto } from '@helmet/types';
import { Badge, buttonVariants, HelmetStatusBadge } from '@helmet/ui';
import { ACTION_PAGES } from './lifecycle-labels';
import { warrantyLine } from '../warranty/warranty-labels';
import { PROFILE_LABEL } from './profile-label';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function HelmetCard({ helmet }: { helmet: CustomerHelmetDto }) {
  const profile = PROFILE_LABEL[helmet.emergencyProfileStatus];
  const quick = helmet.availableActions
    .map((a) => ACTION_PAGES[a])
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
    .slice(0, 3);
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-hairline p-5 transition-colors hover:border-ink"
      data-testid="helmet-card"
    >
      <Link to={`/app/helmets/${helmet.id}`} className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-body">
              {helmet.model.brand} {helmet.model.name}
            </p>
            <p className="font-mono text-lg font-bold">{helmet.helmetCode}</p>
          </div>
          <HelmetStatusBadge status={helmet.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-body">
          {helmet.group !== 'RETIRED' && <Badge tone={profile.tone}>{profile.label}</Badge>}
          {helmet.pendingTransfer && <Badge tone="soft">Transfer pending</Badge>}
          {helmet.activatedAt && (
            <span>Activated {dateFmt.format(new Date(helmet.activatedAt))}</span>
          )}
        </div>
        {helmet.group !== 'RETIRED' && (
          <p className="text-sm text-body">{warrantyLine(helmet.warranty)}</p>
        )}
        {helmet.replacedBy && (
          <p className="text-sm text-body">
            Replaced by <span className="font-mono">{helmet.replacedBy.helmetCode}</span>
          </p>
        )}
      </Link>
      <div className="flex flex-wrap gap-2">
        <Link
          to={`/app/helmets/${helmet.id}`}
          className={buttonVariants({ variant: 'subtle', size: 'sm' })}
        >
          View
        </Link>
        {quick.map((a) => (
          <Link
            key={a.slug}
            to={`/app/helmets/${helmet.id}/${a.slug}`}
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            {a.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
