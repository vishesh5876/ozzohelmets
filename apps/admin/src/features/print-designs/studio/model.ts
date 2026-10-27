import {
  EMPTY_STUDIO_DOCUMENT,
  STUDIO_COVER_ZONE_X,
  type StudioDocument,
  type StudioGeometryDto,
  type StudioLayer,
  type StudioLayerKind,
  type StudioPart,
} from '@helmet/types';

/** Print Studio editor helpers: layer factories, the starter template, geometry utilities. */

export const PT_PER_MM = 72 / 25.4;
export const toMm = (pt: number) => Math.round((pt / PT_PER_MM) * 100) / 100;
export const toPt = (mm: number) => mm * PT_PER_MM;

/** Cap height per 1 pt of Helvetica (Regular and Bold are both 718/1000). */
export const CAP_HEIGHT = 0.718;

let seq = 0;
export const newId = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The piece a layer at this box prints on (by its centre). */
export function partAt(x: number, w: number): Exclude<StudioPart, 'both'> {
  return x + w / 2 >= STUDIO_COVER_ZONE_X ? 'cover' : 'sticker';
}

const base = (kind: StudioLayerKind, name: string, x: number, y: number, w: number, h: number) => ({
  id: newId(),
  name,
  part: partAt(x, w),
  x,
  y,
  w,
  h,
  rotate: 0,
  hidden: false,
  locked: false,
});

export function textLayer(
  text: string,
  x: number,
  y: number,
  w: number,
  opts: Partial<Extract<StudioLayer, { kind: 'text' }>> = {},
): StudioLayer {
  const sizePt = opts.sizePt ?? 8;
  const lineHeight = opts.lineHeight ?? 1.2;
  const lines = text.split('\n').length;
  return {
    ...base('text', opts.name ?? text.split('\n')[0]!.slice(0, 30), x, y, w, 0),
    kind: 'text',
    text,
    sizePt,
    bold: true,
    color: '#000000',
    align: 'left',
    letterSpacingPt: 0,
    lineHeight,
    h: textHeight(sizePt, lineHeight, lines),
    ...opts,
  } as StudioLayer;
}

/** Height of a text block: cap height of the first line + the line pitch of the others. */
export function textHeight(sizePt: number, lineHeight: number, lines: number) {
  return Math.round((sizePt * CAP_HEIGHT + (lines - 1) * sizePt * lineHeight) * 100) / 100 + 0.01;
}

export function shapeLayer(
  kind: 'rect' | 'ellipse',
  x: number,
  y: number,
  w: number,
  h: number,
  opts: Partial<Extract<StudioLayer, { kind: 'rect' | 'ellipse' }>> = {},
): StudioLayer {
  return {
    ...base(kind, kind === 'rect' ? 'Rectangle' : 'Ellipse', x, y, w, h),
    kind,
    fill: '#EC1C22',
    stroke: null,
    strokePt: 0,
    radiusPt: 0,
    ...opts,
  } as StudioLayer;
}

export function arrowLayer(x: number, y: number, w: number, h: number, color = '#EC1C22') {
  return {
    ...base('arrow', 'Arrow', x, y, w, h),
    kind: 'arrow',
    color,
    strokePt: 1.6,
  } as StudioLayer;
}

export function imageLayer(
  fileId: string,
  name: string,
  aspect: number,
  box?: Partial<StudioLayer>,
) {
  const h = box?.h ?? 24;
  const w = box?.w ?? h * aspect;
  const x = box?.x ?? 10;
  const y = box?.y ?? (72 - h) / 2;
  return {
    ...base('image', name, x, y, w, h),
    kind: 'image',
    fileId,
    fit: 'contain',
    ...box,
  } as StudioLayer;
}

/** Clamps a layer box to the editor's allowed range (mirrors the server limits). */
export function clampBox<T extends StudioLayer>(l: T): T {
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    ...l,
    x: r(c(l.x, -200, 524)),
    y: r(c(l.y, -200, 524)),
    w: r(c(l.w, 0.2, 700)),
    h: r(c(l.h, 0.2, 700)),
  };
}

/**
 * Starter design in the OZZO style: red panel with a black rim, logo box, emergency headline,
 * SCAN TO VIEW bar, white frames around the system's ID and QR areas, and a yellow security
 * cover. Frames come from the engine geometry so they sit exactly around the locked areas.
 */
