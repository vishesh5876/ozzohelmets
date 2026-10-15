import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AlertTriangle, Eye, Scissors } from 'lucide-react';
import type { PrintLayoutState } from './usePrintLayout';
import {
  DEFAULT_PRINT_LAYOUT,
  needsFullSheetWarning,
  FULL_SHEET_WARNING,
  planSheets,
  PRINT_LAYOUT_FIELDS,
  type PrintSheetLayout,
  type SafetyIdPrintStatusDto,
  unitsPerSheet,
  validatePrintLayout,
} from '@helmet/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from '@helmet/ui';
import { AuthImage } from '../../components/AuthImage';
import { Dialog } from '../../components/Dialog';
import { api, apiBlob } from '../../lib/api';
import { downloadBlob, filenameFromDisposition, formatNumber } from '../../lib/format';

const LABELS: Record<keyof PrintSheetLayout, string> = {
  sheetWidthIn: 'Sheet width (in)',
  sheetHeightIn: 'Sheet height (in)',
  unitWidthIn: 'Unit width (in)',
  unitHeightIn: 'Unit height (in)',
  columns: 'Columns',
  rows: 'Rows',
  outerMarginXIn: 'Outer margin X (in)',
  outerMarginYIn: 'Outer margin Y (in)',
  gutterXIn: 'Horizontal gutter (in)',
  gutterYIn: 'Vertical gutter (in)',
  bleedMm: 'Bleed (mm)',
  safeAreaMm: 'Safe area (mm)',
};

const queryString = (q: Record<string, string>) => {
  const s = new URLSearchParams(q).toString();
  return s ? `?${s}` : '';
};

/**
 * Physical print planning for one Safety ID batch: true-size unit and sheet previews (sample
 * data, no PINs), sheet counts, the vendor layout and the cut guide. The unit is fixed at
 * 4.5 × 1 in including its yellow cover; a layout that doesn't fit is an error, never scaled.
 */
