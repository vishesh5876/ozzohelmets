import { ARTWORK_QUALITY_LABEL, type PrintDesignDto, type PrintDesignStatus } from '@helmet/types';
import { Badge } from '@helmet/ui';
import { AuthImage } from '../../components/AuthImage';

const STATUS_TONE: Record<PrintDesignStatus, 'success' | 'soft' | 'muted'> = {
  ACTIVE: 'success',
  DRAFT: 'soft',
  ARCHIVED: 'muted',
};

export function DesignStatusBadge({ status }: { status: PrintDesignStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{status[0] + status.slice(1).toLowerCase()}</Badge>;
}

/** Honest print-quality label: vector, or the effective DPI with its grade. */
export function QualityLabel({
  quality,
  dpi,
}: {
  quality: PrintDesignDto['quality'];
  dpi: number | null;
}) {
  const tone = quality === 'TOO_LOW' ? 'danger' : quality === 'GOOD' ? 'soft' : 'success';
  return (
    <span className="inline-flex items-center gap-2">
      <Badge tone={tone} data-testid="artwork-quality">
        {quality === 'VECTOR' ? 'VECTOR' : `${dpi ?? '?'} DPI`}
      </Badge>
      <span className="text-xs text-body">{ARTWORK_QUALITY_LABEL[quality]}</span>
    </span>
  );
}

/** Sample-data preview rendered by the production layout engine (server-side). */
export function DesignPreview({
  designId,
  kind,
  query = {},
  version,
  className,
}: {
  designId: string;
  kind: 'unit' | 'sheet';
  query?: Record<string, string | number | boolean | undefined>;
  /** Cache-buster (design updatedAt). */
  version?: string;
  className?: string;
}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== false) qs.set(k, v === true ? '1' : String(v));
  if (version) qs.set('v', version);
  return (
    <AuthImage
      path={`/admin/print-designs/${designId}/preview/${kind}.svg?${qs.toString()}`}
      alt={kind === 'unit' ? 'Safety ID unit preview' : '12 × 18 sheet preview'}
      className={className ?? 'w-full border border-hairline bg-white'}
    />
  );
}
