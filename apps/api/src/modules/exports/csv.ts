/**
 * RFC 4180 CSV encoding with spreadsheet formula-injection neutralisation (OWASP): a cell that
 * starts with `= + - @`, TAB or CR is prefixed with a single quote so spreadsheet software
 * treats it as text.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** One CSV line, CRLF-terminated. */
export function csvRow(values: ReadonlyArray<string | number | null | undefined>): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
