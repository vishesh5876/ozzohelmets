import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Permission, type PrintDesignDto } from '@helmet/types';
import { Button } from '@helmet/ui';
import { Dialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { RequirePermission } from '../../components/RequirePermission';
import { EmptyState, ErrorState, InlineError, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber } from '../../lib/format';
import { DesignPreview, DesignStatusBadge, QualityLabel } from './shared';
import { resolutionText } from './design-format';

/** Print Designs: admin-controlled Safety ID artwork, versioned. */
export function PrintDesignsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<PrintDesignDto | null>(null);
  const q = useQuery({
    queryKey: ['print-designs'],
    queryFn: () => api.get<PrintDesignDto[]>('/admin/print-designs'),
  });
  const action = useMutation({
    mutationFn: ({ d, kind }: { d: PrintDesignDto; kind: string }) =>
      api.post<PrintDesignDto>(`/admin/print-designs/${d.id}/${kind}`),
    onSuccess: async (d, v) => {
      await qc.invalidateQueries({ queryKey: ['print-designs'] });
      if (v.kind === 'duplicate') navigate(`/print-designs/${d.id}`);
    },
  });
  return (
    <>
      <PageHeader
        title="Print Designs"
        description="Artwork for the 4.5 × 1 in Safety ID sticker. The system always generates the Safety ID, PIN, QR, cover and cut geometry."
        actions={
          <RequirePermission permission={Permission.PRINT_DESIGN_MANAGE}>
            <Button variant="subtle" onClick={() => navigate('/print-designs/new')}>
              Upload Artwork
            </Button>
            <Button onClick={() => navigate('/print-designs/new/studio')}>
              Design in Print Studio
            </Button>
          </RequirePermission>
        }
      />
      <InlineError error={action.error} />
      {q.isLoading && <LoadingState />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.length === 0 && (
        <EmptyState
          title="No print designs yet"
          description="Until a design is active, new batches use the built-in layout."
        />
      )}
      {q.data && q.data.length > 0 && (
        <Table>
          <THead>
            <tr>
              <Th>Design</Th>
              <Th>Artwork</Th>
              <Th>Created</Th>
              <Th className="text-right">Batches</Th>
              <Th className="w-56">Actions</Th>
            </tr>
          </THead>
          <tbody>
            {q.data.map((d) => (
              <Tr key={d.id} data-testid="print-design-row">
                <Td>
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => setPreview(d)}
                      className="w-40 shrink-0 overflow-hidden rounded-sm border border-hairline hover:border-ink"
                      aria-label={`Preview ${d.name} v${d.version}`}
                    >
                      <DesignPreview
                        designId={d.id}
                        kind="unit"
                        version={d.updatedAt}
                        className="block w-full bg-canvas"
                      />
                    </button>
                    <div className="min-w-0">
                      <Link
                        to={`/print-designs/${d.id}`}
                        className="block font-medium hover:underline"
                      >
                        {d.name}
                      </Link>
                      <div className="mt-1 flex items-center gap-2 text-xs text-body">
                        <span className="tabular-nums">v{d.version}</span>
                        <DesignStatusBadge status={d.status} />
                      </div>
                    </div>
                  </div>
                </Td>
                <Td>
                  <span className="block text-xs text-body">
                    {d.baseArtwork
                      ? resolutionText(d.baseArtwork)
                      : `Print Studio · ${d.studioDocument?.layers.length ?? 0} layers`}
                  </span>
                  <QualityLabel quality={d.quality} dpi={d.effectiveDpi} />
                </Td>
                <Td className="whitespace-nowrap text-body">
                  <span className="block">{formatDateTime(d.createdAt)}</span>
                  <span className="block text-xs">{d.createdBy?.name ?? '—'}</span>
                </Td>
                <Td className="text-right tabular-nums">{formatNumber(d.usedByBatches)}</Td>
                <Td>
                  {/* Fixed two-column grid: the same action always sits in the same place. */}
                  <div className="grid grid-cols-2 gap-1">
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() => navigate(`/print-designs/${d.id}`)}
                    >
                      Open
                    </Button>
                    <RequirePermission permission={Permission.PRINT_DESIGN_MANAGE}>
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => action.mutate({ d, kind: 'duplicate' })}
                      >
                        Duplicate
                      </Button>
                    </RequirePermission>
                    {d.status !== 'ACTIVE' && d.validationErrors.length === 0 && (
                      <RequirePermission permission={Permission.PRINT_DESIGN_ACTIVATE}>
                        <Button
                          size="sm"
                          variant="subtle"
                          onClick={() => action.mutate({ d, kind: 'activate' })}
                        >
                          Activate
                        </Button>
                      </RequirePermission>
                    )}
                    {d.status !== 'ARCHIVED' && (
                      <RequirePermission permission={Permission.PRINT_DESIGN_MANAGE}>
                        <Button
                          size="sm"
                          variant="subtle"
                          onClick={() => action.mutate({ d, kind: 'archive' })}
                        >
                          Archive
                        </Button>
                      </RequirePermission>
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview ? `${preview.name} · v${preview.version}` : ''}
        description="Sample data (ID SI-7958-72SA, PIN 146628) rendered by the production layout engine."
      >
        {preview && <DesignPreview designId={preview.id} kind="unit" version={preview.updatedAt} />}
      </Dialog>
    </>
  );
}
