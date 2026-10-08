import { NavLink } from 'react-router-dom';
import {
  type AnalyticsRangeKey,
  Permission,
  type QrIntegrityStatus,
  RISK_DISCLAIMER,
  type RiskLevel,
} from '@helmet/types';
import { Badge, type BadgeProps, cn, humanizeEnum, Input, Select } from '@helmet/ui';
import { useAuth } from '../../lib/auth-context';

export interface RangeState {
  range: AnalyticsRangeKey;
  from?: string;
  to?: string;
}

const LEVEL_TONE: Record<RiskLevel, NonNullable<BadgeProps['tone']>> = {
  NONE: 'muted',
  LOW: 'soft',
  MEDIUM: 'outline',
  HIGH: 'solid',
  CRITICAL: 'danger',
};

/** Risk levels describe review priority for scan patterns, never a verdict on the product. */
export function RiskLevelBadge({ level, score }: { level: RiskLevel; score?: number }) {
  return (
    <Badge tone={LEVEL_TONE[level]} data-testid="risk-level">
      {level === 'NONE' ? 'No signals' : `${humanizeEnum(level)} review priority`}
      {score !== undefined && level !== 'NONE' && <span className="tabular-nums">· {score}</span>}
    </Badge>
  );
}

export function QrIntegrityBadge({ status }: { status: QrIntegrityStatus }) {
  if (status === 'NORMAL') return <Badge tone="muted">QR normal</Badge>;
  return (
    <Badge tone={status === 'COMPROMISED' ? 'danger' : 'outline'} data-testid="qr-integrity">
      {status === 'COMPROMISED' ? 'QR marked compromised' : 'QR under review'}
    </Badge>
  );
}

export function Disclaimer() {
  return (
    <p
      className="mb-4 rounded-lg bg-canvas-softer px-4 py-3 text-sm text-body"
      data-testid="risk-disclaimer"
    >
      {RISK_DISCLAIMER} Signals are deterministic rules over scan counts; each one lists its
      observed value and threshold.
    </p>
  );
}

export function AnalyticsTabs() {
  const { can } = useAuth();
  const tabs = [
    { to: '/analytics', label: 'Overview', end: true, show: can(Permission.ANALYTICS_VIEW) },
    { to: '/analytics/scans', label: 'QR scans', show: can(Permission.ANALYTICS_VIEW) },
    { to: '/analytics/helmets', label: 'Helmet activity', show: can(Permission.ANALYTICS_VIEW) },
    { to: '/analytics/alerts', label: 'Risk alerts', show: can(Permission.RISK_ALERT_VIEW) },
  ].filter((t) => t.show);
  return (
    <nav aria-label="Analytics" className="mb-6 flex flex-wrap gap-1 border-b border-hairline">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              isActive ? 'border-ink text-ink' : 'border-transparent text-body hover:text-ink',
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Date range filter: presets plus a custom from/to (UTC days). One row above the content. */
export function RangePicker({
  value,
  onChange,
}: {
  value: RangeState;
  onChange: (v: RangeState) => void;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-2">
      <Select
        aria-label="Date range"
        className="max-w-[10rem]"
        value={value.range}
        onChange={(e) => onChange({ range: e.target.value as AnalyticsRangeKey })}
      >
        <option value="today">Today</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="custom">Custom</option>
      </Select>
      {value.range === 'custom' && (
        <>
          <Input
            type="date"
            aria-label="From"
            className="max-w-[11rem]"
            value={value.from ?? ''}
            onChange={(e) => onChange({ ...value, from: e.target.value || undefined })}
          />
          <Input
            type="date"
            aria-label="To"
            className="max-w-[11rem]"
            value={value.to ?? ''}
            onChange={(e) => onChange({ ...value, to: e.target.value || undefined })}
          />
        </>
      )}
    </div>
  );
}
