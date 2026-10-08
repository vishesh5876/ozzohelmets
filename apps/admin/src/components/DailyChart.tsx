import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatNumber } from '../lib/format';

/**
 * Dependency-free daily column chart (SVG). One or two stacked series, fixed colour slots
 * (validated for colour-vision deficiency on the white surface), a legend for two series, a
 * per-column hover/focus tooltip and a table view so no value is hover-only.
 */
export interface ChartSeries {
  key: string;
  label: string;
}

const SERIES_COLORS = ['#2a78d6', '#eb6834'] as const;
const H = 180;
const PAD = { top: 12, right: 8, bottom: 22, left: 40 };

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= v) return m * mag;
  return 10 * mag;
}

const shortDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export function DailyChart<T extends { date: string }>({
  data,
  series,
  title,
  testId,
}: {
  data: T[];
  series: ChartSeries[];
  title: string;
  testId?: string;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => e && setMeasured(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const value = (row: T, key: string) => Number((row as Record<string, unknown>)[key] ?? 0);
  const totals = useMemo(
    () => data.map((r) => series.reduce((s, x) => s + value(r, x.key), 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, series],
  );
  const max = niceMax(Math.max(0, ...totals));
  // Real pixel width (no stretching, so text keeps its proportions); scrolls below 320px.
  const width = Math.max(320, measured);
  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = data.length ? plotW / data.length : plotW;
  const barW = Math.min(24, Math.max(4, band - 4));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(data.length / 8);
  const active = hover !== null ? data[hover] : undefined;

  return (
    <figure className="rounded-xl border border-hairline bg-canvas p-4" data-testid={testId}>
      <figcaption className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className="flex items-center gap-4 text-xs text-body">
          {series.length > 1 &&
            series.map((s, i) => (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: SERIES_COLORS[i] }}
                />
                {s.label}
              </span>
            ))}
          <button
            type="button"
            className="font-medium underline-offset-2 hover:underline"
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? 'Show chart' : 'Show table'}
          </button>
        </span>
      </figcaption>
      {data.length === 0 ? (
        <p className="py-10 text-center text-sm text-body">No data for this period.</p>
      ) : showTable ? (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-body">
              <tr>
                <th className="py-1 font-medium">Date</th>
                {series.map((s) => (
                  <th key={s.key} className="py-1 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.map((r) => (
                <tr key={r.date} className="border-t border-hairline">
                  <td className="py-1">{shortDate(r.date)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="py-1 text-right">
                      {formatNumber(value(r, s.key))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={box} className="relative overflow-x-auto">
          <svg
            role="img"
            aria-labelledby={`${id}-desc`}
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            className="block"
            onPointerLeave={() => setHover(null)}
          >
            <desc id={`${id}-desc`}>
              {title}: {data.length} days, peak {formatNumber(Math.max(0, ...totals))} per day.
            </desc>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="#e6e6e6" />
                <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="#5e5e5e">
                  {formatNumber(t)}
                </text>
              </g>
            ))}
            {data.map((row, i) => {
              const x = PAD.left + i * band + (band - barW) / 2;
              let base = 0;
              const parts = series.map((s, si) => {
                const v = value(row, s.key);
                const y0 = y(base);
                base += v;
                const y1 = y(base);
                const top =
                  si === series.length - 1 ||
                  series.slice(si + 1).every((n) => value(row, n.key) === 0);
                // 2px surface gap between stacked segments; 4px rounded data-end on the top segment.
                const h = Math.max(0, y0 - y1 - (si > 0 && v > 0 ? 2 : 0));
                if (v <= 0 || h <= 0) return null;
                return top ? (
                  <path
                    key={s.key}
                    d={roundedTop(x, y1, barW, h, Math.min(4, h, barW / 2))}
                    fill={SERIES_COLORS[si]}
                  />
                ) : (
                  <rect key={s.key} x={x} y={y1} width={barW} height={h} fill={SERIES_COLORS[si]} />
                );
              });
              return (
                <g key={row.date} opacity={hover === null || hover === i ? 1 : 0.55}>
                  {parts}
                  {i % labelEvery === 0 && (
                    <text
                      x={x + barW / 2}
                      y={H - 6}
                      textAnchor="middle"
                      fontSize="10"
                      fill="#5e5e5e"
                    >
                      {shortDate(row.date)}
                    </text>
                  )}
                  {/* Hit target: the whole column band, not just the painted bar. */}
                  <rect
                    x={PAD.left + i * band}
                    y={PAD.top}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={`${shortDate(row.date)}: ${series
                      .map((s) => `${s.label} ${value(row, s.key)}`)
                      .join(', ')}`}
                    onPointerEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                  />
                </g>
              );
            })}
          </svg>
          {active && hover !== null && (
            <div
              role="status"
              className="pointer-events-none absolute top-0 rounded-md bg-ink px-3 py-2 text-xs text-on-dark shadow-float"
              style={{
                left: `${Math.min(80, Math.max(0, ((PAD.left + hover * band) / width) * 100))}%`,
              }}
            >
              <p className="text-mute">{shortDate(active.date)}</p>
              {series.map((s, i) => (
                <p key={s.key} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-0.5 w-3"
                    style={{ background: SERIES_COLORS[i] }}
                  />
                  <strong className="tabular-nums">{formatNumber(value(active, s.key))}</strong>
                  <span className="text-mute">{s.label}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
