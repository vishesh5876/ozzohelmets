import { type PrintSheetLayout, inToPt, placeUnit, unitsPerSheet } from '@helmet/types';
import { planCuts, sheetSizePt } from './cut-lines';
import { UNIT_H, UNIT_W } from './sticker-design';
import { type DrawElement, type StickerGeometry, textLeft } from './sticker-layout';

/**
 * Admin preview only (never a production file): the same display list as the PDF, as SVG in
 * PDF points. Text uses `textLength` = the width measured from the PDF fonts, so the preview's
 * proportions match the print. Browsers scale the SVG for display; coordinates stay physical.
 */

const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const n = (v: number) => String(Math.round(v * 1000) / 1000);

export function elementsToSvg(elements: DrawElement[]): string {
  let out = '';
  for (const el of elements) {
    switch (el.kind) {
      case 'rect': {
        const r = el.radius ? ` rx="${n(el.radius)}"` : '';
        const paint = el.fill
          ? `fill="${el.fill}"${el.stroke ? ` stroke="${el.stroke}" stroke-width="${n(el.lineWidth ?? 0.5)}"` : ''}`
          : `fill="none" stroke=""${el.stroke}" stroke-width="${n(el.lineWidth ?? 0.5)}"${
              el.dash ? ` stroke-dasharray="${n(el.dash)}"` : ''
            }`;
        out += `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}"${r} ${paint}/>`;
        break;
      }
      case 'polygon':
        out += `<polygon points="${el.points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="${el.fill}"/>`;
        break;
      case 'ellipse':
        out +=
          `<ellipse cx="${n(el.cx)}" cy="${n(el.cy)}" rx="${n(el.rx)}" ry="${n(el.ry)}" fill="${el.fill ?? 'none'}"` +
          (el.stroke ? ` stroke="${el.stroke}" stroke-width="${n(el.lineWidth ?? 0.5)}"` : '') +
          '/>';
        break;
      case 'group': {
        let inner = elementsToSvg(el.children);
        if (el.rotate)
          inner = `<g transform="rotate(${n(el.rotate.deg)} ${n(el.rotate.cx)} ${n(el.rotate.cy)})">${inner}</g>`;
        const c = el.clip;
        // A nested viewport clips without ids (the sheet preview reuses the unit via <use>).
        out += c
          ? `<svg x="${n(c.x)}" y="${n(c.y)}" width="${n(c.w)}" height="${n(c.h)}" viewBox="${n(c.x)} ${n(c.y)} ${n(c.w)} ${n(c.h)}" overflow="hidden">${inner}</svg>`
          : inner;
        break;
      }
      case 'text': {
        const left = textLeft(el);
        const rot = el.rotate ? ` transform="rotate(${el.rotate} ${n(el.x)} ${n(el.y)})"` : '';
        out +=
          `<text x="${n(left)}" y="${n(el.y)}"${rot} font-family="Helvetica, Arial, sans-serif"` +
          ` font-weight="${el.weight === 'bold' ? 700 : 400}" font-size="${n(el.size)}" fill="${el.fill}"` +
          ` textLength="${n(el.width)}" lengthAdjust="spacingAndGlyphs">${esc(el.text)}</text>`;
        break;
      }
      case 'logo':
        out += `<g transform="translate(${n(el.x)} ${n(el.y)}) scale(${el.scale})">`;
        for (const p of el.logo.paths)
          out += `<path d="${esc(p.d)}" fill="${p.fill}" fill-rule="${p.fillRule}"/>`;
        out += '</g>';
        break;
      case 'logo-placeholder':
        out +=
          `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" fill="none" stroke="#000" stroke-width="0.4" stroke-dasharray="1"/>` +
          `<text x="${n(el.x + 1.5)}" y="${n(el.y + el.h / 2 + 1.4)}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="4">LOGO ASSET MISSING</text>`;
        break;
      case 'artwork': {
        // Clip window in unit coordinates; artwork drawn at its exact (uniform) box inside it.
        const c = el.clip;
        let inner: string;
        if (el.artwork.format === 'SVG') {
          inner = el.artwork.svg!.replace(
            /^<svg /,
            `<svg x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" preserveAspectRatio="xMidYMid meet" `,
          );
        } else {
          inner = `<image x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${el.artwork.png!.toString('base64')}"/>`;
        }
        if (el.flipX || el.flipY)
          inner = `<g transform="translate(${n(el.flipX ? 2 * el.x + el.w : 0)} ${n(el.flipY ? 2 * el.y + el.h : 0)}) scale(${el.flipX ? -1 : 1} ${el.flipY ? -1 : 1})">${inner}</g>`;
        out += `<svg x="${n(c.x)}" y="${n(c.y)}" width="${n(c.w)}" height="${n(c.h)}" viewBox="${n(c.x)} ${n(c.y)} ${n(c.w)} ${n(c.h)}" overflow="hidden">${inner}</svg>`;
        break;
      }
      case 'qr': {
        const size = el.matrix.size;
        const mod = el.size / (size + 2 * el.quietZoneModules);
        let d = '';
        for (let r = 0; r < size; r++) {
          let c = 0;
          while (c < size) {
            if (!el.matrix.data[r * size + c]) {
              c++;
              continue;
            }
            const start = c;
            while (c < size && el.matrix.data[r * size + c]) c++;
            d += `M${start} ${r}h${c - start}v1h${start - c}z`;
          }
        }
        out +=
          `<g transform="translate(${n(el.x + el.quietZoneModules * mod)} ${n(el.y + el.quietZoneModules * mod)}) scale(${n(mod)})">` +
          `<path d="${d}" fill="#000000" shape-rendering="crispEdges"/></g>`;
        break;
      }
    }
  }
  return out;
}

