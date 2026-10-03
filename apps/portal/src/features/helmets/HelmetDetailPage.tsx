import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CustomerHelmetDto } from '@helmet/types';
import { Badge, buttonVariants, Card, CardContent, HelmetStatusBadge } from '@helmet/ui';
import { ErrorState, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { PROFILE_LABEL } from './profile-label';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function HelmetDetailPage() {
  const { id = '' } = useParams();
  const {
    data: helmet,
    isLoading,
    error,
  } = useQuery({
    queryKey: keys.helmet(id),
    queryFn: () => api.get<CustomerHelmetDto>(`/customer/helmets/${id}`),
  });
  const qr = useQuery({
    queryKey: ['helmets', id, 'qr'],
    queryFn: () => api.blob(`/customer/helmets/${id}/qr`).then((r) => r.blob),
    enabled: !!helmet,
  });
  const qrUrl = useMemo(() => (qr.data ? URL.createObjectURL(qr.data) : null), [qr.data]);
  useEffect(() => () => (qrUrl ? URL.revokeObjectURL(qrUrl) : undefined), [qrUrl]);

  if (isLoading) return <LoadingState />;
  if (error || !helmet)
    return <ErrorState error={error} action={<Link to="/app/helmets">Back to my helmets</Link>} />;
  const profile = PROFILE_LABEL[helmet.emergencyProfileStatus];

  return (
    <>
      <Link to="/app/helmets" className="text-sm font-medium text-body hover:text-ink">
        ← My helmets
      </Link>
      <div className="mt-2 mb-6 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-display-md font-bold">{helmet.helmetCode}</h1>
        <HelmetStatusBadge status={helmet.status} />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardContent>
            <dl className="grid gap-5 sm:grid-cols-2">
              <Item label="Model" value={`${helmet.model.brand} ${helmet.model.name}`} />
              <Item
                label="Serial number"
                value={<span className="font-mono text-sm">{helmet.serialNumber}</span>}
              />
              <Item
                label="Activated"
                value={helmet.activatedAt ? dateFmt.format(new Date(helmet.activatedAt)) : '—'}
              />
              <Item
                label="Emergency profile"
                value={<Badge tone={profile.tone}>{profile.label}</Badge>}
              />
            </dl>
            <div className="mt-6 flex flex-wrap gap-2">
              {helmet.emergencyProfileStatus !== 'ACTIVE' && (
                <Link to="/app/onboarding" className={buttonVariants()}>
                  {helmet.emergencyProfileStatus === 'DISABLED'
                    ? 'Turn on for this helmet'
                    : 'Set up emergency profile'}
                </Link>
              )}
              <a
                href={helmet.publicUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: 'subtle' })}
              >
                Open public page
              </a>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col items-center gap-3">
            <p className="self-start font-bold">Helmet QR code</p>
            {qrUrl ? (
              <img src={qrUrl} alt={`QR code for ${helmet.helmetCode}`} className="h-44 w-44" />
            ) : (
              <LoadingState label="" />
            )}
            <p className="text-center text-xs text-body">
              This is the code printed on your helmet.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-body">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}
