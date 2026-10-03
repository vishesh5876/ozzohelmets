import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Spinner } from '@helmet/ui';
import { apiBlob } from '../lib/api';

/** Renders an image from an authenticated API endpoint (Authorization headers can't go on <img src>). */
export function AuthImage({
  path,
  alt,
  className,
}: {
  path: string;
  alt: string;
  className?: string;
}) {
  const { data, isError } = useQuery({
    queryKey: ['blob', path],
    queryFn: () => apiBlob(path).then((r) => r.blob),
    staleTime: 5 * 60_000,
  });
  const url = useMemo(() => (data ? URL.createObjectURL(data) : null), [data]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);

  if (isError) return <p className="text-sm text-danger">Could not load image.</p>;
  if (!url) return <Spinner />;
  return <img src={url} alt={alt} className={className} />;
}
