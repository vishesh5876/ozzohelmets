import { useRef, useState } from 'react';
import {
  STUDIO_UNIT_H,
  STUDIO_UNIT_W,
  type StudioDocument,
  type StudioGeometryDto,
  type StudioLayer,
} from '@helmet/types';
import { CAP_HEIGHT } from './model';

/**
 * The Print Studio canvas: the 4.5 × 1 in unit in PDF points. Layers are drawn the way the print
 * engine draws them (same box, text baseline, image fit, clipping per piece); the system's ID,
 * PIN and QR are drawn on top as a locked overlay at their true positions. The exact engine
 * render is shown separately (the "Print preview").
 */

const MARGIN = 14;
const SNAP_PT = 1.2;

type Patch = Partial<StudioLayer>;
type Drag =
  | { mode: 'move'; id: string; sx: number; sy: number; box: Box }
  | { mode: 'resize'; id: string; sx: number; sy: number; box: Box; corner: Corner; rot: number }
  | { mode: 'rotate'; id: string; cx: number; cy: number };
type Box = { x: number; y: number; w: number; h: number };
type Corner = 'nw' | 'ne' | 'sw' | 'se';

export function StudioCanvas({
  doc,
  geometry: g,
  selectedId,
  imageUrls,
  showSystem,
  onSelect,
  onBegin,
  onPatch,
}: {
  doc: StudioDocument;
  geometry: StudioGeometryDto;
  selectedId: string | null;
  imageUrls: ReadonlyMap<string, string>;
  showSystem: boolean;
  onSelect: (id: string | null) => void;
  /** A drag starts: snapshot for undo. */
  onBegin: () => void;
  onPatch: (id: string, patch: Patch) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });

  const point = (e: React.PointerEvent) => {
    const m = svg.current!.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: p.x, y: p.y };
  };

  const selected = doc.layers.find((l) => l.id === selectedId) ?? null;
  const xTargets = [
    0,
    STUDIO_UNIT_W,
    g.coverZoneX,
    g.coverPrint.x,
    g.coverPrint.x + g.coverPrint.w,
    g.coverDie.x,
    g.coverDie.x + g.coverDie.w,
    g.coverDie.x + g.coverDie.w / 2,
    g.safeInset,
  ];
  const yTargets = [0, STUDIO_UNIT_H, STUDIO_UNIT_H / 2, g.safeInset, STUDIO_UNIT_H - g.safeInset];
  for (const k of g.keepClear) {
    xTargets.push(k.x, k.x + k.w);
    yTargets.push(k.y, k.y + k.h);
  }

  function snapMove(id: string, b: Box): Box {
    const xs = [...xTargets];
    const ys = [...yTargets];
    for (const l of doc.layers)
      if (l.id !== id && !l.hidden) {
        xs.push(l.x, l.x + l.w, l.x + l.w / 2);
        ys.push(l.y, l.y + l.h, l.y + l.h / 2);
      }
    const best = (cands: number[], targets: number[]) => {
      let out: { d: number; t: number } | null = null;
      for (const c of cands)
        for (const t of targets) {
          const d = t - c;
          if (Math.abs(d) <= SNAP_PT && (!out || Math.abs(d) < Math.abs(out.d))) out = { d, t };
        }
      return out;
    };
    const sx = best([b.x, b.x + b.w, b.x + b.w / 2], xs);
    const sy = best([b.y, b.y + b.h, b.y + b.h / 2], ys);
    setGuides({ x: sx ? [sx.t] : [], y: sy ? [sy.t] : [] });
    return { ...b, x: b.x + (sx?.d ?? 0), y: b.y + (sy?.d ?? 0) };
  }

  const r2 = (v: number) => Math.round(v * 100) / 100;

  function onMove(e: React.PointerEvent) {
    if (!drag) return;
    const p = point(e);
    if (drag.mode === 'move') {
      const b = snapMove(drag.id, {
        ...drag.box,
        x: drag.box.x + p.x - drag.sx,
        y: drag.box.y + p.y - drag.sy,
      });
      onPatch(drag.id, { x: r2(b.x), y: r2(b.y) });
    } else if (drag.mode === 'resize') {
      // Pointer delta in the layer's own (unrotated) frame.
      const a = (-drag.rot * Math.PI) / 180;
      const dx0 = p.x - drag.sx;
      const dy0 = p.y - drag.sy;
      const dx = dx0 * Math.cos(a) - dy0 * Math.sin(a);
      const dy = dx0 * Math.sin(a) + dy0 * Math.cos(a);
      let { x, y, w, h } = drag.box;
      const layer = doc.layers.find((l) => l.id === drag.id);
      const keepAspect = e.shiftKey || layer?.kind === 'image';
      if (drag.corner.includes('e')) w += dx;
      if (drag.corner.includes('w')) {
        w -= dx;
        x += dx;
      }
      if (drag.corner.includes('s')) h += dy;
      if (drag.corner.includes('n')) {
        h -= dy;
        y += dy;
      }
      if (keepAspect) {
        const ratio = drag.box.w / drag.box.h;
        const nh = w / ratio;
        if (drag.corner.includes('n')) y += h - nh;
        h = nh;
      }
      if (w < 1 || h < 0.5) return;
      if (layer?.kind === 'text') {
        // Text height follows the font: resizing vertically scales the font size.
        const scale = h / drag.box.h;
        onPatch(drag.id, {
          x: r2(x),
          y: r2(y),
          w: r2(w),
          h: r2(h),
          ...(Math.abs(scale - 1) > 0.001 && drag.corner.length
            ? { sizePt: r2(Math.max(3, Math.min(72, (layerSize(drag.id) ?? 8) * scale))) }
            : {}),
        } as Patch);
      } else onPatch(drag.id, { x: r2(x), y: r2(y), w: r2(w), h: r2(h) });
    } else {
      let deg = (Math.atan2(p.y - drag.cy, p.x - drag.cx) * 180) / Math.PI + 90;
      if (deg > 180) deg -= 360;
      if (!e.shiftKey) {
        const snapped = Math.round(deg / 15) * 15;
        if (Math.abs(snapped - deg) < 4) deg = snapped;
      }
      onPatch(drag.id, { rotate: r2(deg) });
    }
  }

  // Text resize scales from the font size at drag start.
  const startSize = useRef<number | null>(null);
  const layerSize = (id: string) => {
    if (startSize.current === null) {
      const l = doc.layers.find((x) => x.id === id);
      startSize.current = l?.kind === 'text' ? l.sizePt : null;
    }
    return startSize.current;
  };

  function start(e: React.PointerEvent, d: Drag) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    startSize.current = null;
    onBegin();
    setDrag(d);
  }

  function end() {
    setDrag(null);
    setGuides({ x: [], y: [] });
  }

  const vb = `${-MARGIN} ${-MARGIN} ${STUDIO_UNIT_W + 2 * MARGIN} ${STUDIO_UNIT_H + 2 * MARGIN}`;
  const sticker = { x: 0, y: 0, w: g.coverZoneX, h: STUDIO_UNIT_H };
  const zoomStroke = 0.35;

  return (
    <svg
      ref={svg}
      viewBox={vb}
      className="block w-full touch-none select-none rounded-md bg-[#E8EAED]"
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerDown={() => onSelect(null)}
      data-testid="studio-canvas"
      role="application"
      aria-label="Sticker design canvas"
    >
      <defs>
        <clipPath id="studio-clip-sticker">
          <rect {...sticker} width={sticker.w} height={sticker.h} />
        </clipPath>
        <clipPath id="studio-clip-cover">
          <rect
            x={g.coverPrint.x}
            y={g.coverPrint.y}
            width={g.coverPrint.w}
            height={g.coverPrint.h}
          />
        </clipPath>
        <pattern id="studio-waste" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" fill="#F1F3F4" />
          <path d="M0 4L4 0" stroke="#DADCE0" strokeWidth="0.4" />
        </pattern>
      </defs>

      {/* Unit: sticker piece, cover zone (waste around the cover). */}
      <rect x={0} y={0} width={STUDIO_UNIT_W} height={STUDIO_UNIT_H} fill="url(#studio-waste)" />
      <rect
        x={0}
        y={0}
        width={g.coverZoneX}
        height={STUDIO_UNIT_H}
        fill={doc.stickerBackground ?? '#FFFFFF'}
      />
      <g clipPath="url(#studio-clip-sticker)">
        {doc.layers.map((l) =>
          !l.hidden && l.part !== 'cover' ? (
            <LayerShape key={l.id} layer={l} imageUrls={imageUrls} />
          ) : null,
        )}
      </g>
      {doc.defaultCover ? (
        <DefaultCover g={g} />
      ) : (
        <>
          <rect
            x={g.coverPrint.x}
            y={g.coverPrint.y}
            width={g.coverPrint.w}
            height={g.coverPrint.h}
            fill={doc.coverBackground ?? '#FFFFFF'}
          />
          <g clipPath="url(#studio-clip-cover)">
            {doc.layers.map((l) =>
              !l.hidden && l.part !== 'sticker' ? (
                <LayerShape key={l.id} layer={l} imageUrls={imageUrls} />
              ) : null,
            )}
          </g>
        </>
      )}

      {/* Locked system areas (always printed on top). */}
      <SystemOverlay g={g} outline={showSystem} />
      <rect
        x={g.coverDie.x}
        y={g.coverDie.y}
        width={g.coverDie.w}
        height={g.coverDie.h}
        rx={2.8}
        fill="none"
        stroke="#00A0FF"
        strokeWidth={zoomStroke}
        strokeDasharray="1.5 1"
        pointerEvents="none"
      />
      <line
        x1={g.coverZoneX}
        x2={g.coverZoneX}
        y1={-4}
        y2={STUDIO_UNIT_H + 4}
        stroke="#EC008C"
        strokeWidth={zoomStroke}
        strokeDasharray="2 1"
        pointerEvents="none"
      />
      <text x={g.coverZoneX - 1} y={-5} fontSize={4} textAnchor="end" fill="#5F6368">
        STICKER
      </text>
      <text x={g.coverZoneX + 1} y={-5} fontSize={4} fill="#5F6368">
        REMOVABLE COVER
      </text>

      {/* Hit areas (above the overlay so layers under the QR box can still be picked). */}
      {doc.layers.map((l) =>
        l.hidden ? null : (
          <rect
            key={l.id}
            x={l.x}
            y={l.y}
            width={Math.max(l.w, 1)}
            height={Math.max(l.h, 1)}
            transform={
              l.rotate ? `rotate(${l.rotate} ${l.x + l.w / 2} ${l.y + l.h / 2})` : undefined
            }
            fill="transparent"
            className={l.locked ? 'cursor-default' : 'cursor-move'}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelect(l.id);
              if (l.locked) return;
              const p = point(e);
              start(e, { mode: 'move', id: l.id, sx: p.x, sy: p.y, box: l });
            }}
            data-testid={`studio-hit-${l.id}`}
          />
        ),
      )}

      {selected && !selected.hidden && (
        <Selection
          layer={selected}
          onCorner={(e, corner) =>
            start(e, {
              mode: 'resize',
              id: selected.id,
              sx: point(e).x,
              sy: point(e).y,
              box: selected,
              corner,
              rot: selected.rotate,
            })
          }
          onRotate={(e) =>
            start(e, {
              mode: 'rotate',
              id: selected.id,
              cx: selected.x + selected.w / 2,
              cy: selected.y + selected.h / 2,
            })
          }
        />
      )}
      {guides.x.map((x) => (
        <line
          key={`gx${x}`}
          x1={x}
          x2={x}
          y1={-MARGIN}
          y2={STUDIO_UNIT_H + MARGIN}
          stroke="#FF00FF"
          strokeWidth={0.3}
          pointerEvents="none"
        />
      ))}
      {guides.y.map((y) => (
        <line
          key={`gy${y}`}
          y1={y}
          y2={y}
          x1={-MARGIN}
          x2={STUDIO_UNIT_W + MARGIN}
          stroke="#FF00FF"
          strokeWidth={0.3}
          pointerEvents="none"
        />
      ))}
    </svg>
  );
}

