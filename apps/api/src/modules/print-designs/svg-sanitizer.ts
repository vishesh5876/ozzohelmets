import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * Strict whitelist sanitizer for uploaded print artwork (untrusted input).
 *
 * - Parsed as XML (never as HTML, never by a browser). DOCTYPE / ENTITY declarations are refused
 *   before parsing, so entity expansion (billion laughs) and XXE are impossible; only the five
 *   predefined XML entities and character references exist.
 * - Only whitelisted elements and attributes survive. Anything active or remote — script,
 *   foreignObject, iframe, image, use, style sheets, event handlers, javascript:/data:/http URLs,
 *   CSS @import, external url() — is REJECTED with a clear message rather than silently dropped,
 *   so the printed result never differs from what the designer exported.
 * - Inert editor metadata (metadata, title, desc, Inkscape/Sodipodi namespaces) is removed.
 * - Every id is prefixed (and local `#id` / `url(#id)` references rewritten) so two artworks on
 *   one sheet or preview can never collide.
 *
 * The output is a fresh serialisation of the whitelisted tree: nothing from the input reaches it
 * unexamined. The renderer (svg-to-pdfkit) is additionally given no image/font/document loaders.
 */

export class ArtworkError extends Error {}

export interface SvgLimits {
  maxBytes: number;
  maxElements: number;
  maxDepth?: number;
}

export interface SanitizedSvg {
  svg: string;
  viewBox: { x: number; y: number; width: number; height: number };
  viewBoxText: string;
  elementCount: number;
  warnings: string[];
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const PRESENTATION = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'clip-path',
  'clip-rule',
  'color',
  'display',
  'visibility',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'letter-spacing',
  'word-spacing',
  'dominant-baseline',
  'stop-color',
  'stop-opacity',
];
const COMMON = ['id', 'transform', 'style', ...PRESENTATION];

