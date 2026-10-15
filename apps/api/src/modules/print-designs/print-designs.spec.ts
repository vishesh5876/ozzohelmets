import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { artworkQuality, aspectMatches, effectiveDpi, MIN_BASE_PNG } from '@helmet/types';
import {
  artworkAspect,
  coverTrim,
  drawnDpi,
  placeBaseArtwork,
  placeCoverArtwork,
} from '../print/artwork';
import { UNIT_H, UNIT_W } from '../print/sticker-design';
import { type ArtworkFacts, checkDesign } from './design-validation';
import { inspectPng, readPngHeader } from './png-inspector';
import { safeFilename, sha256 } from './print-designs.service';
import { ArtworkError, sanitizeSvg } from './svg-sanitizer';

const FIX = join(__dirname, '../../../test/fixtures/print');
const limits = { maxBytes: 5_000_000, maxElements: 50_000 };
const clean = (svg: string) => sanitizeSvg(Buffer.from(svg), limits, 'p-');
const wrap = (body: string, root = 'viewBox="0 0 450 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${root}>${body}</svg>`;
const rejects = (svg: string, msg: RegExp) => expect(() => clean(svg)).toThrow(msg);
const pngOf = (w: number, h: number, channels: 3 | 4 = 3) =>
  sharp({
    create: { width: w, height: h, channels, background: { r: 200, g: 20, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();
const pngLimits = { maxBytes: 15_000_000, maxPixels: 40_000_000 };

describe('SVG sanitizer (untrusted artwork)', () => {
  it('keeps normal vector content, prefixes ids and rewrites local references', () => {
    const out = clean(readFileSync(join(FIX, 'design-base.svg')).toString());
    expect(out.viewBox).toEqual({ x: 0, y: 0, width: 450, height: 100 });
    expect(out.svg).toContain('<linearGradient id="p-bg"');
    expect(out.svg).toContain('fill="url(#p-bg)"');
    expect(out.svg).toContain('clip-path="url(#p-band)"');
    expect(out.svg).not.toMatch(/<!--|<\?xml|width="4.5in"/);
  });

  it.each([
    ['<script>alert(1)</script>', /scripts are not allowed/],
    [
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
      /foreignObject/,
    ],
    ['<rect width="1" height="1" onload="alert(1)"/>', /Event handler/],
    ['<g onclick="x()"/>', /Event handler/],
    ['<image href="https://evil.example/x.png" width="10" height="10"/>', /images are not allowed/],
    ['<image href="file:///etc/passwd"/>', /images are not allowed/],
    ['<use href="https://evil.example/s.svg#a"/>', /<use>/],
    ['<style>@import url(https://evil.example/x.css);</style>', /<style>/],
    ['<style>@font-face{src:url(https://evil.example/f.woff)}</style>', /<style>/],
    ['<iframe src="https://evil.example"/>', /iframes/],
    ['<a href="javascript:alert(1)"><rect/></a>', /links are not allowed/],
    [
      '<rect fill="url(https://evil.example/p.svg#x)"/>',
      /External or script reference|Only local url/,
    ],
    ['<rect style="fill:url(http://evil.example/x)"/>', /External or script reference|Only local/],
    ['<rect style="behavior:url(x.htc)"/>', /Unsupported style property/],
    [
      '<rect style="background-image:url(data:image/png;base64,AAA)"/>',
      /Unsupported style property/,
    ],
    ['<linearGradient href="https://evil.example/g.svg#g"/>', /local "#id"/],
    ['<rect fill="javascript:alert(1)"/>', /External or script reference/],
    ['<animate attributeName="x"/>', /animation/],
    ['<filter id="f"/>', /filters are not supported/],
    ['<svg viewBox="0 0 1 1"/>', /Nested <svg>/],
    ['<blink/>', /Unsupported SVG element <blink>/],
    ['<rect foo="1"/>', /Unsupported attribute "foo"/],
  ])('rejects %s', (body, msg) => rejects(wrap(body), msg));

  it('rejects XML entity attacks and external DTDs before parsing', () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>' +
      wrap('<text>&lol2;</text>');
    rejects(bomb, /DOCTYPE\/ENTITY/);
    rejects(`<!DOCTYPE svg SYSTEM "http://evil.example/x.dtd">${wrap('')}`, /DOCTYPE/);
    rejects(
      `<?xml-stylesheet href="http://evil.example/x.css"?>${wrap('')}`,
      /Processing instructions/,
    );
    rejects(wrap('<text><![CDATA[x]]></text>'), /CDATA/);
  });

  it('requires a numeric viewBox, one svg root, UTF-8 and well-formed XML', () => {
    rejects('<svg xmlns="http://www.w3.org/2000/svg" width="450" height="100"/>', /viewBox/);
    rejects(wrap('', 'viewBox="0 0 0 100"'), /viewBox/);
    rejects('<html><svg viewBox="0 0 1 1"/></html>', /one <svg> root/);
    rejects(wrap('<rect>'), /well-formed/);
    expect(() => sanitizeSvg(Buffer.from([0xff, 0xfe, 0x3c]), limits, 'p-')).toThrow(/UTF-8/);
  });

  it('enforces size, element-count and depth limits', () => {
    expect(() => sanitizeSvg(Buffer.alloc(200, 32), { ...limits, maxBytes: 100 }, 'p-')).toThrow(
      /larger/,
    );
    const many = wrap('<rect/>'.repeat(60));
    expect(() => sanitizeSvg(Buffer.from(many), { ...limits, maxElements: 50 }, 'p-')).toThrow(
      /more than 50/,
    );
    const deep = wrap('<g>'.repeat(80) + '</g>'.repeat(80));
    rejects(deep, /too deep/);
  });

  it('removes inert editor metadata and namespaces, warns about live text', () => {
    const out = clean(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 450 100">` +
        `<metadata><x/></metadata><title>t</title><g inkscape:label="Layer 1" data-x="1"><text x="1" y="9" font-family="Helvetica">EMERGENCY</text></g></svg>`,
    );
    expect(out.svg).not.toMatch(/metadata|inkscape|data-x|<title/);
    expect(out.svg).toContain('>EMERGENCY</text>');
    expect(out.warnings.join()).toMatch(/standard PDF fonts/);
  });

  it('escapes text so nothing can break out of the serialised SVG', () => {
    const out = clean(wrap('<text>a &lt;script&gt; &amp; b</text>'));
    expect(out.svg).toContain('a &lt;script&gt; &amp; b');
    expect(out.svg).not.toContain('<script');
  });
});

describe('PNG inspection', () => {
  it('reads real dimensions server-side and accepts 8-bit RGB/RGBA', async () => {
    const info = await inspectPng(await pngOf(2700, 600, 4), pngLimits);
    expect(info).toMatchObject({ widthPx: 2700, heightPx: 600, bitDepth: 8, hasAlpha: true });
  });

  it('refuses a decompression bomb from the header alone (no decode)', () => {
    // Valid signature + IHDR declaring 30000 × 30000 px, no image data.
    const buf = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'latin1');
    buf.writeUInt32BE(30_000, 16);
    buf.writeUInt32BE(30_000, 20);
    buf[24] = 8;
    buf[25] = 6;
    expect(() => readPngHeader(buf, pngLimits)).toThrow(/too large when decoded/);
  });

  it('rejects malformed, truncated, oversized, 16-bit and non-PNG data', async () => {
    const good = await pngOf(1350, 300);
    await expect(inspectPng(good.subarray(0, good.length - 40), pngLimits)).rejects.toThrow(
      /could not be decoded/,
    );
    await expect(inspectPng(Buffer.from('GIF89a....'), pngLimits)).rejects.toThrow(/Not a PNG/);
    await expect(inspectPng(good, { ...pngLimits, maxBytes: 100 })).rejects.toThrow(/larger than/);
    const deep = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } })
      .png()
      .toColourspace('rgb16')
      .toBuffer();
    expect(() => readPngHeader(deep, pngLimits)).toThrow(/16-bit/);
  });
});

