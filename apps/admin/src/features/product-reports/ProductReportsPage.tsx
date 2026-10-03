import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Permission, type ProductReportDto, ProductReportStatus } from '@helmet/types';
import { Badge, type BadgeProps, humanizeEnum, Select } from '@helmet/ui';
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
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['product-reports', page, status],
    queryFn: () =>
      api.page<ProductReportDto>('/admin/product-reports', {
        page,
        pageSize: 25,
        status: status || undefined,
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Product reports"
        description="Problems reported from the public verification page. Reports are never shown publicly."
      />
      <div className="mb-4">
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
      {data && data.items.length === 0 && <EmptyState title="No reports" />}
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

function ReportRow({ report }: { report: ProductReportDto }) {
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (status: ProductReportStatus) =>
      api.patch<ProductReportDto>(`/admin/product-reports/${report.id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['product-reports'] }),
  });
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
          fallback={<Badge tone={TONE[report.status]}>{humanizeEnum(report.status)}</Badge>}
        >
          <Select
            aria-label="Report status"
            value={report.status}
            disabled={update.isPending}
            onChange={(e) => update.mutate(e.target.value as ProductReportStatus)}
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
