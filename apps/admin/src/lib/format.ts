const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const numberFmt = new Intl.NumberFormat();

export const formatDate = (iso: string | null | undefined) =>
  iso ? dateFmt.format(new Date(iso)) : '—';
export const formatDateTime = (iso: string | null | undefined) =>
  iso ? dateTimeFmt.format(new Date(iso)) : '—';
export const formatNumber = (n: number) => numberFmt.format(n);

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function filenameFromDisposition(header: string | null, fallback: string): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? fallback;
}
export const pct = (v: number) => `${Math.round(v * 100)}%`;
