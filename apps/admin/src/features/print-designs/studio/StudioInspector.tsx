import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Lock,
  Square,
  Trash2,
  Type,
  Unlock,
} from 'lucide-react';
import type { StudioDocument, StudioLayer, StudioPart } from '@helmet/types';
import { textHeight, toMm, toPt } from './model';

/** Layers list (top = front) and the selected layer's properties. */

type Patch = Partial<StudioLayer>;

const KIND_ICON = { text: Type, rect: Square, ellipse: Square, arrow: ArrowUp, image: ImageIcon };

export function LayersPanel({
  doc,
  selectedId,
  onSelect,
  onPatch,
  onMove,
  onDuplicate,
  onDelete,
}: {
  doc: StudioDocument;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPatch: (id: string, p: Patch) => void;
  onMove: (id: string, dir: 1 | -1) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const layers = [...doc.layers].reverse();
  if (!layers.length)
    return <p className="text-xs text-body">No layers yet. Add text, shapes or images.</p>;
  return (
    <ul
      className="flex max-h-72 flex-col gap-0.5 overflow-y-auto text-xs"
      data-testid="studio-layers"
    >
      {layers.map((l) => {
        const Icon = KIND_ICON[l.kind];
        const active = l.id === selectedId;
        return (
          <li
            key={l.id}
            className={`group flex items-center gap-1 rounded px-1.5 py-1 ${active ? 'bg-primary/10 ring-1 ring-primary' : 'hover:bg-canvas-soft'}`}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              onClick={() => onSelect(l.id)}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className={`truncate ${l.hidden ? 'text-body line-through' : ''}`}>
                {l.name}
              </span>
              <span className="shrink-0 text-[10px] uppercase text-body">
                {l.part === 'cover' ? 'cover' : l.part === 'both' ? 'both' : ''}
              </span>
            </button>
            <IconBtn
              label={l.hidden ? 'Show' : 'Hide'}
              onClick={() => onPatch(l.id, { hidden: !l.hidden })}
            >
              {l.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </IconBtn>
            <IconBtn
              label={l.locked ? 'Unlock' : 'Lock'}
              onClick={() => onPatch(l.id, { locked: !l.locked })}
            >
              {l.locked ? (
                <Lock className="h-3.5 w-3.5" />
              ) : (
                <Unlock className="h-3.5 w-3.5 opacity-40" />
              )}
            </IconBtn>
            <IconBtn label="Bring forward" onClick={() => onMove(l.id, 1)}>
              <ArrowUp className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn label="Send backward" onClick={() => onMove(l.id, -1)}>
              <ArrowDown className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn label="Duplicate" onClick={() => onDuplicate(l.id)}>
              <Copy className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn label="Delete" onClick={() => onDelete(l.id)}>
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </IconBtn>
          </li>
        );
      })}
    </ul>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="rounded p-0.5 hover:bg-canvas"
    >
      {children}
    </button>
  );
}

export function PropertiesPanel({
  layer: l,
  onPatch,
  onReplaceImage,
}: {
  layer: StudioLayer;
  onPatch: (p: Patch) => void;
  onReplaceImage: () => void;
}) {
  const textPatch = (p: Partial<Extract<StudioLayer, { kind: 'text' }>>) => {
    if (l.kind !== 'text') return;
    const next = { ...l, ...p };
    onPatch({
      ...p,
      h: textHeight(next.sizePt, next.lineHeight, next.text.split('\n').length),
    } as Patch);
  };
  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="studio-properties">
      <Row label="Name">
        <input
          className={inputCls}
          value={l.name}
          maxLength={60}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
      </Row>
      <Row label="Prints on">
        <select
          className={inputCls}
          value={l.part}
          onChange={(e) => onPatch({ part: e.target.value as StudioPart })}
        >
          <option value="sticker">Sticker</option>
          <option value="cover">Removable cover</option>
          <option value="both">Both (e.g. a background)</option>
        </select>
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Num
          label="X (mm)"
          value={toMm(l.x)}
          step={0.1}
          onChange={(v) => onPatch({ x: toPt(v) })}
        />
        <Num
          label="Y (mm)"
          value={toMm(l.y)}
          step={0.1}
          onChange={(v) => onPatch({ y: toPt(v) })}
        />
        <Num
          label="Width (mm)"
          value={toMm(l.w)}
          step={0.1}
          min={0.1}
          onChange={(v) => onPatch({ w: toPt(v) })}
        />
        {l.kind !== 'text' && (
          <Num
            label="Height (mm)"
            value={toMm(l.h)}
            step={0.1}
            min={0.1}
            onChange={(v) => onPatch({ h: toPt(v) })}
          />
        )}
        <Num
          label="Rotate (°)"
          value={l.rotate}
          step={1}
          min={-360}
          max={360}
          onChange={(v) => onPatch({ rotate: v })}
        />
      </div>

      {l.kind === 'text' && (
        <>
          <Row label="Text">
            <textarea
              className={`${inputCls} h-16 resize-y font-medium`}
              value={l.text}
              maxLength={500}
              onChange={(e) => textPatch({ text: e.target.value })}
              data-testid="studio-text"
            />
          </Row>
          <div className="grid grid-cols-2 gap-2">
            <Num
              label="Size (pt)"
              value={l.sizePt}
              step={0.1}
              min={3}
              max={72}
              onChange={(v) => textPatch({ sizePt: v })}
            />
            <Num
              label="Letter spacing"
              value={l.letterSpacingPt}
              step={0.1}
              min={-2}
              max={20}
              onChange={(v) => textPatch({ letterSpacingPt: v })}
            />
            <Num
              label="Line height"
              value={l.lineHeight}
              step={0.05}
              min={0.7}
              max={3}
              onChange={(v) => textPatch({ lineHeight: v })}
            />
            <Row label="Align">
              <select
                className={inputCls}
                value={l.align}
                onChange={(e) => textPatch({ align: e.target.value as 'left' })}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </Row>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={l.bold}
              onChange={(e) => textPatch({ bold: e.target.checked })}
            />{' '}
            Bold
          </label>
          <ColorRow label="Colour" value={l.color} onChange={(c) => textPatch({ color: c! })} />
          <p className="text-body">
            Prints with the sticker font (Helvetica). Text never wraps: use new lines.
          </p>
        </>
      )}

      {(l.kind === 'rect' || l.kind === 'ellipse') && (
        <>
          <ColorRow
            label="Fill"
            value={l.fill}
            optional
            onChange={(c) => onPatch({ fill: c } as Patch)}
          />
          <ColorRow
            label="Border"
            value={l.stroke}
            optional
            onChange={(c) =>
              onPatch({ stroke: c, strokePt: c && !l.strokePt ? 1 : l.strokePt } as Patch)
            }
          />
          <div className="grid grid-cols-2 gap-2">
            <Num
              label="Border (pt)"
              value={l.strokePt}
              step={0.1}
              min={0}
              max={20}
              onChange={(v) => onPatch({ strokePt: v } as Patch)}
            />
            {l.kind === 'rect' && (
              <Num
                label="Corner radius (pt)"
                value={l.radiusPt}
                step={0.5}
                min={0}
                max={100}
                onChange={(v) => onPatch({ radiusPt: v } as Patch)}
              />
            )}
          </div>
        </>
      )}

      {l.kind === 'arrow' && (
        <>
          <ColorRow
            label="Colour"
            value={l.color}
            onChange={(c) => onPatch({ color: c! } as Patch)}
          />
          <Num
            label="Thickness (pt)"
            value={l.strokePt}
            step={0.1}
            min={0.2}
            max={20}
            onChange={(v) => onPatch({ strokePt: v } as Patch)}
          />
          <p className="text-body">Points right; use Rotate for other directions.</p>
        </>
      )}

      {l.kind === 'image' && (
        <>
          <Row label="Fit">
            <select
              className={inputCls}
              value={l.fit}
              onChange={(e) => onPatch({ fit: e.target.value as 'contain' } as Patch)}
            >
              <option value="contain">Contain (whole image)</option>
              <option value="cover">Fill box (crop edges)</option>
            </select>
          </Row>
          <button
            type="button"
            className="self-start rounded border border-hairline px-2 py-1 hover:bg-canvas-soft"
            onClick={onReplaceImage}
          >
            Replace image…
          </button>
          <p className="text-body">
            Images are never stretched. Corner handles keep the aspect ratio.
          </p>
        </>
      )}
    </div>
  );
}

export const inputCls = 'h-8 w-full rounded-sm border border-hairline bg-canvas px-2 text-xs';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

export function Num({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <Row label={label}>
      <input
        type="number"
        className={inputCls}
        value={Math.round(value * 100) / 100}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (Number.isFinite(v))
            onChange(
              min !== undefined || max !== undefined
                ? Math.min(max ?? v, Math.max(min ?? v, v))
                : v,
            );
        }}
      />
    </Row>
  );
}

export function ColorRow({
  label,
  value,
  onChange,
  optional,
}: {
  label: string;
  value: string | null;
  onChange: (c: string | null) => void;
  optional?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      <div className="flex items-center gap-2">
        {optional && (
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={value !== null}
              onChange={(e) => onChange(e.target.checked ? '#000000' : null)}
            />
            <span>On</span>
          </label>
        )}
        {value !== null && (
          <>
            <input
              type="color"
              className="h-8 w-10 cursor-pointer rounded border border-hairline"
              value={value.toLowerCase()}
              onChange={(e) => onChange(e.target.value.toUpperCase())}
              aria-label={`${label} colour`}
            />
            <input
              className={`${inputCls} w-24 font-mono uppercase`}
              defaultValue={value}
              key={value}
              maxLength={7}
              onBlur={(e) =>
                /^#[0-9a-f]{6}$/i.test(e.target.value) && onChange(e.target.value.toUpperCase())
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
