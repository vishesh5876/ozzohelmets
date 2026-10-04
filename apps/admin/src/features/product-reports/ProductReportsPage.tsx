import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Permission,
  PRODUCT_REPORT_PRIORITIES,
  type ProductReportDetailDto,
  type ProductReportDto,
  type ProductReportPriority,
  ProductReportStatus,
} from '@helmet/types';
import { Badge, type BadgeProps, Button, humanizeEnum, Select, Textarea } from '@helmet/ui';
import { Dialog } from '../../components/Dialog';
import { useAuth } from '../../lib/auth-context';
import { PageHeader } from '../../components/PageHeader';
import { Pagination } from '../../components/Pagination';
import { RequirePermission } from '../../components/RequirePermission';
import { EmptyState, ErrorState, InlineError, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

const TONE: Record<ProductReportStatus, NonNullable<BadgeProps['tone']>> = {
  OPEN: 'solid',
  REVIEWING: 'soft',
  RESOLVED: 'outline',
  DISMISSED: 'muted',
};

/** Public "report a problem" submissions. No automated counterfeit judgement. */
export function ProductReportsPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ProductReportStatus | ''>('OPEN');
  const [assignee, setAssignee] = useState<'' | 'me' | 'unassigned'>('');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['product-reports', page, status, assignee],
    queryFn: () =>
      api.page<ProductReportDto>('/admin/product-reports', {
        page,
        pageSize: 25,
        status: status || undefined,
        assignee: assignee || undefined,
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Product reports"
        description="Problems reported from the public verification page. Reports are never shown publicly."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select
          className="max-w-[12rem]"
          aria-label="Assignee"
          value={assignee}
          onChange={(e) => {
            setAssignee(e.target.value as '' | 'me' | 'unassigned');
            setPage(1);
          }}
        >
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
        </Select>
        <Select
          className="max-w-[12rem]"
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as ProductReportStatus | '');
            setPage(1);
          }}
        >
          <option value="">All</option>
          {Object.values(ProductReportStatus).map((s) => (
            <option key={s} value={s}>
              {humanizeEnum(s)}
            </option>
          ))}
        </Select>
      </div>
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && data.items.length === 0 && (
        <EmptyState
          title="No product reports"
          description="Nothing matches these filters. New public reports appear here as Open."
        />
      )}
      {data && data.items.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Received</Th>
                <Th>Reason</Th>
                <Th>Helmet</Th>
                <Th>Details</Th>
                <Th>Contact</Th>
                <Th>Priority</Th>
                <Th>Assignee</Th>
                <Th>Status</Th>
              </tr>
            </THead>
            <tbody>
              {data.items.map((r) => (
                <ReportRow key={r.id} report={r} />
              ))}
            </tbody>
          </Table>
          <Pagination meta={data.meta} onPage={setPage} />
        </>
      )}
    </>
  );
}

type ReportPatch = {
  status?: ProductReportStatus;
  priority?: ProductReportPriority;
  assignedAdminId?: string | null;
  internalNote?: string;
};

