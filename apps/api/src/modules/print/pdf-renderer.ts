import PDFDocument from 'pdfkit';
import { type PrintSheetLayout, placeUnit } from '@helmet/types';
import { planCuts, sheetSizePt } from './cut-lines';
import type { DrawElement, StickerGeometry, TextMetrics, Weight } from './sticker-layout';

/**
 * True-size vector PDF output (pdfkit). One PDF page = one physical sheet at exact size
 * (1 pt = 1/72 in); every unit is drawn at fixed coordinates — no scaling, no rasterising,
 * no "fit to page". Text, logo, QR and shapes are all vectors.
 */

export interface PrintFonts {
  /** Embedded TrueType/OpenType files (vendor-approved), or null for PDF base-14 Helvetica. */
  regularPath: string | null;
  boldPath: string | null;
}

const FONT = { regular: 'SafetyId-Regular', bold: 'SafetyId-Bold' } as const;

function registerFonts(doc: PDFKit.PDFDocument, fonts: PrintFonts): void {
  doc.registerFont(FONT.regular, fonts.regularPath ?? 'Helvetica');
  doc.registerFont(FONT.bold, fonts.boldPath ?? 'Helvetica-Bold');
}

/** Metrics from the very fonts the PDF uses, so layout and output agree to the point. */
export function createTextMetrics(fonts: PrintFonts): TextMetrics {
  const doc = new PDFDocument({ autoFirstPage: false });
  registerFonts(doc, fonts);
  const caps = new Map<Weight, number>();
  return {
    width(text, weight, size, characterSpacing = 0) {
      doc.font(FONT[weight]).fontSize(size);
      return doc.widthOfString(text, { characterSpacing });
    },
    capHeight(weight) {
      let c = caps.get(weight);
      if (c === undefined) {
        doc.font(FONT[weight]);
        const font = (doc as unknown as { _font: { capHeight: number; ascender: number } })._font;
        c = (font.capHeight || font.ascender * 0.75) / 1000;
        caps.set(weight, c);
      }
      return c;
    },
  };
}

/** Draws a display list with its origin at (ox, oy). */
export function drawElements(
  doc: PDFKit.PDFDocument,
  elements: DrawElement[],
  ox: number,
  oy: number,
): void {
  for (const el of elements) {
    switch (el.kind) {
      case 'rect': {
        doc.save();
        if (el.radius) doc.roundedRect(ox + el.x, oy + el.y, el.w, el.h, el.radius);
        else doc.rect(ox + el.x, oy + el.y, el.w, el.h);
        if (el.fill) doc.fill(el.fill);
        else if (el.stroke) {
          if (el.dash) doc.dash(el.dash, { space: el.dash });
          doc.lineWidth(el.lineWidth ?? 0.5).stroke(el.stroke);
        }
        doc.restore();
        break;
      }
      case 'polygon':
        doc.save();
        doc
          .polygon(...el.points.map(([x, y]) => [ox + x, oy + y] as [number, number]))
          .fill(el.fill);
        doc.restore();
        break;
      case 'text': {
        const left = el.anchor === 'middle' ? el.x - el.width / 2 : el.x;
        doc.save();
        if (el.rotate) doc.rotate(el.rotate, { origin: [ox + el.x, oy + el.y] });
        doc
          .font(FONT[el.weight])
          .fontSize(el.size)
          .fillColor(el.fill)
          .text(el.text, ox + left, oy + el.y, {
            lineBreak: false,
            baseline: 'alphabetic',
            characterSpacing: el.characterSpacing,
          });
        doc.restore();
        break;
      }
      case 'logo':
        for (const p of el.logo.paths) {
          doc.save();
          doc.translate(ox + el.x, oy + el.y).scale(el.scale);
          doc.path(p.d).fill(p.fill, p.fillRule === 'evenodd' ? 'even-odd' : 'non-zero');
          doc.restore();
        }
        break;
      case 'logo-placeholder':
        doc.save();
        doc
          .rect(ox + el.x, oy + el.y, el.w, el.h)
          .dash(1, { space: 1 })
          .lineWidth(0.4)
          .stroke('#000000');
        doc.undash();
        doc
          .font(FONT.bold)
          .fontSize(4)
          .fillColor('#000000')
          .text('LOGO ASSET MISSING', ox + el.x + 1.5, oy + el.y + el.h / 2 + 1.4, {
            lineBreak: false,
            baseline: 'alphabetic',
          });
        doc.restore();
        break;
      case 'qr': {
        const n = el.matrix.size;
        const mod = el.size / (n + 2 * el.quietZoneModules);
        doc.save();
        doc
          .translate(ox + el.x + el.quietZoneModules * mod, oy + el.y + el.quietZoneModules * mod)
          .scale(mod);
        // Horizontal runs of dark modules in integer module coordinates: compact and exact.
        let any = false;
        for (let r = 0; r < n; r++) {
          let c = 0;
          while (c < n) {
            if (!el.matrix.data[r * n + c]) {
              c++;
              continue;
            }
            const start = c;
            while (c < n && el.matrix.data[r * n + c]) c++;
            doc.rect(start, r, c - start, 1);
            any = true;
          }
        }
        if (any) doc.fill('#000000');
        doc.restore();
        break;
      }
    }
  }
}

