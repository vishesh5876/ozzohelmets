/**
 * Print Studio: a print design built in the admin from layers (text, shapes, images, a
 * background) instead of one uploaded artwork file. The document is plain data; the print engine
 * turns it into the same display list as every other design, so the PDF stays vector (text and
 * shapes) and images are embedded losslessly. The Safety ID, PIN, QR (+ quiet zone) and the cover
 * die stay system-controlled: the studio shows them as locked layers at their true positions.
 *
 * Coordinates are PDF points (1/72 in) in the 4.5 × 1 in unit, y downwards: 324 × 72.
 * Pure and browser-safe (shared by API validation and the admin editor).
 */

export const STUDIO_DOCUMENT_VERSION = 1;
export const STUDIO_UNIT_W = 324;
export const STUDIO_UNIT_H = 72;
/** Left edge of the cover zone (2.2 + 1.15 in): the base sticker | cover kiss cut. */
export const STUDIO_COVER_ZONE_X = 241.2;

export const STUDIO_LIMITS = {
  layers: 200,
  textChars: 500,
  fontPt: { min: 3, max: 72 },
  /** Layer boxes may run past the unit edges (clipped there), within this margin. */
  coordinate: { min: -200, max: 524 },
  size: { min: 0.2, max: 700 },
  strokePt: { min: 0, max: 20 },
  radiusPt: { min: 0, max: 100 },
  letterSpacingPt: { min: -2, max: 20 },
  lineHeight: { min: 0.7, max: 3 },
} as const;

/** Text below this size is hard to read on a helmet; the studio warns. */
export const STUDIO_MIN_READABLE_PT = 4;

/**
 * Which physical piece a layer prints on: the base sticker (left of the kiss cut), the
 * removable cover, or both (e.g. a background spanning the whole unit, clipped per piece).
 */
export type StudioPart = 'sticker' | 'cover' | 'both';
export type StudioTextAlign = 'left' | 'center' | 'right';
export type StudioImageFit = 'contain' | 'cover';

interface StudioLayerBase {
  id: string;
  name: string;
  part: StudioPart;
  /** Box in unit points (top-left, width, height). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees clockwise around the box centre. */
  rotate: number;
  /** Hidden layers are kept in the document but never printed. */
  hidden: boolean;
  /** Locked layers can't be moved in the editor (no effect on print). */
  locked: boolean;
}

export interface StudioTextLayer extends StudioLayerBase {
  kind: 'text';
  /** Lines separated by \n; no wrapping (what you type is what prints). */
  text: string;
  sizePt: number;
  bold: boolean;
  color: string;
  align: StudioTextAlign;
  letterSpacingPt: number;
  /** Line pitch as a multiple of the font size. */
  lineHeight: number;
}

export interface StudioShapeLayer extends StudioLayerBase {
  kind: 'rect' | 'ellipse';
  fill: string | null;
  stroke: string | null;
  strokePt: number;
  /** Rect corner radius. */
  radiusPt: number;
}

/** Arrow pointing right inside its box (rotate it for other directions). */
export interface StudioArrowLayer extends StudioLayerBase {
  kind: 'arrow';
  color: string;
  /** Shaft thickness. */
  strokePt: number;
}

export interface StudioImageLayer extends StudioLayerBase {
  kind: 'image';
  /** An uploaded print artwork file (PNG or sanitized SVG), verified by SHA-256 at print. */
  fileId: string;
  /** contain: whole image inside the box; cover: fills the box, edges cropped. Never stretched. */
  fit: StudioImageFit;
}

export type StudioLayer = StudioTextLayer | StudioShapeLayer | StudioArrowLayer | StudioImageLayer;
export type StudioLayerKind = StudioLayer['kind'];

export interface StudioDocument {
  version: typeof STUDIO_DOCUMENT_VERSION;
  /** Base sticker background (runs into the bleed); null = white. */
  stickerBackground: string | null;
  /** Cover background; null = white. Ignored when the default cover is used. */
  coverBackground: string | null;
  /** Use the system's yellow REMOVE / ONLY IN EMERGENCY / ▲ OPEN cover (cover layers ignored). */
  defaultCover: boolean;
  /** Bottom first. */
  layers: StudioLayer[];
}

