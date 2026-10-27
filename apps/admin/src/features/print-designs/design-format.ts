import type { PrintArtworkFileDto } from '@helmet/types';

export function resolutionText(f: PrintArtworkFileDto): string {
  return f.format === 'SVG' ? `SVG · viewBox ${f.svgViewBox}` : `${f.widthPx} × ${f.heightPx} px`;
}

export const GUIDE_LEGEND: [string, string][] = [
  ['#5F6368', 'Sticker boundary (4.5 × 1 in)'],
  ['#00897B', 'Visible artwork area (emergency panel, 2.2 × 1 in)'],
  ['#34A853', 'Print safe area'],
  ['#9AA0A6', 'System credential panel (white)'],
  ['#F29900', 'Dynamic Safety ID'],
  ['#FF00FF', 'Protected target (PIN + QR)'],
  ['#7B1FA2', 'QR + quiet zone'],
  ['#00A0FF', 'Cover placement / cover cut'],
];
