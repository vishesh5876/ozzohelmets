// Control characters are matched on purpose: they are stripped from user-entered free text.
/* eslint-disable no-control-regex */
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;
/* eslint-enable no-control-regex */

/**
 * Normalises short user-entered text: strips control characters (keeping newlines when
 * `multiline`), trims, and turns empty strings into undefined. Output is always rendered as
 * text (never HTML) by the clients.
 */
export function plainText(value: unknown, multiline = false): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(multiline ? CONTROL_EXCEPT_NEWLINE : CONTROL_ALL, ' ').trim() || undefined;
}
