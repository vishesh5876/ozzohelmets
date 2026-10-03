import { Link } from 'react-router-dom';
import type { CustomerHelmetDto } from '@helmet/types';
import { Badge, HelmetStatusBadge } from '@helmet/ui';
import { PROFILE_LABEL } from './profile-label';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function HelmetCard({ helmet }: { helmet: CustomerHelmetDto }) {
  const profile = PROFILE_LABEL[helmet.emergencyProfileStatus];
  return (
    <Link
      to={`/app/helmets/${helmet.id}`}
      className="flex flex-col gap-3 rounded-xl border border-hairline p-5 transition-colors hover:border-ink"
      data-testid="helmet-card"
    >
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
        <Badge tone={profile.tone}>{profile.label}</Badge>
        {helmet.activatedAt && (
          <span>Activated {dateFmt.format(new Date(helmet.activatedAt))}</span>
        )}
      </div>
    </Link>
  );
}
