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
      if (v.kind === 'duplicate' || v.kind === 'new-version') navigate(`/print-designs/${d.id}`);
    },
  });
  return (
    <>
      <PageHeader
        title="Print Designs"
        description="Artwork for the 4.5 × 1 in Safety ID sticker. The system always generates the Safety ID, PIN, QR, cover and cut geometry."
        actions={
          <RequirePermission permission={Permission.PRINT_DESIGN_MANAGE}>
            <Button onClick={() => navigate('/print-designs/new')}>Create Design</Button>
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
              <Th>Name</Th>
              <Th>Version</Th>
              <Th>Status</Th>
              <Th>Type</Th>
              <Th>Resolution</Th>
              <Th>Created</Th>
              <Th>Created by</Th>
              <Th className="text-right">Used by batches</Th>
              <Th>Actions</Th>
            </tr>
          </THead>
          <tbody>
            {q.data.map((d) => (
              <Tr key={d.id} data-testid="print-design-row">
                <Td>
                  <Link to={`/print-designs/${d.id}`} className="font-medium hover:underline">
                    {d.name}
                  </Link>
                </Td>
                <Td className="tabular-nums">v{d.version}</Td>
                <Td>
                  <DesignStatusBadge status={d.status} />
                </Td>
                <Td>{d.artworkType}</Td>
                <Td>
                  <span className="block text-xs text-body">{resolutionText(d.baseArtwork)}</span>
                  <QualityLabel quality={d.quality} dpi={d.effectiveDpi} />
                </Td>
                <Td className="text-body">{formatDateTime(d.createdAt)}</Td>
                <Td className="text-body">{d.createdBy?.name ?? '—'}</Td>
                <Td className="text-right tabular-nums">{formatNumber(d.usedByBatches)}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="subtle" onClick={() => setPreview(d)}>
                      Preview
                    </Button>
                    <RequirePermission permission={Permission.PRINT_DESIGN_MANAGE}>
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => action.mutate({ d, kind: 'duplicate' })}
                      >
                        Duplicate
                      </Button>
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => action.mutate({ d, kind: 'new-version' })}
                      >
                        Create New Version
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
