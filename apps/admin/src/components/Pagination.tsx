import type { PaginationMeta } from '@helmet/types';
import { Button } from '@helmet/ui';
import { formatNumber } from '../lib/format';

export function Pagination({
  meta,
  onPage,
}: {
  meta: PaginationMeta;
  onPage: (page: number) => void;
}) {
  const from = meta.total === 0 ? 0 : (meta.page - 1) * meta.pageSize + 1;
  const to = Math.min(meta.page * meta.pageSize, meta.total);
  return (
    <nav
      className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row"
      aria-label="Pagination"
    >
      <p className="text-sm text-body">
        Showing <span className="font-medium text-ink">{formatNumber(from)}</span>–
        <span className="font-medium text-ink">{formatNumber(to)}</span> of{' '}
        <span className="font-medium text-ink">{formatNumber(meta.total)}</span>
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="subtle"
          size="sm"
          disabled={meta.page <= 1}
          onClick={() => onPage(meta.page - 1)}
        >
          Previous
        </Button>
        <span className="text-sm text-body">
          Page {meta.page} of {meta.totalPages}
        </span>
        <Button
          variant="subtle"
          size="sm"
          disabled={meta.page >= meta.totalPages}
          onClick={() => onPage(meta.page + 1)}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
