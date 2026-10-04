import type { HelmetDetailDto, HelmetHealthFlag } from '@helmet/types';
import { Badge, Card, CardContent, CardHeader, CardTitle, humanizeEnum } from '@helmet/ui';
import { formatDateTime, formatNumber } from '../../lib/format';

const ATTENTION: HelmetHealthFlag[] = [
  'REPORTED_LOST',
  'REPORTED_STOLEN',
  'DAMAGED',
  'RECALLED',
  'HIGH_SCAN_ACTIVITY',
];

/** Operational summary: health flags and aggregate scan counts (no IPs, no locations). */
export function HelmetSupportCard({ helmet }: { helmet: HelmetDetailDto }) {
  const s = helmet.support;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Support summary</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2" data-testid="helmet-flags">
          {s.flags.map((f) => (
            <Badge key={f} tone={ATTENTION.includes(f) ? 'danger' : 'soft'}>
              {humanizeEnum(f)}
            </Badge>
          ))}
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-body">Emergency sharing</dt>
            <dd className="font-medium">{s.emergencySharing ? 'On' : 'Off'}</dd>
          </div>
          <div>
            <dt className="text-body">Warranty</dt>
            <dd className="font-medium">{humanizeEnum(s.warrantyStatus)}</dd>
          </div>
          <div>
            <dt className="text-body">Last scanned</dt>
            <dd className="font-medium">
              {s.scans.lastScannedAt ? formatDateTime(s.scans.lastScannedAt) : 'Never'}
            </dd>
          </div>
          <div>
            <dt className="text-body">Scans 24 h / 7 days</dt>
            <dd className="font-medium tabular-nums">
              {formatNumber(s.scans.last24h)} / {formatNumber(s.scans.last7d)}
            </dd>
          </div>
          <div>
            <dt className="text-body">Emergency scans (7 d)</dt>
            <dd className="font-medium tabular-nums">{formatNumber(s.scans.emergency7d)}</dd>
          </div>
          <div>
            <dt className="text-body">Verification scans (7 d)</dt>
            <dd className="font-medium tabular-nums">{formatNumber(s.scans.verify7d)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
