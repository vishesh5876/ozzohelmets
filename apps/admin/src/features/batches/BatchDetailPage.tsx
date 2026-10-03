import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, Download, Printer, Play } from 'lucide-react';
import { type BatchDto, Permission } from '@helmet/types';
import {
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@helmet/ui';
import { Dialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { api, apiBlob } from '../../lib/api';
import {
  downloadBlob,
  filenameFromDisposition,
  formatDate,
  formatDateTime,
  formatNumber,
} from '../../lib/format';
import { HelmetTable } from '../helmets/HelmetTable';
import { GenerationBadge, PrintBadge, ProgressBar } from './BatchStatus';

export function BatchDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [confirmPrint, setConfirmPrint] = useState(false);

  const {
    data: batch,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['batches', id],
    queryFn: () => api.get<BatchDto>(`/admin/batches/${id}`),
    refetchInterval: (q) => (q.state.data?.generationStatus === 'GENERATING' ? 1500 : false),
  });

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['batches'] });
    await qc.invalidateQueries({ queryKey: ['helmets'] });
  };

  const generate = useMutation({
    mutationFn: () => api.post<BatchDto>(`/admin/batches/${id}/generate`),
    onSuccess: refresh,
  });
  const markPrinted = useMutation({
    mutationFn: () => api.post<BatchDto>(`/admin/batches/${id}/mark-printed`),
    onSuccess: async () => {
      setConfirmPrint(false);
      await refresh();
    },
  });
  const exportCsv = useMutation({
    mutationFn: async () => {
      const { blob, headers } = await apiBlob(`/admin/batches/${id}/export/manufacturing.csv`);
      downloadBlob(
        blob,
        filenameFromDisposition(
          headers.get('Content-Disposition'),
          `${batch?.batchCode ?? 'batch'}-manufacturing.csv`,
        ),
      );
    },
  });

  if (isLoading) return <LoadingState />;
  if (error || !batch) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const canGenerate = batch.generationStatus === 'PENDING' || batch.generationStatus === 'FAILED';
  const completed = batch.generationStatus === 'COMPLETED';

  return (
    <>
      <PageHeader
        back={{ to: '/batches', label: 'Batches' }}
        title={batch.batchCode}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {batch.helmetModel.name}{' '}
            <span className="font-mono text-xs">({batch.helmetModel.sku})</span> · manufactured{' '}
            {formatDate(batch.manufacturingDate)}
          </span>
        }
        actions={
          <>
            {canGenerate && (
              <RequirePermission permission={Permission.BATCHES_GENERATE}>
                <Button onClick={() => generate.mutate()} loading={generate.isPending}>
                  <Play className="h-4 w-4" aria-hidden />{' '}
                  {batch.generationStatus === 'FAILED' ? 'Resume generation' : 'Generate helmets'}
                </Button>
              </RequirePermission>
            )}
            {completed && (
              <RequirePermission permission={Permission.EXPORT_MANUFACTURING}>
                <Button
                  variant={batch.printStatus === 'PRINTED' ? 'subtle' : 'primary'}
                  onClick={() => exportCsv.mutate()}
                  loading={exportCsv.isPending}
                >
                  <Download className="h-4 w-4" aria-hidden /> Export CSV
                </Button>
              </RequirePermission>
            )}
            {completed && batch.printStatus === 'NOT_PRINTED' && (
              <RequirePermission permission={Permission.BATCHES_WRITE}>
                <Button variant="secondary" onClick={() => setConfirmPrint(true)}>
                  <Printer className="h-4 w-4" aria-hidden /> Mark printed
                </Button>
              </RequirePermission>
            )}
          </>
        }
      />
      <div className="flex flex-col gap-3">
        <InlineError error={generate.error ?? exportCsv.error} />
      </div>

      <div className="mt-2 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Generation</CardTitle>
            <CardDescription>
              Identities are created in secure, transactional chunks.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <GenerationBadge status={batch.generationStatus} />
              <p className="text-sm tabular-nums">
                <span className="text-display-sm font-bold">
                  {formatNumber(batch.generatedCount)}
                </span>
                <span className="text-body"> / {formatNumber(batch.quantity)} helmets</span>
              </p>
            </div>
            <ProgressBar value={batch.generatedCount} max={batch.quantity} />
            {batch.generationError && (
              <p className="flex items-center gap-2 text-sm text-danger" role="alert">
                <AlertTriangle className="h-4 w-4" aria-hidden /> {batch.generationError}
              </p>
            )}
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-body">Started</dt>
                <dd className="font-medium">{formatDateTime(batch.generationStartedAt)}</dd>
              </div>
              <div>
                <dt className="text-body">Completed</dt>
                <dd className="font-medium">{formatDateTime(batch.generationCompletedAt)}</dd>
              </div>
              <div>
                <dt className="text-body">Created by</dt>
                <dd className="font-medium">{batch.createdBy?.name ?? '—'}</dd>
              </div>
            </dl>
            {batch.notes && <p className="rounded-md bg-canvas-soft p-3 text-sm">{batch.notes}</p>}
          </CardContent>
        </Card>
        <Card className={batch.printStatus === 'PRINTED' ? '' : 'border-ink'}>
          <CardHeader>
            <CardTitle>Labels &amp; PINs</CardTitle>
            <CardDescription>
              Activation PINs are only exportable until labels are printed.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-body">Print status</span>
              <PrintBadge status={batch.printStatus} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-body">PINs in escrow</span>
              <span className="font-medium tabular-nums">{formatNumber(batch.pinsEscrowed)}</span>
            </div>
            {batch.printedAt && (
              <div className="flex items-center justify-between">
                <span className="text-body">Printed</span>
                <span className="font-medium">{formatDateTime(batch.printedAt)}</span>
              </div>
            )}
            <p className="rounded-md bg-canvas-soft p-3 text-xs text-body">
              Every CSV export is audited. PINs are stored encrypted and permanently destroyed when
              the batch is marked printed.
            </p>
          </CardContent>
        </Card>
      </div>

      {batch.generatedCount > 0 && (
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-display-sm font-bold">Helmets in this batch</h2>
            <Link
              to={`/helmets?batchId=${batch.id}`}
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              Open in helmet search
            </Link>
          </div>
          <HelmetTable fixedFilters={{ batchId: batch.id }} pageSize={10} />
        </section>
      )}

      <Dialog
        open={confirmPrint}
        onClose={() => setConfirmPrint(false)}
        title="Mark batch as printed?"
        description="This cannot be undone."
      >
        <ul className="mb-5 list-disc space-y-1 pl-5 text-sm text-body">
          <li>{formatNumber(batch.generatedCount)} helmets move from Generated to Printed.</li>
          <li>
            {formatNumber(batch.pinsEscrowed)} escrowed activation PINs are permanently destroyed.
          </li>
          <li>Future CSV exports will not include PINs.</li>
        </ul>
        <InlineError error={markPrinted.error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="subtle" onClick={() => setConfirmPrint(false)}>
            Cancel
          </Button>
          <Button onClick={() => markPrinted.mutate()} loading={markPrinted.isPending}>
            Confirm printed
          </Button>
        </div>
      </Dialog>
    </>
  );
}
