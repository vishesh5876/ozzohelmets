import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  type BatchDto,
  Permission,
  type PrintDesignDto,
  type SafetyIdBatchDto,
} from '@helmet/types';
import { Button, Field, humanizeEnum, Input, Select, Textarea } from '@helmet/ui';
import { Dialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { RequirePermission } from '../../components/RequirePermission';
import { EmptyState, ErrorState, InlineError, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-context';
import { DesignPreview } from '../print-designs/shared';
import { formatDateTime, formatNumber } from '../../lib/format';
import { GenerationBadge, PrintBadge } from '../batches/BatchStatus';

/** Safety ID batches: standalone stickers/cards, or one Safety ID per helmet of a helmet batch. */
export function SafetyIdBatchesPage() {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['safety-id-batches', page],
    queryFn: () => api.page<SafetyIdBatchDto>('/admin/safety-id-batches', { page, pageSize: 25 }),
  });
  return (
    <>
      <PageHeader
        title="Safety ID batches"
        description="Generate Safety IDs (QR + Activation PIN), export or print them, then mark the batch printed."
        actions={
          <RequirePermission permission={Permission.SAFETY_IDS_GENERATE}>
            <Button onClick={() => setCreating(true)}>New Safety ID batch</Button>
          </RequirePermission>
        }
      />
      {q.isLoading && <LoadingState />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.items.length === 0 && (
        <EmptyState
          title="No Safety ID batches"
          description="Helmet batches created with Safety IDs also appear here."
        />
      )}
      {q.data && q.data.items.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Batch</Th>
                <Th>Mode</Th>
                <Th className="text-right">Safety IDs</Th>
                <Th>Generation</Th>
                <Th>Print</Th>
                <Th>Created</Th>
              </tr>
            </THead>
            <tbody>
              {q.data.items.map((b) => (
                <Tr key={b.id}>
                  <Td>
                    <Link
                      to={`/safety-id-batches/${b.id}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {b.batchCode}
                    </Link>
                  </Td>
                  <Td>
                    {humanizeEnum(b.mode)}
                    {b.helmetBatch && (
                      <span className="block font-mono text-xs text-body">
                        {b.helmetBatch.batchCode}
                      </span>
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {formatNumber(b.generatedCount)} / {formatNumber(b.quantity)}
                  </Td>
                  <Td>
                    <GenerationBadge status={b.generationStatus} />
                  </Td>
                  <Td>
                    <PrintBadge status={b.printStatus} />
                  </Td>
                  <Td className="text-body">{formatDateTime(b.createdAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination meta={q.data.meta} onPage={setPage} />
        </>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'STANDALONE' | 'HELMET_LINKED'>('STANDALONE');
  const [quantity, setQuantity] = useState('100');
  const [helmetBatchId, setHelmetBatchId] = useState('');
  const [notes, setNotes] = useState('');
  const { can } = useAuth();
  const canChooseDesign = can(Permission.PRINT_DESIGN_VIEW);
  const [designId, setDesignId] = useState<string>('');
  const [previewDesign, setPreviewDesign] = useState(false);
  const designs = useQuery({
    queryKey: ['print-designs', 'selectable'],
    queryFn: () => api.get<PrintDesignDto[]>('/admin/print-designs'),
    enabled: canChooseDesign,
  });
  const selectable = (designs.data ?? []).filter(
    (d) => d.status === 'ACTIVE' || (d.status === 'DRAFT' && d.validationErrors.length === 0),
  );
  const activeDesign = selectable.find((d) => d.status === 'ACTIVE');
  const chosen = selectable.find((d) => d.id === designId) ?? activeDesign;
  const helmetBatches = useQuery({
    queryKey: ['batches', 'safety-id-options'],
    queryFn: () =>
      api.page<BatchDto>('/admin/batches', { generationStatus: 'COMPLETED', pageSize: 100 }),
    enabled: mode === 'HELMET_LINKED',
  });
  const create = useMutation({
    mutationFn: async () => {
      const batch = await api.post<SafetyIdBatchDto>('/admin/safety-id-batches', {
        mode,
        ...(mode === 'STANDALONE' ? { quantity: Number(quantity) } : { helmetBatchId }),
        printDesignId: designId || undefined,
        notes: notes.trim() || undefined,
      });
      await api.post(`/admin/safety-id-batches/${batch.id}/generate`);
      return batch;
    },
    onSuccess: async (batch) => {
      await qc.invalidateQueries({ queryKey: ['safety-id-batches'] });
      navigate(`/safety-id-batches/${batch.id}`);
    },
  });
  return (
    <Dialog open onClose={onClose} title="New Safety ID batch">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Mode" htmlFor="sib-mode">
          <Select
            id="sib-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="STANDALONE">Standalone (stickers / cards, no helmet)</option>
            <option value="HELMET_LINKED">For an existing helmet batch</option>
          </Select>
        </Field>
        {mode === 'STANDALONE' ? (
          <Field label="Quantity" htmlFor="sib-qty">
            <Input
              id="sib-qty"
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
        ) : (
          <Field
            label="Helmet batch"
            htmlFor="sib-helmet-batch"
            hint="One Safety ID for each helmet of this batch that has none yet."
          >
            <Select
              id="sib-helmet-batch"
              value={helmetBatchId}
              onChange={(e) => setHelmetBatchId(e.target.value)}
            >
              <option value="">Choose a batch</option>
              {(helmetBatches.data?.items ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.batchCode} · {b.helmetModel.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {canChooseDesign && (
          <Field
            label="Print Design"
            htmlFor="sib-design"
            hint="The batch keeps this exact design version forever; later design changes never affect it."
          >
            <div className="flex items-center gap-2">
              <Select
                id="sib-design"
                value={designId}
                onChange={(e) => setDesignId(e.target.value)}
              >
                <option value="">
                  {activeDesign
                    ? `${activeDesign.name} v${activeDesign.version} (Active)`
                    : 'No active design — built-in layout'}
                </option>
                {selectable
                  .filter((d) => d.status !== 'ACTIVE')
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} v{d.version} (Draft)
                    </option>
                  ))}
              </Select>
              {chosen && (
                <Button
                  type="button"
                  size="sm"
                  variant="subtle"
                  onClick={() => setPreviewDesign((v) => !v)}
                >
                  Preview
                </Button>
              )}
            </div>
            {chosen && previewDesign && (
              <div className="mt-2">
                <DesignPreview designId={chosen.id} kind="unit" version={chosen.updatedAt} />
              </div>
            )}
          </Field>
        )}
        <Field label="Notes (optional)" htmlFor="sib-notes">
          <Textarea
            id="sib-notes"
            rows={2}
            maxLength={1000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <InlineError error={create.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={create.isPending}
            disabled={mode === 'STANDALONE' ? !(Number(quantity) >= 1) : !helmetBatchId}
          >
            Create and generate
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
