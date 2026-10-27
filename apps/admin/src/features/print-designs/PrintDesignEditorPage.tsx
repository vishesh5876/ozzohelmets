import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Download, Upload } from 'lucide-react';
import {
  ARTWORK_OFFSET_RANGE_MM,
  ARTWORK_SCALE_RANGE,
  CUTTER_PRINT_PRESET,
  DEFAULT_PRINT_PRESET,
  Permission,
  presetOf,
  PRINT_PRESETS,
  type PrintArtworkFileDto,
  type PrintArtworkRole,
  type PrintDesignDto,
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
import { Dialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { api, apiBlob } from '../../lib/api';
import { useAuth } from '../../lib/auth-context';
import { downloadBlob, filenameFromDisposition, formatDateTime } from '../../lib/format';
import { rememberedLayout, rememberPreset } from '../safety-ids/usePrintLayout';
import { DesignPreview, DesignStatusBadge, QualityLabel } from './shared';
import { GUIDE_LEGEND, resolutionText } from './design-format';

interface FormState {
  name: string;
  base: PrintArtworkFileDto | null;
  cover: PrintArtworkFileDto | null;
  scalePercent: number;
  offsetXMm: number;
  offsetYMm: number;
  artworkOnTop: boolean;
}

const EMPTY: FormState = {
  name: '',
  base: null,
  cover: null,
  scalePercent: 100,
  offsetXMm: 0,
  offsetYMm: 0,
  artworkOnTop: true,
};

/**
 * Create / edit a print design. The admin controls ARTWORK only (file, uniform scale, offset);
 * the Safety ID, PIN, QR, quiet zone, cover and cut geometry are fixed by the system. A design
 * that is active, archived or used by a batch is locked: saving creates a new version.
 */
export function PrintDesignEditorPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { admin, can } = useAuth();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [guides, setGuides] = useState(true);
  const [preview, setPreview] = useState<'unit' | 'sheet' | null>(null);
  const [testOnly, setTestOnly] = useState(false);
  // Sheet used by "Preview Sheet" and the test print: the same choice as the batch print panel.
  const [sheet, setSheet] = useState(() => presetOf(rememberedLayout()) ?? DEFAULT_PRINT_PRESET);
  const sheetLayout = PRINT_PRESETS[sheet]!;

  const q = useQuery({
    queryKey: ['print-designs', id],
    queryFn: () => api.get<PrintDesignDto>(`/admin/print-designs/${id}`),
    enabled: !isNew,
  });
  const d = q.data;
  useEffect(() => {
    if (d)
      setForm({
        name: d.name,
        base: d.baseArtwork,
        cover: d.coverArtwork,
        scalePercent: d.scalePercent,
        offsetXMm: d.offsetXMm,
        offsetYMm: d.offsetYMm,
        artworkOnTop: d.artworkOnTop,
      });
  }, [d]);

  const dirty =
    !d ||
    form.name !== d.name ||
    form.base?.id !== d.baseArtwork.id ||
    (form.cover?.id ?? null) !== (d.coverArtwork?.id ?? null) ||
    form.scalePercent !== d.scalePercent ||
    form.offsetXMm !== d.offsetXMm ||
    form.offsetYMm !== d.offsetYMm ||
    form.artworkOnTop !== d.artworkOnTop;
  const canManage = can(Permission.PRINT_DESIGN_MANAGE);

  const upload = useMutation({
    mutationFn: async ({ file, role }: { file: File; role: PrintArtworkRole }) => {
      const fd = new FormData();
      fd.set('role', role);
      if (testOnly) fd.set('testOnly', 'true');
      fd.set('file', file);
      return {
        role,
        file: await api.upload<PrintArtworkFileDto>('/admin/print-designs/artwork', fd),
      };
    },
    onSuccess: ({ role, file }) => setForm((f) => ({ ...f, [role]: file })),
  });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        baseArtworkFileId: form.base!.id,
        coverArtworkFileId: form.cover?.id ?? null,
        scalePercent: form.scalePercent,
        offsetXMm: form.offsetXMm,
        offsetYMm: form.offsetYMm,
        artworkOnTop: form.artworkOnTop,
      };
      if (isNew) return api.post<PrintDesignDto>('/admin/print-designs', body);
      if (d!.locked)
        return api.post<PrintDesignDto>(`/admin/print-designs/${id}/new-version`, body);
      return api.patch<PrintDesignDto>(`/admin/print-designs/${id}`, body);
    },
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: ['print-designs'] });
      navigate(`/print-designs/${saved.id}`, { replace: isNew });
    },
  });
  const act = useMutation({
    mutationFn: (kind: 'activate' | 'archive' | 'duplicate') =>
      api.post<PrintDesignDto>(`/admin/print-designs/${id}/${kind}`),
    onSuccess: async (res, kind) => {
      await qc.invalidateQueries({ queryKey: ['print-designs'] });
      if (kind === 'duplicate') navigate(`/print-designs/${res.id}`);
    },
  });
  const testPrint = useMutation({
    mutationFn: async () => {
      const { blob, headers } = await apiBlob(
        `/admin/print-designs/${id}/test-print.pdf?preset=${encodeURIComponent(sheet)}`,
      );
      downloadBlob(
        blob,
        filenameFromDisposition(headers.get('Content-Disposition'), 'TEST-PRINT.pdf'),
      );
    },
  });

  if (!isNew && q.isLoading) return <LoadingState />;
  if (!isNew && (q.error || !d))
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  const position = {
    scalePercent: form.scalePercent,
    offsetXMm: form.offsetXMm,
    offsetYMm: form.offsetYMm,
    artworkOnTop: form.artworkOnTop ? '1' : '0',
  };
  const widthMm = Math.round(114.3 * form.scalePercent) / 100;
  const heightMm = Math.round(25.4 * form.scalePercent) / 100;
  const pickFile = (role: PrintArtworkRole) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) upload.mutate({ file, role });
  };

  return (
    <>
      <PageHeader
        back={{ to: '/print-designs', label: 'Print Designs' }}
        title={isNew ? 'Create Design' : `${d!.name} · v${d!.version}`}
        description={
          d ? (
            <span className="inline-flex items-center gap-2">
              <DesignStatusBadge status={d.status} /> {d.artworkType} · created{' '}
              {formatDateTime(d.createdAt)} by {d.createdBy?.name ?? '—'} · used by{' '}
              {d.usedByBatches} batch
              {d.usedByBatches === 1 ? '' : 'es'}
            </span>
          ) : (
            'Upload artwork (SVG preferred, or PNG at 300–600 DPI) for the 4.5 × 1 in sticker.'
          )
        }
        actions={
          d && (
            <>
              <RequirePermission permission={Permission.PRINT_DESIGN_MANAGE}>
                <Button variant="subtle" onClick={() => act.mutate('duplicate')}>
                  Duplicate
                </Button>
                {d.status !== 'ARCHIVED' && (
                  <Button variant="subtle" onClick={() => act.mutate('archive')}>
                    Archive
                  </Button>
                )}
              </RequirePermission>
              {d.status !== 'ACTIVE' && (
                <RequirePermission permission={Permission.PRINT_DESIGN_ACTIVATE}>
                  <Button
                    onClick={() => act.mutate('activate')}
                    loading={act.isPending && act.variables === 'activate'}
                    disabled={dirty || d.validationErrors.length > 0}
                    title={dirty ? 'Save the draft first' : undefined}
                  >
                    Activate Design
                  </Button>
                </RequirePermission>
              )}
            </>
          )
        }
      />
      <InlineError error={act.error ?? testPrint.error} />
      {d?.locked && (
        <p className="mb-4 rounded-md bg-canvas-soft p-3 text-sm" data-testid="design-locked">
          This version is locked (
          {d.status === 'DRAFT' ? 'used by a batch' : d.status.toLowerCase()}). Batches keep the
          exact version they were created with. Saving changes creates a new version.
        </p>
      )}
      {d && d.validationErrors.length > 0 && (
        <div
          className="mb-4 rounded-md border border-danger p-3 text-sm text-danger"
          role="alert"
          data-testid="design-errors"
        >
          <p className="font-medium">Not ready for production (stays a draft):</p>
          <ul className="ml-5 list-disc">
            {d.validationErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Artwork</CardTitle>
            <CardDescription>
              Background only. Uploaded files are inspected and sanitized on the server; SVG stays
              vector in the PDF.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <Field label="Design Name" htmlFor="pd-name">
              <Input
                id="pd-name"
                maxLength={120}
                value={form.name}
                disabled={!canManage}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="OZZO Emergency Black V3"
              />
            </Field>
            <ArtworkSlot
              label="Base Artwork"
              hint="Recommended: just the emergency panel at 2.2 : 1 (viewBox 0 0 220 100, or 1320 × 600 px). It fills exactly the area left of the Safety ID and QR, so nothing can overlap them. A full 4.5 : 1 sticker also works, but only its left 2.2 in shows."
              file={form.base}
              inputId="pd-base"
              disabled={!canManage || upload.isPending}
              onPick={pickFile('base')}
            />
            <p className="-mt-2 text-xs text-body" data-testid="pd-templates">
              Templates for your designer:{' '}
              <a
                className="font-medium text-ink underline underline-offset-2"
                href="/print-templates/ozzo-emergency-panel-template.svg"
                download
              >
                Emergency panel 2.2 × 1 in (recommended)
              </a>{' '}
              ·{' '}
              <a
                className="font-medium text-ink underline underline-offset-2"
                href="/print-templates/ozzo-full-sticker-template.svg"
                download
              >
                Full sticker 4.5 × 1 in
              </a>
            </p>
            <ArtworkSlot
              label="Cover Artwork (optional)"
              hint="Fills only the removable cover. Without it the default yellow REMOVE / ONLY IN EMERGENCY / OPEN cover is used."
              file={form.cover}
              inputId="pd-cover"
              disabled={!canManage || upload.isPending}
              onPick={pickFile('cover')}
              onRemove={canManage ? () => setForm({ ...form, cover: null }) : undefined}
            />
            {admin?.role === 'SUPER_ADMIN' && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={testOnly}
                  onChange={(e) => setTestOnly(e.target.checked)}
                />
                Allow a low-resolution PNG for testing only (never usable for production)
              </label>
            )}
            <InlineError error={upload.error} />

            <fieldset className="flex flex-col gap-3" disabled={!canManage}>
              <legend className="mb-1 font-medium">Artwork Position</legend>
              <p className="text-xs text-body">
                Uniform scale only — the aspect ratio is locked. The ID, PIN, QR and cover positions
                are system-controlled and cannot be moved here.
              </p>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Scale (%)" htmlFor="pd-scale">
                  <Input
                    id="pd-scale"
                    type="number"
                    min={ARTWORK_SCALE_RANGE.min}
                    max={ARTWORK_SCALE_RANGE.max}
                    step={1}
                    value={form.scalePercent}
                    onChange={(e) =>
                      setForm({ ...form, scalePercent: e.target.valueAsNumber || 100 })
                    }
                  />
                </Field>
                <Field label="X (mm)" htmlFor="pd-x">
                  <Input
                    id="pd-x"
                    type="number"
                    min={-ARTWORK_OFFSET_RANGE_MM}
                    max={ARTWORK_OFFSET_RANGE_MM}
                    step={0.1}
                    value={form.offsetXMm}
                    onChange={(e) => setForm({ ...form, offsetXMm: e.target.valueAsNumber || 0 })}
                  />
                </Field>
                <Field label="Y (mm)" htmlFor="pd-y">
                  <Input
                    id="pd-y"
                    type="number"
                    min={-ARTWORK_OFFSET_RANGE_MM}
                    max={ARTWORK_OFFSET_RANGE_MM}
                    step={0.1}
                    value={form.offsetYMm}
                    onChange={(e) => setForm({ ...form, offsetYMm: e.target.valueAsNumber || 0 })}
                  />
                </Field>
              </div>
              <p className="text-xs text-body">
                Scaled artwork box: {widthMm} × {heightMm} mm (unit 114.3 × 25.4 mm).
              </p>
              <label className="flex items-start gap-2 rounded-md bg-canvas-soft p-3">
                <input
                  type="checkbox"
                  className="mt-1 accent-primary"
                  checked={form.artworkOnTop}
                  onChange={(e) => setForm({ ...form, artworkOnTop: e.target.checked })}
                  data-testid="pd-on-top"
                />
                <span>
                  <span className="block font-medium">Design on top (recommended)</span>
                  <span className="block text-xs text-body">
                    Your artwork is printed over the Safety ID column, so nothing of it is cut off.
                    Only the QR code, the PIN and the Safety ID text keep small white boxes on top,
                    so they always scan and read. Off: the white Safety ID column covers everything
                    right of 2.2 in.
                  </span>
                </span>
              </label>
            </fieldset>
            <InlineError error={save.error} />
            {canManage && (
              <Button
                onClick={() => save.mutate()}
                loading={save.isPending}
                disabled={!form.base || !form.name.trim() || (!isNew && !dirty)}
              >
                {isNew ? 'Save Draft' : d!.locked ? 'Save as New Version' : 'Save Draft'}
              </Button>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>
              Sample data (ID SI-7958-72SA, PIN 146628, sample QR) rendered by the production layout
              engine — same geometry as the print PDF.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {isNew ? (
              <p className="text-body">Save the draft to see the exact preview.</p>
            ) : (
              <>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={guides}
                    onChange={(e) => setGuides(e.target.checked)}
                  />
                  Show Guides
                </label>
                {!dirty ||
                (form.base?.id === d!.baseArtwork.id &&
                  (form.cover?.id ?? null) === (d!.coverArtwork?.id ?? null)) ? (
                  <DesignPreview
                    designId={d!.id}
                    kind="unit"
                    version={d!.updatedAt}
                    query={{ ...position, guides }}
                  />
                ) : (
                  <p className="text-body">Save the draft to preview the new artwork file.</p>
                )}
                {guides && (
                  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {GUIDE_LEGEND.map(([color, label]) => (
                      <li key={label} className="inline-flex items-center gap-1">
                        <span
                          className="inline-block h-2 w-4"
                          style={{ border: `1.5px solid ${color}` }}
                        />
                        {label}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="subtle" onClick={() => setPreview('unit')}>
                    Preview Unit
                  </Button>
                </div>
                <div className="flex flex-col gap-3 rounded-md border border-hairline p-3">
                  <Field label="Sheet layout" htmlFor="pd-sheet">
                    <select
                      id="pd-sheet"
                      className="h-11 rounded-sm border border-ink bg-canvas px-3"
                      value={sheet}
                      onChange={(e) => {
                        setSheet(e.target.value);
                        rememberPreset(PRINT_PRESETS[e.target.value]!);
                      }}
                    >
                      <option value={CUTTER_PRINT_PRESET}>
                        Own printer + cutter · 30-up (margins, bleed, marks)
                      </option>
                      <option value={DEFAULT_PRINT_PRESET}>
                        Print shop · 48-up (edge to edge)
                      </option>
                    </select>
                  </Field>
                  <p className="text-xs text-body">
                    Print the test sheet at 100% (&ldquo;Actual size&rdquo;), then check the scale
                    bar measures 100 mm and run it through your cutter before printing a batch.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="subtle" onClick={() => setPreview('sheet')}>
                      Preview Sheet
                    </Button>
                    <Button
                      variant="subtle"
                      onClick={() => testPrint.mutate()}
                      loading={testPrint.isPending}
                    >
                      <Download className="h-4 w-4" aria-hidden /> Download Test Print
                    </Button>
                  </div>
                </div>
                {d!.validationWarnings.length > 0 && (
                  <ul className="flex flex-col gap-1 text-xs">
                    {d!.validationWarnings.map((w) => (
                      <li key={w} className="flex items-start gap-1">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {w}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
      {d && (
        <Dialog
          open={preview !== null}
          onClose={() => setPreview(null)}
          title={
            preview === 'unit'
              ? 'Preview Safety ID'
              : `Preview ${sheetLayout.sheetHeightIn} × ${sheetLayout.sheetWidthIn} Sheet`
          }
          description={
            preview === 'unit'
              ? 'Exact 4.5 : 1 unit with sample data.'
              : `${sheetLayout.columns} columns × ${sheetLayout.rows} rows = ${
                  sheetLayout.columns * sheetLayout.rows
                } complete units (sticker + cover), sample data.`
          }
        >
          {preview && (
            <DesignPreview
              designId={d.id}
              kind={preview}
              version={d.updatedAt}
              query={preview === 'unit' ? { ...position, guides } : { ...position, preset: sheet }}
            />
          )}
        </Dialog>
      )}
    </>
  );
}

function ArtworkSlot({
  label,
  hint,
  file,
  inputId,
  disabled,
  onPick,
  onRemove,
}: {
  label: string;
  hint: string;
  file: PrintArtworkFileDto | null;
  inputId: string;
  disabled: boolean;
  onPick: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemove?: () => void;
}) {
  return (
    <Field label={label} htmlFor={inputId} hint={hint}>
      <div className="flex flex-col gap-2">
        {file && (
          <div className="rounded-md bg-canvas-soft p-2 text-xs" data-testid={`${inputId}-file`}>
            <p className="font-medium">{file.originalFilename}</p>
            <p className="text-body">
              {resolutionText(file)} · {(file.sizeBytes / 1024).toFixed(0)} KB · SHA-256{' '}
              <span className="font-mono">{file.sha256.slice(0, 12)}…</span>
            </p>
            <QualityLabel quality={file.quality} dpi={file.effectiveDpi} />
            {file.testOnly && (
              <p className="text-danger">Test-only: cannot be used for production.</p>
            )}
            {file.warnings.map((w) => (
              <p key={w} className="text-body">
                ⚠ {w}
              </p>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <label
            htmlFor={inputId}
            className={`inline-flex cursor-pointer items-center gap-1 rounded-md border border-hairline px-3 py-1.5 ${disabled ? 'pointer-events-none opacity-50' : ''}`}
          >
            <Upload className="h-4 w-4" aria-hidden /> {file ? 'Replace' : 'Upload SVG/PNG'}
          </label>
          <input
            id={inputId}
            type="file"
            accept=".svg,.png,image/svg+xml,image/png"
            className="sr-only"
            disabled={disabled}
            onChange={onPick}
          />
          {file && onRemove && (
            <Button size="sm" variant="subtle" onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
      </div>
    </Field>
  );
}