/** One layer, drawn like the print engine draws it. */
export function LayerShape({
  layer: l,
  imageUrls,
}: {
  layer: StudioLayer;
  imageUrls: ReadonlyMap<string, string>;
}) {
  let body: React.ReactNode = null;
  switch (l.kind) {
    case 'text': {
      const anchor = l.align === 'center' ? 'middle' : l.align === 'right' ? 'end' : 'start';
      const x = l.align === 'center' ? l.x + l.w / 2 : l.align === 'right' ? l.x + l.w : l.x;
      body = l.text.split('\n').map((line, i) => (
        <text
          key={i}
          x={x}
          y={l.y + l.sizePt * CAP_HEIGHT + i * l.sizePt * l.lineHeight}
          textAnchor={anchor}
          fontFamily="Helvetica, Arial, sans-serif"
          fontWeight={l.bold ? 700 : 400}
          fontSize={l.sizePt}
          letterSpacing={l.letterSpacingPt || undefined}
          fill={l.color}
          style={{ whiteSpace: 'pre' }}
        >
          {line}
        </text>
      ));
      break;
    }
    case 'rect': {
      const i = l.stroke && l.strokePt > 0 ? l.strokePt / 2 : 0;
      const w = Math.max(0.01, l.w - 2 * i);
      const h = Math.max(0.01, l.h - 2 * i);
      body = (
        <rect
          x={l.x + i}
          y={l.y + i}
          width={w}
          height={h}
          rx={l.radiusPt ? Math.min(l.radiusPt, w / 2, h / 2) : undefined}
          fill={l.fill ?? 'none'}
          stroke={i ? l.stroke! : undefined}
          strokeWidth={i ? l.strokePt : undefined}
        />
      );
      break;
    }
    case 'ellipse': {
      const i = l.stroke && l.strokePt > 0 ? l.strokePt / 2 : 0;
      body = (
        <ellipse
          cx={l.x + l.w / 2}
          cy={l.y + l.h / 2}
          rx={Math.max(0.01, l.w / 2 - i)}
          ry={Math.max(0.01, l.h / 2 - i)}
          fill={l.fill ?? 'none'}
          stroke={i ? l.stroke! : undefined}
          strokeWidth={i ? l.strokePt : undefined}
        />
      );
      break;
    }
    case 'arrow': {
      const mid = l.y + l.h / 2;
      const head = Math.min(l.w * 0.6, l.h);
      const tip = l.x + l.w;
      const hb = tip - head;
      const t = Math.min(l.strokePt, l.h);
      body = (
        <>
          {hb > l.x && (
            <rect x={l.x} y={mid - t / 2} width={hb - l.x + 0.2} height={t} fill={l.color} />
          )}
          <polygon points={`${tip},${mid} ${hb},${l.y} ${hb},${l.y + l.h}`} fill={l.color} />
        </>
      );
      break;
    }
    case 'image': {
      const url = imageUrls.get(l.fileId);
      body = url ? (
        <svg
          x={l.x}
          y={l.y}
          width={l.w}
          height={l.h}
          viewBox={`0 0 ${l.w} ${l.h}`}
          overflow="hidden"
        >
          <image
            href={url}
            width={l.w}
            height={l.h}
            preserveAspectRatio={l.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'}
          />
        </svg>
      ) : (
        <rect
          x={l.x}
          y={l.y}
          width={l.w}
          height={l.h}
          fill="#F1F3F4"
          stroke="#9AA0A6"
          strokeWidth={0.3}
          strokeDasharray="1"
        />
      );
      break;
    }
  }
  return l.rotate ? (
    <g transform={`rotate(${l.rotate} ${l.x + l.w / 2} ${l.y + l.h / 2})`}>{body}</g>
  ) : (
    <>{body}</>
  );
}

function Selection({
  layer: l,
  onCorner,
  onRotate,
}: {
  layer: StudioLayer;
  onCorner: (e: React.PointerEvent, c: Corner) => void;
  onRotate: (e: React.PointerEvent) => void;
}) {
  const s = 2.4;
  const corners: [Corner, number, number][] = [
    ['nw', l.x, l.y],
    ['ne', l.x + l.w, l.y],
    ['sw', l.x, l.y + l.h],
    ['se', l.x + l.w, l.y + l.h],
  ];
  return (
    <g transform={l.rotate ? `rotate(${l.rotate} ${l.x + l.w / 2} ${l.y + l.h / 2})` : undefined}>
      <rect
        x={l.x}
        y={l.y}
        width={l.w}
        height={l.h}
        fill="none"
        stroke="#1A73E8"
        strokeWidth={0.4}
        pointerEvents="none"
      />
      {!l.locked && (
        <>
          {corners.map(([c, x, y]) => (
            <rect
              key={c}
              x={x - s / 2}
              y={y - s / 2}
              width={s}
              height={s}
              fill="#FFFFFF"
              stroke="#1A73E8"
              strokeWidth={0.4}
              className={c === 'nw' || c === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}
              onPointerDown={(e) => onCorner(e, c)}
              data-testid={`studio-handle-${c}`}
            />
          ))}
          <line
            x1={l.x + l.w / 2}
            x2={l.x + l.w / 2}
            y1={l.y}
            y2={l.y - 5}
            stroke="#1A73E8"
            strokeWidth={0.4}
            pointerEvents="none"
          />
          <circle
            cx={l.x + l.w / 2}
            cy={l.y - 6}
            r={1.5}
            fill="#FFFFFF"
            stroke="#1A73E8"
            strokeWidth={0.4}
            className="cursor-grab"
            onPointerDown={onRotate}
          />
        </>
      )}
    </g>
  );
}

/** The ID, PIN and QR as the engine prints them (sample data), locked. */
function SystemOverlay({ g, outline }: { g: StudioGeometryDto; outline: boolean }) {
  const q = g.qr;
  const mod = q.w / 41; // ~33-module code + 4-module quiet zone each side
  const finder = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width={7 * mod} height={7 * mod} fill="#000" />
      <rect x={x + mod} y={y + mod} width={5 * mod} height={5 * mod} fill="#FFF" />
      <rect x={x + 2 * mod} y={y + 2 * mod} width={3 * mod} height={3 * mod} fill="#000" />
    </g>
  );
  const q0 = { x: q.x + 4 * mod, y: q.y + 4 * mod, s: q.w - 8 * mod };
  return (
    <g pointerEvents="none">
      {g.keepClear.map((k, i) => (
        <rect key={i} x={k.x} y={k.y} width={k.w} height={k.h} rx={k.radius} fill="#FFFFFF" />
      ))}
      <text
        x={g.pin.x}
        y={g.pin.baselineY}
        textAnchor="middle"
        fontFamily="Helvetica, Arial, sans-serif"
        fontWeight={700}
        fontSize={g.pin.sizePt}
        letterSpacing={0.6}
      >
        PIN: {g.sample.pin}
      </text>
      <text
        transform={`rotate(-90 ${g.id.baselineX} ${g.id.centerY})`}
        x={g.id.baselineX}
        y={g.id.centerY}
        textAnchor="middle"
        fontFamily="Helvetica, Arial, sans-serif"
        fontWeight={700}
        fontSize={g.id.sizePt}
      >
        ID: {g.sample.safetyCode}
      </text>
      {finder(q0.x, q0.y)}
      {finder(q0.x + q0.s - 7 * mod, q0.y)}
      {finder(q0.x, q0.y + q0.s - 7 * mod)}
      <rect
        x={q0.x + 9 * mod}
        y={q0.y + 9 * mod}
        width={q0.s - 18 * mod}
        height={q0.s - 18 * mod}
        fill="#000"
        opacity={0.18}
      />
      <text
        x={q.x + q.w / 2}
        y={q.y + q.h / 2 + 2}
        textAnchor="middle"
        fontSize={5}
        fontWeight={700}
        fill="#3C4043"
      >
        QR (system)
      </text>
      {outline &&
        g.keepClear.map((k, i) => (
          <rect
            key={`o${i}`}
            x={k.x}
            y={k.y}
            width={k.w}
            height={k.h}
            rx={k.radius}
            fill="none"
            stroke="#FF00FF"
            strokeWidth={0.35}
            strokeDasharray="1.2 0.8"
          />
        ))}
    </g>
  );
}

/** The system's default yellow cover (approximation; the print preview shows it exactly). */
function DefaultCover({ g }: { g: StudioGeometryDto }) {
  const d = g.coverDie;
  const c = g.coverPrint;
  const cx = d.x + d.w / 2;
  const tab = d.y + d.h - 13;
  return (
    <g
      pointerEvents="none"
      fontFamily="Helvetica, Arial, sans-serif"
      fontWeight={700}
      textAnchor="middle"
    >
      <rect x={c.x} y={c.y} width={c.w} height={c.h} fill="#FFD100" />
      <rect x={c.x} y={tab} width={c.w} height={c.y + c.h - tab} fill="#000" />
      <text x={cx} y={d.y + 22} fontSize={10}>
        REMOVE
      </text>
      <text x={cx} y={d.y + 32} fontSize={7.5}>
        ONLY IN
      </text>
      <text x={cx} y={d.y + 42} fontSize={7.5}>
        EMERGENCY
      </text>
      <text x={cx} y={tab + 9} fontSize={7} fill="#FFD100">
        ▲ OPEN
      </text>
    </g>
  );
}
