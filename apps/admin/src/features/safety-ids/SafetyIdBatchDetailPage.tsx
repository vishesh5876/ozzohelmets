import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, Download, FileDown, Play } from 'lucide-react';
import { Permission, type SafetyIdBatchDto } from '@helmet/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  humanizeEnum,
} from '@helmet/ui';
import { Dialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { api, apiBlob } from '../../lib/api';
import {
  downloadBlob,
  filenameFromDisposition,
  formatDateTime,
  formatNumber,
} from '../../lib/format';
import { GenerationBadge, PrintBadge, ProgressBar } from '../batches/BatchStatus';
import { SafetyIdPrintPanel } from './SafetyIdPrintPanel';
import { usePrintLayout } from './usePrintLayout';
import { DesignPreview } from '../print-designs/shared';

export function SafetyIdBatchDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [confirmPrint, setConfirmPrint] = useState(false);
  const [print, setLayout] = usePrintLayout();
  const {
    data: b,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['safety-id-batches', id],
    queryFn: () => api.get<SafetyIdBatchDto>(`/admin/safety-id-batches/${id}`),
    refetchInterval: (q) => (q.state.data?.generationStatus === 'GENERATING' ? 1500 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['safety-id-batches'] });
  const generate = useMutation({
    mutationFn: () => api.post(`/admin/safety-id-batches/${id}/generate`),
    onSuccess: refresh,
  });
  const markPrinted = useMutation({
    mutationFn: () => api.post(`/admin/safety-id-batches/${id}/mark-printed`),
    onSuccess: async () => {
      setConfirmPrint(false);
      await refresh();
    },
  });
  const download = useMutation({
    mutationFn: async (kind: 'csv' | 'pdf') => {
      // CSV and PDF use the same layout, so CSV sheet positions match the PDF.
      const path =
        kind === 'csv'
          ? `/admin/safety-id-batches/${id}/export/safety-ids.csv`
          : `/admin/safety-id-batches/${id}/export/print.pdf`;
      const { blob, headers } = await apiBlob(path, { query: print.query });
      downloadBlob(
        blob,
        filenameFromDisposition(
          headers.get('Content-Disposition'),
          `${b?.batchCode ?? 'safety-ids'}.${kind}`,
        ),
      );
      await refresh();
    },
  });

  if (isLoading) return <LoadingState />;
  if (error || !b) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const completed = b.generationStatus === 'COMPLETED';
  const companion = b.helmetBatch !== null && b.mode === 'HELMET_LINKED';
  const canGenerate =
    !companion && (b.generationStatus === 'PENDING' || b.generationStatus === 'FAILED');

  return (
    <>
      <PageHeader
        back={{ to: '/safety-id-batches', label: 'Safety ID batches' }}
        title={b.batchCode}
        description={
          <span>
            {humanizeEnum(b.mode)}
            {b.helmetBatch && (
              <>
                {' · '}
                <Link to={`/batches/${b.helmetBatch.id}`} className="font-mono hover:underline">
                  {b.helmetBatch.batchCode}
                </Link>
              </>
            )}
          </span>
        }
        actions={
          <>
            {canGenerate && (
              <RequirePermission permission={Permission.SAFETY_IDS_GENERATE}>
                <Button onClick={() => generate.mutate()} loading={generate.isPending}>
                  <Play className="h-4 w-4" aria-hidden />{' '}
                  {b.generationStatus === 'FAILED' ? 'Resume generation' : 'Generate'}
                </Button>
              </RequirePermission>
            )}
            {completed && (
              <RequirePermission permission={Permission.SAFETY_IDS_EXPORT}>
                <Button
                  variant="subtle"
                  onClick={() => download.mutate('csv')}
                  loading={download.isPending && download.variables === 'csv'}
                >
                  <Download className="h-4 w-4" aria-hidden /> Export CSV
                </Button>
                <Button
                  variant="subtle"
                  disabled={!print.valid || b.printStatus === 'PRINTED' || b.pinsEscrowed === 0}
                  title={
                    b.printStatus === 'PRINTED'
                      ? 'PIN escrow purged: a reprint with the original PINs is impossible.'
                      : undefined
                  }
                  onClick={() => download.mutate('pdf')}
                  loading={download.isPending && download.variables === 'pdf'}
                >
                  <FileDown className="h-4 w-4" aria-hidden /> Download {print.layout.sheetHeightIn}{' '}
                  × {print.layout.sheetWidthIn} Print PDF
                </Button>
              </RequirePermission>
            )}
            {completed && b.printStatus === 'NOT_PRINTED' && (
              <RequirePermission permission={Permission.SAFETY_IDS_GENERATE}>
                <Button variant="secondary" onClick={() => setConfirmPrint(true)}>
                  Mark printed
                </Button>
              </RequirePermission>
            )}
          </>
        }
      />
      <InlineError error={generate.error ?? download.error} />
      {companion && (
        <p className="mb-4 rounded-md bg-canvas-soft p-3 text-sm">
          Generated together with helmet batch{' '}
          <Link to={`/batches/${b.helmetBatch!.id}`} className="font-mono underline">
            {b.helmetBatch!.batchCode}
          </Link>
          . Marking that batch printed also marks these Safety IDs printed.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Generation</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <GenerationBadge status={b.generationStatus} />
              <p className="text-sm tabular-nums">
                <span className="text-display-sm font-bold">{formatNumber(b.generatedCount)}</span>
                <span className="text-body"> / {formatNumber(b.quantity)} Safety IDs</span>
              </p>
            </div>
            <ProgressBar value={b.generatedCount} max={b.quantity} />
            {b.generationError && (
              <p className="flex items-center gap-2 text-sm text-danger" role="alert">
                <AlertTriangle className="h-4 w-4" aria-hidden /> {b.generationError}
              </p>
            )}
            {b.stats && (
              <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <Stat label="Printed" value={b.stats.printed} />
                <Stat label="Activated" value={b.stats.activated} />
                <Stat label="Sharing" value={b.stats.active} />
                <Stat label="Not activated" value={b.stats.remaining} />
              </dl>
            )}
            <Link
              to={`/safety-ids?batchId=${b.id}`}
              className="text-sm font-medium underline-offset-2 hover:underline"
            >
              View Safety IDs in this batch
            </Link>
          </CardContent>
        </Card>
        <Card className={b.printStatus === 'PRINTED' ? '' : 'border-ink'}>
          <CardHeader>
            <CardTitle>Labels &amp; PINs</CardTitle>
            <CardDescription>
              PINs can be exported or printed only until the batch is marked printed.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <Row label="Print status" value={<PrintBadge status={b.printStatus} />} />
            <Row label="Activation PIN" value={pinState(b)} />
            <Row label="PINs in escrow" value={formatNumber(b.pinsEscrowed)} />
            <Row
              label="Exports"
              value={
                b.exportCount === 0
                  ? 'Not exported yet'
                  : `${formatNumber(b.exportCount)} · last ${formatDateTime(b.lastExportedAt)}`
              }
            />
            {b.printedAt && <Row label="Printed" value={formatDateTime(b.printedAt)} />}
          </CardContent>
        </Card>
      </div>
      <PrintDesignCard batch={b} />
      {completed && (
        <SafetyIdPrintPanel generated={b.generatedCount} print={print} onLayoutChange={setLayout} />
      )}
      <Dialog
        open={confirmPrint}
        onClose={() => setConfirmPrint(false)}
        title="Printing completed?"
        description="Marking this Safety ID batch as printed will permanently delete the recoverable Activation PIN escrow. The printed PIN will continue to work, but it cannot be displayed or exported again."
      >
        <p className="mb-3 text-sm text-body">
          Only confirm after the physical sheets were printed, checked and scanned. Downloading the
          PDF does not mark anything printed.
        </p>
        <InlineError error={markPrinted.error} />
        <div className="flex justify-end gap-2">
          <Button variant="subtle" onClick={() => setConfirmPrint(false)}>
            Cancel
          </Button>
          <Button loading={markPrinted.isPending} onClick={() => markPrinted.mutate()}>
            Confirm printed and purge escrow
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/** The exact artwork version bound at creation (manufacturing traceability). */
function PrintDesignCard({ batch }: { batch: SafetyIdBatchDto }) {
  const [open, setOpen] = useState(false);
  const d = batch.printDesign;
  return (
    <Card className="mt-4" data-testid="batch-print-design">
      <CardHeader>
        <CardTitle>Print Design</CardTitle>
        <CardDescription>
          Fixed when the batch was created. Activating another design never changes this batch.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {d ? (
          <>
            <Row
              label="Design"
              value={
                <Link to={`/print-designs/${d.id}`} className="hover:underline">
                  {d.name}
                </Link>
              }
            />
            <Row
              label="Version"
              value={<span data-testid="batch-design-version">{d.version}</span>}
            />
            <Row
              label="Artwork"
              value={d.artworkType === 'SVG' ? 'SVG / Vector' : 'PNG / Raster'}
            />
            <div>
              <Button variant="subtle" size="sm" onClick={() => setOpen((v) => !v)}>
                Preview
              </Button>
            </div>
            {open && <DesignPreview designId={d.id} kind="unit" />}
          </>
        ) : (
          <p className="text-body">
            Built-in layout (created before Print Designs, or with no active design).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Batch-level Activation PIN state (the PIN itself is never shown). */
function pinState(b: SafetyIdBatchDto): string {
  if (b.printStatus === 'PRINTED') return 'Unused · escrow purged';
  if (b.pinsEscrowed === 0) return 'No PIN in escrow';
  return b.exportCount > 0 ? 'Exported for printing' : 'Available for printing';
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-body">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-body">{label}</dt>
      <dd className="font-medium tabular-nums">{formatNumber(value)}</dd>
    </div>
  );
}