export function SafetyIdPrintPanel({
  generated,
  print,
  onLayoutChange,
}: {
  generated: number;
  print: PrintLayoutState;
  onLayoutChange: (l: PrintSheetLayout) => void;
}) {
  const [preview, setPreview] = useState<'unit' | 'sheet' | null>(null);
  const issues = validatePrintLayout(print.layout);
  const qs = queryString(print.query);
  const { data: status } = useQuery({
    queryKey: ['safety-id-print-status', qs],
    queryFn: () => api.get<SafetyIdPrintStatusDto>(`/admin/safety-id-print/status${qs}`),
    enabled: print.valid,
  });
  const per = unitsPerSheet(print.layout);
  const plan = print.valid && generated > 0 ? planSheets(generated, per) : null;
  const { layout } = print;
  const g = status?.geometry;

  const downloadCutGuide = async () => {
    const { blob, headers } = await apiBlob(`/admin/safety-id-print/cut-guide.pdf${qs}`);
    downloadBlob(
      blob,
      filenameFromDisposition(headers.get('Content-Disposition'), 'safety-id-cut-guide.pdf'),
    );
  };

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Print sheets</CardTitle>
        <CardDescription>
          One Safety ID = one 4.5 × 1 in sticker unit with its removable yellow cover included. The
          PDF is true size: print at 100%, never &ldquo;fit to page&rdquo;.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact label="Actual size" value={`${layout.unitWidthIn} × ${layout.unitHeightIn} in`} />
          <Fact label="Sheet" value={`${layout.sheetHeightIn} × ${layout.sheetWidthIn} in`} />
          <Fact label="Units per sheet" value={print.valid ? formatNumber(per) : '—'} />
          <Fact label="Generated" value={formatNumber(generated)} />
          <Fact label="Units" value={formatNumber(generated)} />
          <Fact label={`${per}-up sheets`} value={plan ? formatNumber(plan.sheets) : '—'} />
          <Fact label="Full sheets" value={plan ? formatNumber(plan.fullSheets) : '—'} />
          <Fact
            label="Last sheet"
            value={plan ? `${formatNumber(plan.lastSheetUnits)} units` : '—'}
          />
        </dl>

        {print.valid && needsFullSheetWarning(layout) && (
          <p className="flex items-start gap-2 rounded-md bg-canvas-soft p-3" role="note">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {FULL_SHEET_WARNING}
          </p>
        )}
        {status && !status.logo.loaded && (
          <p
            className="flex items-start gap-2 rounded-md border border-danger p-3 text-danger"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> OZZO logo asset not
            loaded ({status.logo.error}) Production print PDFs are refused until the original vector
            logo is configured.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="subtle" disabled={!print.valid} onClick={() => setPreview('unit')}>
            <Eye className="h-4 w-4" aria-hidden /> Preview unit
          </Button>
          <Button variant="subtle" disabled={!print.valid} onClick={() => setPreview('sheet')}>
            <Eye className="h-4 w-4" aria-hidden /> Preview sheet
          </Button>
          <Button variant="subtle" disabled={!print.valid} onClick={() => void downloadCutGuide()}>
            <Scissors className="h-4 w-4" aria-hidden /> Download cut guide
          </Button>
        </div>

        {g && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <Fact
              label="Zones"
              value={`${g.zones.emergencyMm} + ${g.zones.credentialMm} + ${g.zones.coverMm} mm`}
            />
            <Fact
              label="Protected target"
              value={`${g.target.widthMm} × ${g.target.heightMm} mm`}
            />
            <Fact
              label="Cover"
              value={`${g.cover.widthMm} × ${g.cover.heightMm} mm (+${g.cover.overlapMm} mm overlap)`}
            />
            <Fact label="QR" value={`${g.qr.sizeMm} mm incl. quiet zone`} />
            <Fact
              label="Quiet zone"
              value={`${g.qr.quietZoneModules} modules = ${g.qr.quietZoneMm} mm`}
            />
            <Fact label="QR module" value={`${g.qr.moduleMm} mm · EC ${g.qr.errorCorrection}`} />
          </dl>
        )}

        <details className="rounded-md border border-hairline p-3">
          <summary className="cursor-pointer font-medium">Print vendor layout</summary>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {PRINT_LAYOUT_FIELDS.map((f) => (
              <Field
                key={f}
                label={LABELS[f]}
                htmlFor={`layout-${f}`}
                error={issues.find((i) => i.field === f)?.message}
              >
                <Input
                  id={`layout-${f}`}
                  type="number"
                  step="any"
                  value={Number.isFinite(layout[f]) ? layout[f] : ''}
                  onChange={(e) => onLayoutChange({ ...layout, [f]: e.target.valueAsNumber })}
                />
              </Field>
            ))}
          </div>
          {issues
            .filter((i) => i.field === 'layout')
            .map((i) => (
              <p key={i.message} className="mt-2 text-danger" role="alert">
                {i.message}
              </p>
            ))}
          <Button
            variant="subtle"
            size="sm"
            className="mt-3"
            onClick={() => onLayoutChange({ ...DEFAULT_PRINT_LAYOUT })}
          >
            Reset to 12 × 18 in 48-up
          </Button>
        </details>
      </CardContent>

      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview === 'unit' ? 'Unit preview (sample data)' : 'Sheet preview (sample data)'}
        description={
          preview === 'unit'
            ? `Exact 4.5 : 1 proportions. The yellow cover on the right is peeled and stuck over the PIN + QR.`
            : `${layout.sheetHeightIn} × ${layout.sheetWidthIn} in sheet, ${layout.columns} columns × ${layout.rows} rows. Blue: trim; magenta: kiss cuts.`
        }
      >
        {preview && (
          <AuthImage
            path={
              preview === 'unit'
                ? `/admin/safety-id-print/preview/unit.svg${qs}`
                : `/admin/safety-id-print/preview/sheet.svg${queryString({
                    ...print.query,
                    // A single partial sheet previews its real fill; otherwise a full sheet.
                    filled: String(plan?.sheets === 1 ? plan.lastSheetUnits : per),
                  })}`
            }
            alt={preview === 'unit' ? 'Safety ID sticker unit preview' : 'Print sheet preview'}
            className="w-full border border-hairline"
          />
        )}
      </Dialog>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-body">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