export const EMPTY_STUDIO_DOCUMENT: StudioDocument = {
  version: STUDIO_DOCUMENT_VERSION,
  stickerBackground: '#FFFFFF',
  coverBackground: '#FFD100',
  defaultCover: true,
  layers: [],
};

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAYER_ID = /^[A-Za-z0-9_-]{1,40}$/;
const KINDS: readonly StudioLayerKind[] = ['text', 'rect', 'ellipse', 'arrow', 'image'];
const PARTS: readonly StudioPart[] = ['sticker', 'cover', 'both'];

export class StudioDocumentError extends Error {}

/**
 * Strict parse of an untrusted studio document: only known fields survive, every number is
 * range-checked, colours are #RRGGBB, ids are safe. Throws StudioDocumentError with a message an
 * admin can act on. The result is a fresh object (never the input).
 */
export function parseStudioDocument(input: unknown): StudioDocument {
  const fail = (msg: string): never => {
    throw new StudioDocumentError(msg);
  };
  const obj = (v: unknown, what: string): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : fail(`${what} must be an object.`);
  const num = (v: unknown, what: string, r: { min: number; max: number }): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max
      ? Math.round(v * 1000) / 1000
      : fail(`${what} must be a number from ${r.min} to ${r.max}.`);
  const bool = (v: unknown, what: string): boolean =>
    typeof v === 'boolean' ? v : fail(`${what} must be true or false.`);
  const color = (v: unknown, what: string): string =>
    typeof v === 'string' && COLOR.test(v) ? v.toUpperCase() : fail(`${what} must be #RRGGBB.`);
  const colorOrNull = (v: unknown, what: string): string | null =>
    v === null || v === undefined ? null : color(v, what);
  const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T =>
    list.includes(v as T) ? (v as T) : fail(`${what} must be one of ${list.join(', ')}.`);

  const d = obj(input, 'The studio document');
  if (d.version !== STUDIO_DOCUMENT_VERSION) fail('Unsupported studio document version.');
  if (!Array.isArray(d.layers)) fail('Layers must be a list.');
  const raw = d.layers as unknown[];
  if (raw.length > STUDIO_LIMITS.layers) fail(`At most ${STUDIO_LIMITS.layers} layers.`);
  const L = STUDIO_LIMITS;
  const seen = new Set<string>();
  const layers = raw.map((item, i): StudioLayer => {
    const l = obj(item, `Layer ${i + 1}`);
    const what = `Layer ${i + 1}`;
    const id = typeof l.id === 'string' && LAYER_ID.test(l.id) ? l.id : fail(`${what}: bad id.`);
    if (seen.has(id)) fail(`${what}: duplicate id.`);
    seen.add(id);
    const kind = oneOf(l.kind, KINDS, `${what} kind`);
    const name = typeof l.name === 'string' ? l.name.slice(0, 60) : kind;
    const base = {
      id,
      name,
      part: oneOf(l.part, PARTS, `${what} part`),
      x: num(l.x, `${what} x`, L.coordinate),
      y: num(l.y, `${what} y`, L.coordinate),
      w: num(l.w, `${what} width`, L.size),
      h: num(l.h, `${what} height`, L.size),
      rotate: num(l.rotate ?? 0, `${what} rotation`, { min: -360, max: 360 }),
      hidden: bool(l.hidden ?? false, `${what} hidden`),
      locked: bool(l.locked ?? false, `${what} locked`),
    };
    switch (kind) {
      case 'text': {
        if (typeof l.text !== 'string') fail(`${what}: text is required.`);
        const text = (l.text as string).replace(/\r\n?/g, '\n');
        if (text.length > L.textChars) fail(`${what}: at most ${L.textChars} characters.`);
        // eslint-disable-next-line no-control-regex -- control characters never print
        if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text))
          fail(`${what}: text contains control characters.`);
        return {
          ...base,
          kind,
          text,
          sizePt: num(l.sizePt, `${what} font size`, L.fontPt),
          bold: bool(l.bold ?? false, `${what} bold`),
          color: color(l.color, `${what} colour`),
          align: oneOf(l.align ?? 'left', ['left', 'center', 'right'] as const, `${what} align`),
          letterSpacingPt: num(l.letterSpacingPt ?? 0, `${what} letter spacing`, L.letterSpacingPt),
          lineHeight: num(l.lineHeight ?? 1.2, `${what} line height`, L.lineHeight),
        };
      }
      case 'rect':
      case 'ellipse': {
        const fill = colorOrNull(l.fill, `${what} fill`);
        const stroke = colorOrNull(l.stroke, `${what} border`);
        const strokePt = num(l.strokePt ?? 0, `${what} border width`, L.strokePt);
        if (!fill && !(stroke && strokePt > 0)) fail(`${what}: needs a fill or a border.`);
        return {
          ...base,
          kind,
          fill,
          stroke,
          strokePt,
          radiusPt: num(l.radiusPt ?? 0, `${what} corner radius`, L.radiusPt),
        };
      }
      case 'arrow':
        return {
          ...base,
          kind,
          color: color(l.color, `${what} colour`),
          strokePt: num(l.strokePt ?? 1.6, `${what} thickness`, { min: 0.2, max: 20 }),
        };
      case 'image':
        return {
          ...base,
          kind,
          fileId:
            typeof l.fileId === 'string' && UUID.test(l.fileId)
              ? l.fileId.toLowerCase()
              : fail(`${what}: choose an image.`),
          fit: oneOf(l.fit ?? 'contain', ['contain', 'cover'] as const, `${what} fit`),
        };
    }
  });
  return {
    version: STUDIO_DOCUMENT_VERSION,
    stickerBackground: colorOrNull(d.stickerBackground, 'Sticker background'),
    coverBackground: colorOrNull(d.coverBackground, 'Cover background'),
    defaultCover: bool(d.defaultCover ?? true, 'Default cover'),
    layers,
  };
}