export function ozzoTemplate(g: StudioGeometryDto): StudioDocument {
  const [qrClear, idClear] = g.keepClear;
  const white = '#FFFFFF';
  const red = '#EC1C22';
  const ink = '#121212';
  const yellow = '#FFE300';
  const c = g.coverPrint;
  const die = g.coverDie;
  const T = (text: string, x: number, y: number, w: number, o = {}) =>
    textLayer(text, x, y, w, { color: white, ...o });
  const layers: StudioLayer[] = [
    shapeLayer('rect', 1.9, 1.9, g.coverZoneX - 3.8, 72 - 3.8, {
      name: 'Red panel',
      fill: red,
      radiusPt: 3,
    }),
    shapeLayer('rect', 6, 6, 70, 20, { name: 'Logo box', fill: white, radiusPt: 2.5 }),
    T('YOUR LOGO', 6, 13, 70, {
      name: 'Logo placeholder (replace)',
      color: ink,
      sizePt: 7,
      align: 'center',
    }),
    T('RIDER EMERGENCY', 81, 8, 76, { sizePt: 6.9 }),
    T('MEDICAL QR SYSTEM', 81, 17.5, 76, { sizePt: 5.6, bold: false }),
    shapeLayer('rect', 6, 30, 148, 0.5, { name: 'Divider', fill: white }),
    T('IN AN EMERGENCY', 6, 34, 150, { sizePt: 12.4 }),
    T('MY HEALTH INFORMATION IS HERE', 6, 47.4, 150, { sizePt: 5.9 }),
    shapeLayer('rect', 6, 55.5, 148, 10.5, { name: 'Scan bar', fill: white, radiusPt: 3 }),
    T('SCAN TO VIEW', 11, 58, 100, { color: red, sizePt: 7.6 }),
    arrowLayer(134, 57.2, 14, 7, red),
  ];
  if (idClear)
    layers.push(
      shapeLayer('rect', idClear.x - 1, 5, idClear.w + 2, 62, {
        name: 'ID strip',
        fill: white,
        radiusPt: (idClear.w + 2) / 2,
      }),
    );
  if (qrClear)
    layers.push(
      shapeLayer('rect', qrClear.x - 1.5, qrClear.y - 1.5, qrClear.w + 3, qrClear.h + 3, {
        name: 'QR frame',
        fill: white,
        stroke: ink,
        strokePt: 1,
        radiusPt: 3,
      }),
    );
  // Cover (the removable piece): drawn inside the die line, with the black tab at the bottom.
  const cx = die.x + 2;
  const cw = die.w - 4;
  const cover = (l: StudioLayer): StudioLayer => ({ ...l, part: 'cover' });
  layers.push(
    cover(
      shapeLayer('rect', cx, die.y + 3, cw, 9, {
        name: 'Cover title bar',
        fill: ink,
        radiusPt: 2.5,
      }),
    ),
    cover(T('SECURITY COVER', cx, die.y + 5.6, cw, { sizePt: 5.4, align: 'center' })),
    cover(
      shapeLayer('ellipse', cx + cw / 2 - 5, die.y + 15, 10, 12, {
        name: 'Lock shackle',
        fill: null,
        stroke: ink,
        strokePt: 2,
      }),
    ),
    cover(
      shapeLayer('rect', cx + cw / 2 - 7.5, die.y + 21.5, 15, 12, {
        name: 'Lock body',
        fill: ink,
        radiusPt: 1.5,
      }),
    ),
    cover(
      shapeLayer('ellipse', cx + cw / 2 - 1.3, die.y + 25, 2.6, 2.6, {
        name: 'Keyhole',
        fill: yellow,
      }),
    ),
    cover(T('REMOVE', cx, die.y + 37, cw, { color: ink, sizePt: 11, align: 'center' })),
    cover(
      T('ONLY IN EMERGENCY', cx, die.y + 48.5, cw, { color: ink, sizePt: 5.2, align: 'center' }),
    ),
    cover(
      shapeLayer('rect', c.x, die.y + die.h - 12, c.w, 12 + (c.y + c.h - die.y - die.h), {
        name: 'Open tab',
        fill: ink,
      }),
    ),
    cover(arrowLayer(cx + 6, die.y + die.h - 9, 5, 6, yellow)),
    cover(
      T('OPEN HERE', cx + 10, die.y + die.h - 8.4, cw - 12, {
        color: yellow,
        sizePt: 6.4,
        align: 'center',
      }),
    ),
  );
  return {
    ...EMPTY_STUDIO_DOCUMENT,
    stickerBackground: ink,
    coverBackground: yellow,
    defaultCover: false,
    layers,
  };
}

/** Undo/redo history of documents (bounded). */
export class History {
  private past: StudioDocument[] = [];
  private future: StudioDocument[] = [];
  push(prev: StudioDocument) {
    this.past.push(prev);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }
  undo(current: StudioDocument): StudioDocument | null {
    const prev = this.past.pop();
    if (prev) this.future.push(current);
    return prev ?? null;
  }
  redo(current: StudioDocument): StudioDocument | null {
    const next = this.future.pop();
    if (next) this.past.push(current);
    return next ?? null;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}