describe('aspect, DPI and quality rules', () => {
  it('4.5 : 1 within 1 %', () => {
    expect(aspectMatches(2700, 600, 4.5)).toBe(true);
    expect(aspectMatches(450, 100, 4.5)).toBe(true);
    expect(aspectMatches(2700, 610, 4.5)).toBe(false);
    expect(aspectMatches(2700, 0, 4.5)).toBe(false);
  });

  it('effective DPI and quality labels', () => {
    expect(effectiveDpi(2700, 4.5)).toBe(600);
    expect(effectiveDpi(MIN_BASE_PNG.widthPx, 4.5)).toBe(300);
    expect(effectiveDpi(990, 4.5)).toBe(220);
    expect(artworkQuality('SVG', null)).toBe('VECTOR');
    expect(artworkQuality('PNG', 600)).toBe('EXCELLENT');
    expect(artworkQuality('PNG', 300)).toBe('GOOD');
    expect(artworkQuality('PNG', 220)).toBe('TOO_LOW');
    const at100 = placeBaseArtwork(4.5, { scalePercent: 100, offsetXMm: 0, offsetYMm: 0 });
    expect(drawnDpi(2700, 600, at100)).toBe(600);
    // Enlarging lowers the effective resolution — never hidden.
    const at150 = placeBaseArtwork(4.5, { scalePercent: 150, offsetXMm: 0, offsetYMm: 0 });
    expect(drawnDpi(2700, 600, at150)).toBe(400);
  });
});