function useReportUpdate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ReportPatch) =>
      api.patch<ProductReportDetailDto>(`/admin/product-reports/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['product-reports'] }),
  });
}

function ReportRow({ report }: { report: ProductReportDto }) {
  const { admin } = useAuth();
  const [historyOpen, setHistoryOpen] = useState(false);
  const update = useReportUpdate(report.id);
  return (
    <Tr data-testid="product-report">
      <Td className="whitespace-nowrap text-body">{formatDateTime(report.createdAt)}</Td>
      <Td>{humanizeEnum(report.reason)}</Td>
      <Td className="font-mono text-xs">
        {report.helmet ? (
          <Link to={`/helmets/${report.helmet.id}`} className="hover:underline">
            {report.helmet.helmetCode}
          </Link>
        ) : (
          <span className="text-body">Unknown QR</span>
        )}
      </Td>
      {/* Rendered as plain text (React escapes it); length-limited server-side. */}
      <Td className="max-w-xs whitespace-pre-wrap break-words text-sm">
        {report.description ?? '—'}
      </Td>
      <Td className="text-xs">{report.contactEmail ?? '—'}</Td>
      <Td>
        <RequirePermission
          permission={Permission.PRODUCT_REPORT_MANAGE}
          fallback={<span>{humanizeEnum(report.priority)}</span>}
        >
          <Select
            aria-label="Report priority"
            value={report.priority}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ priority: e.target.value as ProductReportPriority })}
          >
            {PRODUCT_REPORT_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {humanizeEnum(p)}
              </option>
            ))}
          </Select>
        </RequirePermission>
      </Td>
      <Td className="text-sm">
        <p>{report.assignee?.name ?? 'Unassigned'}</p>
        <RequirePermission permission={Permission.PRODUCT_REPORT_MANAGE}>
          <Button
            size="sm"
            variant="ghost"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({
                assignedAdminId: report.assignee?.id === admin?.id ? null : (admin?.id ?? null),
              })
            }
          >
            {report.assignee?.id === admin?.id ? 'Unassign' : 'Assign to me'}
          </Button>
        </RequirePermission>
        <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>
          History & notes
        </Button>
        {historyOpen && (
          <ReportHistoryDialog id={report.id} onClose={() => setHistoryOpen(false)} />
        )}
      </Td>
      <Td>
        <RequirePermission
          permission={Permission.PRODUCT_REPORT_MANAGE}
          fallback={<Badge tone={TONE[report.status]}>{humanizeEnum(report.status)}</Badge>}
        >
          <Select
            aria-label="Report status"
            value={report.status}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ status: e.target.value as ProductReportStatus })}
          >
            {Object.values(ProductReportStatus).map((s) => (
              <option key={s} value={s}>
                {humanizeEnum(s)}
              </option>
            ))}
          </Select>
          <InlineError error={update.error} />
        </RequirePermission>
      </Td>
    </Tr>
  );
}

/** Internal triage history and notes. Never shown to the reporter or publicly. */
function ReportHistoryDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [note, setNote] = useState('');
  const detail = useQuery({
    queryKey: ['product-reports', 'detail', id],
    queryFn: () => api.get<ProductReportDetailDto>(`/admin/product-reports/${id}`),
  });
  const update = useReportUpdate(id);
  return (
    <Dialog open onClose={onClose} title="Report history" description="Internal notes and changes.">
      {detail.isLoading && <LoadingState />}
      {detail.data && (
        <div className="flex flex-col gap-4">
          {detail.data.events.length === 0 ? (
            <p className="text-sm text-body">No changes yet.</p>
          ) : (
            <ol className="flex flex-col gap-2 text-sm">
              {detail.data.events.map((e) => (
                <li key={e.id} className="rounded-md bg-canvas-soft px-3 py-2">
                  <p className="font-medium">
                    {humanizeEnum(e.type)}
                    {e.fromValue || e.toValue
                      ? `: ${e.fromValue ? humanizeEnum(e.fromValue) : '—'} → ${e.toValue ? humanizeEnum(e.toValue) : '—'}`
                      : ''}
                  </p>
                  {e.note && <p className="whitespace-pre-wrap break-words">{e.note}</p>}
                  <p className="text-xs text-body">
                    {e.adminName ?? 'Admin'} · {formatDateTime(e.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
          )}
          <RequirePermission permission={Permission.PRODUCT_REPORT_MANAGE}>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                update.mutate(
                  { internalNote: note.trim() },
                  {
                    onSuccess: () => {
                      setNote('');
                      void detail.refetch();
                    },
                  },
                );
              }}
            >
              <label htmlFor="report-note" className="text-sm font-medium">
                Internal note
              </label>
              <Textarea
                id="report-note"
                rows={3}
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <InlineError error={update.error} />
              <Button type="submit" size="sm" disabled={!note.trim()} loading={update.isPending}>
                Add note
              </Button>
            </form>
          </RequirePermission>
        </div>
      )}
    </Dialog>
  );
}
