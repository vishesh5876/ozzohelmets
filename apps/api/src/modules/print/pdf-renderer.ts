import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import type { ArtworkAsset } from './artwork';
import { type PrintSheetLayout, placeUnit } from '@helmet/types';
import { planCuts, sheetSizePt } from './cut-lines';
import { registrationMarks, sheetMarks } from './sheet-marks';
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

/**
 * Asks PDF viewers to print at 100 %: "fit to page" shrinks the sheet, so cuts stop matching
 * the print. (pdfkit writes plain strings as PDF names: /PrintScaling /None.)
 */
function printAtActualSize(doc: PDFKit.PDFDocument): void {
  const d = doc as unknown as {
    _root: { data: Record<string, unknown> };
    ref(data: Record<string, unknown>): unknown;
  };
  // pdfkit finalises the catalog's ViewerPreferences itself on end(), so it must be a ref.
  d._root.data.ViewerPreferences = d.ref({ PrintScaling: 'None' });
}

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

/**
 * Standard-font mapping for live text in admin SVG artwork. Never a file path or a registered
 * name derived from the artwork, so `font-family` can't make pdfkit read files.
 */
function standardFont(family: string | undefined, bold: boolean, italic: boolean): string {
  const f = (family ?? '').toLowerCase();
  const base = /times|serif(?!.*sans)|georgia|garamond/.test(f)
    ? ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic']
    : /courier|mono/.test(f)
      ? ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique']
      : ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'];
  return base[(bold ? 1 : 0) + (italic ? 2 : 0)]!;
}

type PdfInternals = PDFKit.PDFDocument & {
  page: { xobjects: Record<string, unknown>; margins: unknown } & object;
  _ctm: number[];
  ref(data: Record<string, unknown>): { end(): void };
  addContent(data: string): void;
  openImage(src: Buffer): unknown;
};

/** Per-document artwork cache: each artwork is embedded ONCE per PDF and reused by every unit. */
const artworkCache = new WeakMap<PDFKit.PDFDocument, Map<string, { name: string; ref: unknown }>>();

/**
 * Renders sanitized SVG into a Form XObject (vector), in viewBox units. svg-to-pdfkit draws onto
 * `doc.page`, so a stand-in page whose content stream and resources are the form's is swapped in
 * for the duration of the call. Loaders are disabled: no images, fonts or documents can be
 * fetched, whatever the SVG says (it was sanitized already; this is defence in depth).
 */
function svgForm(doc: PdfInternals, a: ArtworkAsset): unknown {
  const vb = a.viewBox!;
  const resources = doc.ref({ ProcSet: ['PDF', 'Text', 'ImageB', 'ImageC', 'ImageI'] });
  const form = doc.ref({
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, vb.width, vb.height],
    Resources: resources,
  });
  const page = doc.page;
  const ctm = doc._ctm;
  const stand = Object.create(Object.getPrototypeOf(page) as object) as Record<string, unknown>;
  Object.assign(stand, {
    document: doc,
    content: form,
    resources,
    width: vb.width,
    height: vb.height,
    margins: page.margins,
    dictionary: { data: {} },
    markings: [],
  });
  const warnings: string[] = [];
  (doc as unknown as { page: unknown }).page = stand;
  doc._ctm = [1, 0, 0, 1, 0, 0];
  try {
    doc.save();
    doc.transform(1, 0, 0, -1, 0, vb.height);
    SVGtoPDF(doc, a.svg!, 0, 0, {
      width: vb.width,
      height: vb.height,
      preserveAspectRatio: 'xMidYMid meet',
      fontCallback: standardFont,
      imageCallback: () => {
        throw new Error('images are not allowed in SVG artwork');
      },
      documentCallback: () => {
        throw new Error('external documents are not allowed in SVG artwork');
      },
      warningCallback: (w: string) => warnings.push(w),
    });
    doc.restore();
  } finally {
    (doc as unknown as { page: unknown }).page = page;
    doc._ctm = ctm;
  }
  resources.end();
  form.end();
  if (warnings.length) lastSvgWarnings.set(a.key, warnings);
  return form;
}

/** Renderer warnings per artwork (validation surfaces them). */
export const lastSvgWarnings = new Map<string, string[]>();

function drawArtwork(
  doc: PDFKit.PDFDocument,
  el: Extract<DrawElement, { kind: 'artwork' }>,
  ox: number,
  oy: number,
): void {
  const d = doc as PdfInternals;
  let cache = artworkCache.get(doc);
  if (!cache) artworkCache.set(doc, (cache = new Map()));
  let entry = cache.get(el.artwork.key);
  if (!entry) {
    const ref = el.artwork.format === 'SVG' ? svgForm(d, el.artwork) : d.openImage(el.artwork.png!);
    entry = { name: `Art${cache.size + 1}`, ref };
    cache.set(el.artwork.key, entry);
  }
  doc.save();
  doc.rect(ox + el.clip.x, oy + el.clip.y, el.clip.w, el.clip.h).clip();
  // Box origin; a bleed mirror flips inside its own box (magnitude stays 1: no stretching).
  doc.transform(
    el.flipX ? -1 : 1,
    0,
    0,
    el.flipY ? -1 : 1,
    ox + el.x + (el.flipX ? el.w : 0),
    oy + el.y + (el.flipY ? el.h : 0),
  );
  if (el.artwork.format === 'SVG') {
    // Uniform scale: one factor for both axes (h = vbH × s by construction).
    const s = el.w / el.artwork.viewBox!.width;
    d.page.xobjects[entry.name] = entry.ref;
    doc.transform(s, 0, 0, -s, 0, el.artwork.viewBox!.height * s);
    d.addContent(`/${entry.name} Do`);
  } else {
    // Lossless: the PNG's own data, drawn at exactly the placed box (its aspect ratio).
    doc.image(entry.ref as Buffer, 0, 0, { width: el.w, height: el.h });
  }
  doc.restore();
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
      case 'artwork':
        drawArtwork(doc, el, ox, oy);
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
  private readonly marks: DrawElement[];

  constructor(private readonly opts: SheetPdfOptions) {
    this.doc = new PDFDocument({
      autoFirstPage: false,
      compress: opts.compress ?? true,
      margin: 0,
      info: { Title: opts.title, Creator: 'OZZO Safety ID print engine', Producer: 'pdfkit' },
    });
    registerFonts(this.doc, opts.fonts);
    printAtActualSize(this.doc);
    this.marks = sheetMarks(opts.layout, createTextMetrics(opts.fonts));
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
    drawElements(this.doc, this.marks, 0, 0);
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
  printAtActualSize(doc);
  const { width, height } = sheetSizePt(layout);
  doc.addPage({ size: [width, height], margin: 0 });
  // The same registration squares as the print sheet, so cut file and print align.
  for (const b of registrationMarks(layout)) doc.rect(b.x, b.y, b.w, b.h).fill('#000000');
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