/** Image files a document references (deduplicated, in first-use order). */
export function studioImageIds(doc: StudioDocument): string[] {
  return [
    ...new Set(
      doc.layers.filter((l): l is StudioImageLayer => l.kind === 'image').map((l) => l.fileId),
    ),
  ];
}

/** Box of the image drawn in its layer: uniform scale, centred ("meet" or "slice"). */
export function studioImageBox(
  layer: Pick<StudioImageLayer, 'x' | 'y' | 'w' | 'h' | 'fit'>,
  aspect: number,
): { x: number; y: number; w: number; h: number } {
  const w =
    layer.fit === 'cover'
      ? Math.max(layer.w, layer.h * aspect)
      : Math.min(layer.w, layer.h * aspect);
  const h = w / aspect;
  return { x: layer.x + (layer.w - w) / 2, y: layer.y + (layer.h - h) / 2, w, h };
}

/**
 * Locked system areas the studio shows over the canvas (unit points). Served by the API from the
 * print engine's own geometry, so the editor never guesses where the QR goes.
 */
export interface StudioGeometryDto {
  unit: { w: number; h: number };
  /** Base sticker | cover kiss cut (x). */
  coverZoneX: number;
  /** White keep-clear boxes printed over the design (QR + PIN target, Safety ID text). */
  keepClear: { x: number; y: number; w: number; h: number; radius: number }[];
  qr: { x: number; y: number; w: number; h: number };
  pin: { x: number; baselineY: number; sizePt: number };
  id: { baselineX: number; centerY: number; sizePt: number };
  /** Where the cover lands on the sticker (hidden marks). */
  coverFootprint: { x: number; y: number; w: number; h: number };
  /** Cover cut line and the printable cover box (die + kiss-cut bleed). */
  coverDie: { x: number; y: number; w: number; h: number };
  coverPrint: { x: number; y: number; w: number; h: number };
  safeInset: number;
  sample: { safetyCode: string; pin: string };
}