/** element → element-specific attributes (COMMON applies to all). */
const ELEMENTS: Record<string, string[]> = {
  svg: ['viewBox', 'version', 'xmlns', 'xmlns:xlink', 'xml:space'],
  g: [],
  defs: [],
  path: ['d', 'pathLength'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  text: ['x', 'y', 'dx', 'dy', 'xml:space'],
  tspan: ['x', 'y', 'dx', 'dy'],
  clipPath: ['clipPathUnits'],
  linearGradient: [
    'x1',
    'y1',
    'x2',
    'y2',
    'gradientUnits',
    'gradientTransform',
    'spreadMethod',
    'href',
    'xlink:href',
  ],
  radialGradient: [
    'cx',
    'cy',
    'r',
    'fx',
    'fy',
    'gradientUnits',
    'gradientTransform',
    'spreadMethod',
    'href',
    'xlink:href',
  ],
  stop: ['offset'],
};

/** Removed with their content: inert editor/document metadata. */
const DROP_ELEMENTS = new Set(['metadata', 'title', 'desc', 'sodipodi:namedview']);

/** Explicit, clearer messages for the dangerous or unsupported ones. */
const REJECT_REASON: Record<string, string> = {
  script: 'scripts are not allowed',
  foreignObject: 'foreignObject (embedded HTML) is not allowed',
  iframe: 'iframes are not allowed',
  image: 'embedded or linked images are not allowed in SVG artwork (upload a PNG instead)',
  use: '<use> references are not supported — expand symbols/clones before exporting',
  style:
    '<style> sheets are not supported — export with presentation attributes (Illustrator: Styling → Presentation Attributes)',
  a: 'links are not allowed',
  filter: 'filters are not supported in print output',
  mask: 'masks are not supported in print output',
  pattern: 'patterns are not supported in print output',
  marker: 'markers are not supported in print output',
  symbol: 'symbols are not supported — expand them before exporting',
  animate: 'animation is not allowed',
  animateTransform: 'animation is not allowed',
  animateMotion: 'animation is not allowed',
  set: 'animation is not allowed',
  textPath: 'text on a path is not supported — convert text to outlines',
};

/** Namespaced attributes from editors that are inert and simply removed. */
const DROP_ATTR_PREFIXES = ['inkscape:', 'sodipodi:', 'sketch:', 'serif:', 'data-'];

const LOCAL_URL = /^url\(\s*['"]?#([A-Za-z_][\w.-]*)['"]?\s*\)$/;

export function sanitizeSvg(input: Buffer, limits: SvgLimits, idPrefix: string): SanitizedSvg {
  if (input.length > limits.maxBytes)
    throw new ArtworkError(`SVG is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new ArtworkError('SVG must be UTF-8 text.');
  }
  text = text.replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new ArtworkError('DOCTYPE/ENTITY declarations are not allowed (XML entity attack).');
  if (/<!\[CDATA\[/.test(text)) throw new ArtworkError('CDATA sections are not allowed.');
  const pis = text.match(/<\?[\s\S]*?\?>/g) ?? [];
  if (pis.some((pi, i) => i > 0 || !/^<\?xml\s/.test(pi) || !text.trimStart().startsWith(pi)))
    throw new ArtworkError('Processing instructions (e.g. external stylesheets) are not allowed.');
  const valid = XMLValidator.validate(text, { allowBooleanAttributes: false });
  if (valid !== true) throw new ArtworkError(`SVG is not well-formed XML: ${valid.err.msg}`);

  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: true,
    htmlEntities: false,
    commentPropName: '#comment',
    ignoreDeclaration: true,
  });
  const tree = parser.parse(text) as XmlNode[];
  const roots = tree.filter((n) => {
    const name = elementName(n);
    if (name === '#text') {
      if (String(n['#text'] ?? '').trim())
        throw new ArtworkError('Text outside the <svg> element.');
      return false;
    }
    return name !== null && name !== '#comment';
  });
  if (roots.length !== 1 || elementName(roots[0]!) !== 'svg')
    throw new ArtworkError('The file must contain exactly one <svg> root element.');

  const ctx: Ctx = {
    prefix: idPrefix,
    count: 0,
    limits: { maxDepth: 64, ...limits },
    warnings: new Set(),
  };
  const root = roots[0]!;
  const rootAttrs = attrsOf(root);
  if (rootAttrs.xmlns !== undefined && rootAttrs.xmlns !== SVG_NS)
    throw new ArtworkError('The root element must use the SVG namespace.');
  const vbText = rootAttrs.viewBox?.trim();
  const vb = vbText?.split(/[\s,]+/).map(Number);
  if (!vb || vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2]! <= 0 || vb[3]! <= 0)
    throw new ArtworkError(
      'The SVG needs a numeric viewBox (e.g. viewBox="0 0 450 100"); width/height alone are not enough.',
    );
  const body = children(root)
    .map((c) => serialize(c, ctx, 1))
    .join('');
  const viewBoxText = vb.join(' ');
  return {
    svg: `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" viewBox="${viewBoxText}">${body}</svg>`,
    viewBox: { x: vb[0]!, y: vb[1]!, width: vb[2]!, height: vb[3]! },
    viewBoxText,
    elementCount: ctx.count,
    warnings: [...ctx.warnings],
  };
}

type XmlNode = Record<string, unknown>;
interface Ctx {
  prefix: string;
  count: number;
  limits: Required<SvgLimits>;
  warnings: Set<string>;
}

function elementName(n: XmlNode): string | null {
  return Object.keys(n).find((k) => k !== ':@') ?? null;
}
function attrsOf(n: XmlNode): Record<string, string> {
  return (n[':@'] as Record<string, string> | undefined) ?? {};
}
function children(n: XmlNode): XmlNode[] {
  const name = elementName(n);
  return name ? ((n[name] as XmlNode[] | undefined) ?? []) : [];
}

const escapeText = (v: string) =>
  v.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const escapeAttr = (v: string) =>
  v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function serialize(n: XmlNode, ctx: Ctx, depth: number): string {
  const name = elementName(n);
  if (!name || name === '#comment') return '';
  if (name === '#text') {
    return '';
  }
  if (depth > ctx.limits.maxDepth) throw new ArtworkError('SVG nesting is too deep.');
  if (DROP_ELEMENTS.has(name)) return '';
  if (REJECT_REASON[name])
    throw new ArtworkError(`Unsupported SVG content: ${REJECT_REASON[name]}.`);
  const allowed = ELEMENTS[name];
  if (!allowed || name === 'svg')
    throw new ArtworkError(
      name === 'svg'
        ? 'Nested <svg> elements are not supported — flatten the artwork before exporting.'
        : `Unsupported SVG element <${name}>.`,
    );
  if (++ctx.count > ctx.limits.maxElements)
    throw new ArtworkError(`SVG has more than ${ctx.limits.maxElements} elements.`);
  if (name === 'text' || name === 'tspan')
    ctx.warnings.add(
      'Contains live text: it prints with standard PDF fonts (Helvetica/Times/Courier). Convert text to outlines for exact typography.',
    );

  let attrs = '';
  for (const [rawKey, rawValue] of Object.entries(attrsOf(n))) {
    const key = rawKey;
    const value = String(rawValue);
    if (/^on/i.test(key))
      throw new ArtworkError(`Event handler attribute "${key}" is not allowed.`);
    if (DROP_ATTR_PREFIXES.some((p) => key.startsWith(p)) || /^xmlns:/.test(key)) continue;
    if (!COMMON.includes(key) && !allowed.includes(key))
      throw new ArtworkError(`Unsupported attribute "${key}" on <${name}>.`);
    attrs += ` ${key}="${escapeAttr(sanitizeValue(key, value, name, ctx))}"`;
  }

  let inner = '';
  for (const c of children(n)) {
    const cname = elementName(c);
    if (cname === '#text') {
      const t = String(c['#text'] ?? '');
      if ((name === 'text' || name === 'tspan') && t.length) inner += escapeText(t);
      continue;
    }
    inner += serialize(c, ctx, depth + 1);
  }
  return `<${name}${attrs}>${inner}</${name}>`;
}

function assertSafeValue(key: string, value: string): void {
  const v = value.toLowerCase().replace(/\s+/g, '');
  if (/javascript:|vbscript:|data:|https?:|ftp:|file:|\/\/|@import|expression\(|\\/.test(v))
    throw new ArtworkError(`External or script reference in "${key}" is not allowed.`);
}

function rewriteUrls(value: string, key: string, ctx: Ctx): string {
  return value.replace(/url\([^)]*\)/gi, (m) => {
    const local = LOCAL_URL.exec(m.trim());
    if (!local) throw new ArtworkError(`Only local url(#id) references are allowed in "${key}".`);
    return `url(#${ctx.prefix}${local[1]})`;
  });
}

function sanitizeValue(key: string, value: string, element: string, ctx: Ctx): string {
  if (value.length > 2_000_000) throw new ArtworkError(`Attribute "${key}" is too long.`);
  if (key === 'id') {
    if (!/^[A-Za-z_][\w.-]*$/.test(value))
      throw new ArtworkError(`Invalid id "${value.slice(0, 40)}".`);
    return `${ctx.prefix}${value}`;
  }
  if (key === 'href' || key === 'xlink:href') {
    // Gradients may inherit stops from another LOCAL gradient only.
    if (!/^#[A-Za-z_][\w.-]*$/.test(value))
      throw new ArtworkError(`Only local "#id" references are allowed (<${element}> ${key}).`);
    return `#${ctx.prefix}${value.slice(1)}`;
  }
  if (key === 'style') return sanitizeStyle(value, ctx);
  assertSafeValue(key, value.replace(/url\(\s*['"]?#[\w.-]+['"]?\s*\)/gi, ''));
  return rewriteUrls(value, key, ctx);
}

/** Inline style: whitelisted presentation properties only; local url(#id) only. */
function sanitizeStyle(style: string, ctx: Ctx): string {
  const out: string[] = [];
  for (const decl of style.split(';')) {
    if (!decl.trim()) continue;
    const idx = decl.indexOf(':');
    if (idx < 0) throw new ArtworkError('Malformed style attribute.');
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (DROP_ATTR_PREFIXES.some((p) => prop.startsWith(p)) || prop.startsWith('-')) continue;
    if (!PRESENTATION.includes(prop))
      throw new ArtworkError(`Unsupported style property "${prop}".`);
    assertSafeValue(prop, val.replace(/url\(\s*['"]?#[\w.-]+['"]?\s*\)/gi, ''));
    out.push(`${prop}:${rewriteUrls(val, prop, ctx)}`);
  }
  return out.join(';');
}