describe('uniform scaling only (no distortion)', () => {
  it.each([
    [4.5, 100, 0, 0],
    [4.5, 137, 3, -2],
    [4.47, 100, 0, 0],
    [4.53, 80, -5, 4],
    [1.2, 100, 0, 0],
    [0.4, 200, 10, 10],
  ])('aspect %d at %d%% keeps the artwork aspect exactly', (aspect, scale, x, y) => {
    const b = placeBaseArtwork(aspect, { scalePercent: scale, offsetXMm: x, offsetYMm: y });
    expect(b.w / b.h).toBeCloseTo(aspect, 10);
    const c = placeCoverArtwork(aspect, { x: 0, y: 0, w: 68.4, h: 72 });
    expect(c.w / c.h).toBeCloseTo(aspect, 10);
    expect(c.w).toBeGreaterThanOrEqual(68.4 - 1e-9);
    expect(c.h).toBeGreaterThanOrEqual(72 - 1e-9);
  });

  it('defaults (100 %, 0, 0) cover the 4.5 × 1 in unit exactly', () => {
    expect(placeBaseArtwork(4.5, { scalePercent: 100, offsetXMm: 0, offsetYMm: 0 })).toEqual({
      x: 0,
      y: 0,
      w: UNIT_W,
      h: UNIT_H,
    });
  });

  it('artwork aspect comes from the viewBox / pixel size, never from a target box', () => {
    expect(artworkAspect({ format: 'SVG', viewBox: { x: 0, y: 0, width: 450, height: 100 } })).toBe(
      4.5,
    );
    expect(artworkAspect({ format: 'PNG', widthPx: 2700, heightPx: 600 })).toBe(4.5);
    expect(coverTrim(1, { x: 0, y: 0, w: 50, h: 100 })).toBeCloseTo(0.5);
  });
});

describe('design validation', () => {
  const svg = (w = 450, h = 100): ArtworkFacts => ({
    format: 'SVG',
    widthPx: null,
    heightPx: null,
    viewBox: { width: w, height: h },
    testOnly: false,
    warnings: [],
  });
  const png = (w: number, h: number, testOnly = false): ArtworkFacts => ({
    format: 'PNG',
    widthPx: w,
    heightPx: h,
    viewBox: null,
    testOnly,
    warnings: [],
  });
  const pos = { scalePercent: 100, offsetXMm: 0, offsetYMm: 0 };
  const coverBox = { x: 0, y: 0, w: 68.46, h: 72 };

  it('accepts vector and ≥ 300 DPI PNG artwork', () => {
    expect(checkDesign(svg(), null, pos, coverBox).errors).toEqual([]);
    const c = checkDesign(png(2700, 600), null, pos, coverBox);
    expect(c.errors).toEqual([]);
    expect(c.effectiveDpi).toBe(600);
  });

  it('rejects wrong aspect instead of stretching', () => {
    expect(checkDesign(svg(400, 100), null, pos, coverBox).errors.join()).toMatch(
      /must be 4.5 : 1/,
    );
    expect(checkDesign(png(2700, 700), null, pos, coverBox).errors.join()).toMatch(
      /must be 4.5 : 1/,
    );
  });

  it('rejects low resolution, including after enlarging', () => {
    expect(checkDesign(png(990, 220), null, pos, coverBox).errors.join()).toMatch(/220 DPI/);
    const enlarged = checkDesign(png(1350, 300), null, { ...pos, scalePercent: 120 }, coverBox);
    expect(enlarged.errors.join()).toMatch(/250 DPI/);
  });

  it('test-only artwork never validates for production', () => {
    expect(checkDesign(png(900, 200, true), null, pos, coverBox).errors.join()).toMatch(
      /test-only/,
    );
  });

  it('warns when the artwork leaves the unit partly uncovered; rejects out-of-range controls', () => {
    expect(
      checkDesign(svg(), null, { ...pos, scalePercent: 80 }, coverBox).warnings.join(),
    ).toMatch(/does not cover/);
    expect(checkDesign(svg(), null, { ...pos, scalePercent: 300 }, coverBox).errors.join()).toMatch(
      /Scale/,
    );
    expect(checkDesign(svg(), null, { ...pos, offsetXMm: 40 }, coverBox).errors.join()).toMatch(
      /X offset/,
    );
  });

  it('cover artwork: trim warning and DPI check', () => {
    const c = checkDesign(svg(), svg(300, 100), pos, coverBox);
    expect(c.warnings.join()).toMatch(/trimmed/);
    expect(checkDesign(svg(), png(100, 100), pos, coverBox).errors.join()).toMatch(
      /Cover artwork prints at/,
    );
  });
});

describe('helpers', () => {
  it('SHA-256 of the stored bytes', () => {
    expect(sha256(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('filenames are display metadata only: traversal and control characters removed', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('..\\..\\windows\\x.svg')).toBe('x.svg');
    expect(safeFilename('a\u0000b<>.png')).toBe('ab.png');
    expect(safeFilename('..')).toBe('artwork');
    expect(safeFilename(undefined)).toBe('artwork');
  });

  it('ArtworkError is the only rejection type surfaced to admins', () => {
    expect(new ArtworkError('x')).toBeInstanceOf(Error);
  });
});