/** One unit at true proportions (324 × 72 pt), on a white base. */
export function unitSvg(elements: DrawElement[], opts: { outline?: boolean } = {}): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNIT_W} ${UNIT_H}" width="${UNIT_W}pt" height="${UNIT_H}pt">` +
    `<rect width="${UNIT_W}" height="${UNIT_H}" fill="#FFFFFF"/>` +
    elementsToSvg(elements) +
    (opts.outline
      ? `<rect x="0.15" y="0.15" width="${UNIT_W - 0.3}" height="${UNIT_H - 0.3}" fill="none" stroke="#9AA0A6" stroke-width="0.3"/>`
      : '') +
    '</svg>'
  );
}

/** A whole sheet: `filled` positions carry the unit (drawn once, reused), the rest stay blank. */
export function sheetSvg(
  layout: PrintSheetLayout,
  g: StickerGeometry,
  unit: DrawElement[],
  filled: number,
  marks: DrawElement[] = [],
): string {
  const { width, height } = sheetSizePt(layout);
  const cuts = planCuts(layout, g);
  let uses = '';
  for (let i = 0; i < Math.min(filled, unitsPerSheet(layout)); i++) {
    const p = placeUnit(i, layout);
    uses += `<use href="#u" x="${n(p.xPt)}" y="${n(p.yPt)}"/>`;
  }
  const lines = cuts.through.map((s) => `M${n(s.x1)} ${n(s.y1)}L${n(s.x2)} ${n(s.y2)}`).join('');
  const kiss =
    cuts.kissBase.map((s) => `M${n(s.x1)} ${n(s.y1)}L${n(s.x2)} ${n(s.y2)}`).join('') +
    cuts.kissCover.map((c) => `M${n(c.x)} ${n(c.y)}h${n(c.w)}v${n(c.h)}h${n(-c.w)}z`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}pt" height="${n(height)}pt">` +
    `<defs><g id="u">${elementsToSvg(unit)}</g></defs>` +
    `<rect width="${n(width)}" height="${n(height)}" fill="#FFFFFF"/>` +
    uses +
    elementsToSvg(marks) +
    `<path d="${kiss}" fill="none" stroke="#EC008C" stroke-width="0.6" stroke-dasharray="2 2"/>` +
    `<path d="${lines}" fill="none" stroke="#00AEEF" stroke-width="0.8"/>` +
    `<rect x="0" y="0" width="${n(width)}" height="${n(height)}" fill="none" stroke="#5F6368" stroke-width="${n(inToPt(0.02))}"/>` +
    '</svg>'
  );
}
