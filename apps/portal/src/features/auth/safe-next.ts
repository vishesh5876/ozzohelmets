/** Only same-site relative paths are accepted as post-login destinations (no open redirect). */
export function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/app';
}