export interface SheetPdfOptions {
  layout: PrintSheetLayout;
  fonts: PrintFonts;
  title: string;
  /** Production files are compressed; tests read the raw content streams. */
  compress?: boolean;
  /** QA proof: trim/kiss-cut lines drawn over the artwork of every page. Never for production. */
  proofGuides?: StickerGeometry;
}

/** A sheet PDF being written unit by unit (streamed: pages are flushed as they complete). */
export class SheetPdf {
  readonly doc: PDFKit.PDFDocument;
  private page = 0;

  constructor(private readonly opts: SheetPdfOptions) {
    this.doc = new PDFDocument({
      autoFirstPage: false,
      compress: opts.compress ?? true,
      margin: 0,
      info: { Title: opts.title, Creator: 'OZZO Safety ID print engine', Producer: 'pdfkit' },
    });
    registerFonts(this.doc, opts.fonts);
  }

  /** Draws unit number `index` (0-based, export order) at its fixed sheet position. */
  addUnit(index: number, elements: DrawElement[]): void {
    const p = placeUnit(index, this.opts.layout);
    while (this.page < p.sheet) this.newPage();
    drawElements(this.doc, elements, p.xPt, p.yPt);
  }

  get pages(): number {
    return this.page;
  }

  /** Finishes the document (the caller has piped `doc` somewhere). */
  end(): void {
    this.closePage();
    this.doc.end();
  }

  private closePage(): void {
    if (this.page > 0 && this.opts.proofGuides)
      drawCutPlan(this.doc, this.opts.layout, this.opts.proofGuides, { spot: false });
  }

  private newPage(): void {
    this.closePage();
    const { width, height } = sheetSizePt(this.opts.layout);
    this.doc.addPage({ size: [width, height], margin: 0 });
    this.page++;
  }
}

/**
 * The die / cut guide: one sheet-size page with no artwork. Spot colours `ThroughCut` (unit trim)
 * and `CutContour` (kiss cuts: base | cover split and the rounded cover outline) — rename to the
 * vendor's convention if needed (docs/SAFETY-ID-PRINT.md).
 */
export function cutGuidePdf(
  layout: PrintSheetLayout,
  g: StickerGeometry,
  title: string,
  compress = true,
) {
  const doc = new PDFDocument({
    autoFirstPage: false,
    compress,
    margin: 0,
    info: { Title: title, Creator: 'OZZO Safety ID print engine', Producer: 'pdfkit' },
  });
  const { width, height } = sheetSizePt(layout);
  doc.addPage({ size: [width, height], margin: 0 });
  drawCutPlan(doc, layout, g, { spot: true });
  return doc;
}

function drawCutPlan(
  doc: PDFKit.PDFDocument,
  layout: PrintSheetLayout,
  g: StickerGeometry,
  opts: { spot: boolean },
): void {
  const plan = planCuts(layout, g);
  let through = '#00AEEF';
  let kiss = '#EC008C';
  if (opts.spot) {
    // pdfkit supports Separation spot colours; its typings don't declare the method.
    const spot = doc as unknown as {
      addSpotColor(name: string, c: number, m: number, y: number, k: number): void;
    };
    spot.addSpotColor('ThroughCut', 100, 0, 0, 0);
    spot.addSpotColor('CutContour', 0, 100, 0, 0);
    through = 'ThroughCut';
    kiss = 'CutContour';
  }
  doc.save().lineWidth(0.25);
  for (const s of plan.through) doc.moveTo(s.x1, s.y1).lineTo(s.x2, s.y2);
  doc.stroke(through);
  for (const s of plan.kissBase) doc.moveTo(s.x1, s.y1).lineTo(s.x2, s.y2);
  for (const c of plan.kissCover) doc.roundedRect(c.x, c.y, c.w, c.h, c.r);
  doc.stroke(kiss);
  doc.restore();
}
