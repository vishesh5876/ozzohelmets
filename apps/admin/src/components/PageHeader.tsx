import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}

export function PageHeader({ title, description, actions, back }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back && (
          <Link
            to={back.to}
            className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-body hover:text-ink"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden /> {back.label}
          </Link>
        )}
        <h1 className="text-display-md font-bold sm:text-display-lg">{title}</h1>
        {description && <div className="mt-1 text-body">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
