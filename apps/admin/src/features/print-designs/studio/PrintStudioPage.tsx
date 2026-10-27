import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Circle,
  Image as ImageIcon,
  LayoutTemplate,
  Redo2,
  Square,
  Type,
  Undo2,
  Wallpaper,
} from 'lucide-react';
import {
  EMPTY_STUDIO_DOCUMENT,
  Permission,
  STUDIO_UNIT_H,
  type PrintArtworkFileDto,
  type PrintDesignDto,
  type StudioDocument,
  type StudioGeometryDto,
  type StudioLayer,
} from '@helmet/types';
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@helmet/ui';
import { PageHeader } from '../../../components/PageHeader';
import { ErrorState, InlineError, LoadingState } from '../../../components/States';
import { api, apiBlob } from '../../../lib/api';
import { useAuth } from '../../../lib/auth-context';
import { DesignStatusBadge } from '../shared';
import {
  arrowLayer,
  clampBox,
  History,
  imageLayer,
  newId,
  ozzoTemplate,
  partAt,
  shapeLayer,
  textLayer,
} from './model';
import { StudioCanvas } from './StudioCanvas';
import { ColorRow, LayersPanel, PropertiesPanel } from './StudioInspector';

/**
 * Print Studio: design the whole Safety ID sticker and its cover in the admin — text, shapes,
 * images, backgrounds — around the locked ID, PIN and QR. Saves as a print design version (same
 * versioning, locking, activation and batch binding as uploaded artwork).
 */
export function PrintStudioPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can(Permission.PRINT_DESIGN_MANAGE);

  const geo = useQuery({
    queryKey: ['print-designs', 'studio-geometry'],
    queryFn: () => api.get<StudioGeometryDto>('/admin/print-designs/studio/geometry'),
    staleTime: Infinity,
  });
  const q = useQuery({
    queryKey: ['print-designs', id],
    queryFn: () => api.get<PrintDesignDto>(`/admin/print-designs/${id}`),
    enabled: !isNew,
  });
  const d = q.data;

  const [name, setName] = useState('');
  const [doc, setDoc] = useState<StudioDocument>(EMPTY_STUDIO_DOCUMENT);
  const [saved, setSaved] = useState<string>(JSON.stringify(EMPTY_STUDIO_DOCUMENT));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [files, setFiles] = useState<Map<string, PrintArtworkFileDto>>(new Map());
  const [showSystem, setShowSystem] = useState(true);
  const history = useRef(new History());
  const [, force] = useState(0);
  const loadedFor = useRef<string | null>(null);

  // Load the saved document once per design version.
  useEffect(() => {
    if (!d || loadedFor.current === d.id + d.updatedAt) return;
    loadedFor.current = d.id + d.updatedAt;
    const next = d.studioDocument ?? EMPTY_STUDIO_DOCUMENT;
    setName(d.name);
    setDoc(next);
    setSaved(JSON.stringify(next));
    setFiles(new Map(d.studioImages.map((f) => [f.id, f])));
    history.current = new History();
  }, [d]);

  const dirty = JSON.stringify(doc) !== saved || (d ? name !== d.name : true);

  // ── Edits ──────────────────────────────────────────────────────────────────────────────────
  const commit = useCallback((fn: (prev: StudioDocument) => StudioDocument) => {
    setDoc((prev) => {
      history.current.push(prev);
      return fn(prev);
    });
    force((n) => n + 1);
  }, []);
  /** Transient change during a drag (the drag start already snapshotted for undo). */
  const patchLive = useCallback((lid: string, p: Partial<StudioLayer>) => {
    setDoc((prev) => ({
      ...prev,
      layers: prev.layers.map((l) => (l.id === lid ? clampBox({ ...l, ...p } as StudioLayer) : l)),
    }));
  }, []);
  const patch = (lid: string, p: Partial<StudioLayer>) =>
    commit((prev) => ({
      ...prev,
      layers: prev.layers.map((l) => (l.id === lid ? clampBox({ ...l, ...p } as StudioLayer) : l)),
    }));
  const add = (l: StudioLayer) => {
    commit((prev) => ({ ...prev, layers: [...prev.layers, l] }));
    setSelectedId(l.id);
  };
  const remove = (lid: string) => {
    commit((prev) => ({ ...prev, layers: prev.layers.filter((l) => l.id !== lid) }));
    setSelectedId(null);
  };
  const duplicate = (lid: string) => {
    const src = doc.layers.find((l) => l.id === lid);
    if (src) add({ ...src, id: newId(), name: `${src.name} copy`, x: src.x + 3, y: src.y + 3 });
  };
  const moveZ = (lid: string, dir: 1 | -1) =>
    commit((prev) => {
      const i = prev.layers.findIndex((l) => l.id === lid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.layers.length) return prev;
      const layers = [...prev.layers];
      [layers[i], layers[j]] = [layers[j]!, layers[i]!];
      return { ...prev, layers };
    });
  const undo = () => {
    const prev = history.current.undo(doc);
    if (prev) setDoc(prev);
    force((n) => n + 1);
  };
  const redo = () => {
    const next = history.current.redo(doc);
    if (next) setDoc(next);
    force((n) => n + 1);
  };

  const selected = doc.layers.find((l) => l.id === selectedId) ?? null;

  // Keyboard: delete, nudge, duplicate, undo/redo (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (!selected || !canManage) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        remove(selected.id);
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicate(selected.id);
      } else if (e.key.startsWith('Arrow') && !selected.locked) {
        e.preventDefault();
        const s = e.shiftKey ? 2.835 : 0.2835; // 1 mm / 0.1 mm
        const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0;
        const dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
        patch(selected.id, { x: selected.x + dx, y: selected.y + dy });
      } else if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── Images ─────────────────────────────────────────────────────────────────────────────────
  const imageIds = useMemo(
    () => [...new Set(doc.layers.flatMap((l) => (l.kind === 'image' ? [l.fileId] : [])))],
    [doc.layers],
  );
  const blobs = useQueries({
    queries: imageIds.map((fid) => ({
      queryKey: ['blob', `/admin/print-designs/artwork/${fid}/content`],
      queryFn: () => apiBlob(`/admin/print-designs/artwork/${fid}/content`).then((r) => r.blob),
      staleTime: Infinity,
    })),
  });
  const blobKey = blobs.map((b) => b.dataUpdatedAt).join(',');
  const imageUrls = useMemo(() => {
    const m = new Map<string, string>();
    imageIds.forEach((fid, i) => {
      const b = blobs[i]?.data;
      if (b) m.set(fid, URL.createObjectURL(b));
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- blobKey tracks the blob data
  }, [imageIds, blobKey]);
  useEffect(() => () => imageUrls.forEach((u) => URL.revokeObjectURL(u)), [imageUrls]);

  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef<'image' | 'background' | { replace: string }>('image');
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.set('role', 'image');
      fd.set('file', file);
      return api.upload<PrintArtworkFileDto>('/admin/print-designs/artwork', fd);
    },
    onSuccess: (f) => {
      setFiles((m) => new Map(m).set(f.id, f));
      const aspect = f.format === 'PNG' ? f.widthPx! / f.heightPx! : viewBoxAspect(f.svgViewBox);
      const what = pending.current;
      const g = geo.data!;
      if (typeof what === 'object') {
        const l = doc.layers.find((x) => x.id === what.replace);
        if (l)
          patch(l.id, {
            fileId: f.id,
            h: l.w / aspect,
            name: f.originalFilename,
          } as Partial<StudioLayer>);
      } else if (what === 'background') {
        const l = imageLayer(f.id, 'Background image', aspect, {
          x: 0,
          y: 0,
          w: g.coverZoneX,
          h: STUDIO_UNIT_H,
          part: 'sticker',
          fit: 'cover',
        } as Partial<StudioLayer>);
        commit((prev) => ({ ...prev, layers: [l, ...prev.layers] }));
        setSelectedId(l.id);
      } else {
        const h = Math.min(30, 120 / aspect);
        add(
          imageLayer(f.id, f.originalFilename, aspect, {
            x: 8,
            y: (STUDIO_UNIT_H - h) / 2,
            h,
            w: h * aspect,
          } as Partial<StudioLayer>),
        );
      }
    },
  });
  const pickImage = (what: typeof pending.current) => {
    pending.current = what;
    fileInput.current?.click();
  };

  // ── Exact print preview (production engine, sample data), debounced ─────────────────────────
  const [previewDoc, setPreviewDoc] = useState(doc);
  useEffect(() => {
    const t = setTimeout(() => setPreviewDoc(doc), 700);
    return () => clearTimeout(t);
  }, [doc]);
  const preview = useQuery({
    queryKey: ['studio-preview', previewDoc],
    queryFn: async () => {
      const { blob } = await apiBlob('/admin/print-designs/studio/preview/unit.svg', {
        method: 'POST',
        body: { studioDocument: previewDoc },
      });
      return URL.createObjectURL(blob);
    },
    enabled: geo.isSuccess,
    placeholderData: (prev) => prev,
    staleTime: Infinity,
  });

  // ── Save ───────────────────────────────────────────────────────────────────────────────────
  const save = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), studioDocument: doc };
      if (isNew) return api.post<PrintDesignDto>('/admin/print-designs', body);
      if (d!.locked)
        return api.post<PrintDesignDto>(`/admin/print-designs/${id}/new-version`, body);
      return api.patch<PrintDesignDto>(`/admin/print-designs/${id}`, body);
    },
    onSuccess: async (res) => {
      setSaved(JSON.stringify(doc));
      await qc.invalidateQueries({ queryKey: ['print-designs'] });
      if (res.id !== id) navigate(`/print-designs/${res.id}/studio`, { replace: isNew });
    },
  });

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  if (geo.isLoading || (!isNew && q.isLoading)) return <LoadingState />;
  if (geo.error || (!isNew && (q.error || !d)))
    return (
      <ErrorState error={geo.error ?? q.error} onRetry={() => void (geo.refetch(), q.refetch())} />
    );
  if (d && d.kind !== 'STUDIO')
    return (
      <ErrorState
        error={
          new Error(
            'This design was made from an uploaded artwork file. Duplicate it into a new Studio design, or create a new one.',
          )
        }
      />
    );
  const g = geo.data!;
  const center = (w: number, h: number) => ({
    x: (g.coverZoneX - w) / 2 - 30,
    y: (STUDIO_UNIT_H - h) / 2,
  });

  return (
    <>
      <PageHeader
        back={{
          to: d ? `/print-designs/${d.id}` : '/print-designs',
          label: d ? 'Design' : 'Print Designs',
        }}
        title={isNew ? 'Print Studio · New Design' : `Print Studio · ${d!.name} v${d!.version}`}
        description={
          d ? (
            <span className="inline-flex items-center gap-2">
              <DesignStatusBadge status={d.status} />
              {d.locked ? 'Locked version: saving creates a new version.' : 'Draft'}
            </span>
          ) : (
            'Design the sticker and its cover. The Safety ID, PIN and QR are placed by the system (locked).'
          )
        }
        actions={
          <>
            <Button
              variant="subtle"
              onClick={undo}
              disabled={!history.current.canUndo}
              title="Undo (Ctrl+Z)"
            >
              <Undo2 className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="subtle"
              onClick={redo}
              disabled={!history.current.canRedo}
              title="Redo (Ctrl+Shift+Z)"
            >
              <Redo2 className="h-4 w-4" aria-hidden />
            </Button>
            {canManage && (
              <Button
                onClick={() => save.mutate()}
                loading={save.isPending}
                disabled={!name.trim() || (!isNew && !dirty)}
                data-testid="studio-save"
              >
                {isNew
                  ? 'Save Draft'
                  : d!.locked
                    ? 'Save as New Version'
                    : dirty
                      ? 'Save Draft'
                      : 'Saved'}
              </Button>
            )}
          </>
        }
      />
      <InlineError error={save.error ?? upload.error} />
      <input
        ref={fileInput}
        type="file"
        accept=".svg,.png,image/svg+xml,image/png"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) upload.mutate(f);
        }}
      />

      <div className="grid gap-4 xl:grid-cols-[14rem_minmax(0,1fr)_18rem]">
        {/* Tools */}
        <Card>
          <CardContent className="flex flex-col gap-4 pt-4 text-xs">
            <label className="flex flex-col gap-1">
              <span className="font-medium">Design name</span>
              <Input
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                placeholder="OZZO Emergency Red"
                disabled={!canManage}
              />
            </label>
            {canManage && (
              <>
                <div className="flex flex-col gap-1">
                  <span className="font-medium">Add</span>
                  <div className="grid grid-cols-2 gap-1">
                    <Tool
                      icon={Type}
                      label="Text"
                      onClick={() =>
                        add(textLayer('YOUR TEXT', center(60, 10).x, 30, 60, { sizePt: 10 }))
                      }
                    />
                    <Tool
                      icon={Square}
                      label="Box"
                      onClick={() =>
                        add(shapeLayer('rect', center(40, 20).x, 26, 40, 20, { radiusPt: 2 }))
                      }
                    />
                    <Tool
                      icon={Circle}
                      label="Circle"
                      onClick={() => add(shapeLayer('ellipse', center(20, 20).x, 26, 20, 20))}
                    />
                    <Tool
                      icon={ArrowRight}
                      label="Arrow"
                      onClick={() => add(arrowLayer(center(20, 8).x, 32, 20, 8))}
                    />
                    <Tool
                      icon={ImageIcon}
                      label="Image / logo"
                      onClick={() => pickImage('image')}
                      busy={upload.isPending}
                    />
                    <Tool
                      icon={Wallpaper}
                      label="Background"
                      onClick={() => pickImage('background')}
                      busy={upload.isPending}
                    />
                  </div>
                  <button
                    type="button"
                    className="mt-1 inline-flex items-center justify-center gap-1 rounded border border-dashed border-hairline px-2 py-1.5 hover:bg-canvas-soft"
                    onClick={() => {
                      if (
                        doc.layers.length &&
                        !window.confirm(
                          'Replace the current layers with the OZZO starter template?',
                        )
                      )
                        return;
                      commit(() => ozzoTemplate(g));
                      setSelectedId(null);
                    }}
                    data-testid="studio-template"
                  >
                    <LayoutTemplate className="h-3.5 w-3.5" aria-hidden /> OZZO starter template
                  </button>
                </div>
                <ColorRow
                  label="Sticker background"
                  value={doc.stickerBackground}
                  onChange={(c) => commit((p) => ({ ...p, stickerBackground: c ?? '#FFFFFF' }))}
                />
                <div className="flex flex-col gap-2">
                  <span className="font-medium">Removable cover</span>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={doc.defaultCover}
                      onChange={() => commit((p) => ({ ...p, defaultCover: true }))}
                    />
                    Standard yellow cover
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={!doc.defaultCover}
                      onChange={() => commit((p) => ({ ...p, defaultCover: false }))}
                      data-testid="studio-custom-cover"
                    />
                    Design my own cover
                  </label>
                  {!doc.defaultCover && (
                    <ColorRow
                      label="Cover background"
                      value={doc.coverBackground}
                      onChange={(c) => commit((p) => ({ ...p, coverBackground: c ?? '#FFFFFF' }))}
                    />
                  )}
                </div>
              </>
            )}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showSystem}
                onChange={(e) => setShowSystem(e.target.checked)}
              />
              Outline locked areas
            </label>
            <details className="text-body">
              <summary className="cursor-pointer font-medium text-ink">Shortcuts</summary>
              <p className="mt-1">
                Drag to move · corners resize (Shift keeps proportions) · top dot rotates · arrows
                nudge 0.1 mm (Shift 1 mm) · Delete · Ctrl+D duplicate · Ctrl+Z undo.
              </p>
            </details>
          </CardContent>
        </Card>

        {/* Canvas + exact print preview */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardContent className="pt-4">
              <StudioCanvas
                doc={doc}
                geometry={g}
                selectedId={selectedId}
                imageUrls={imageUrls}
                showSystem={showSystem}
                onSelect={setSelectedId}
                onBegin={() => {
                  history.current.push(doc);
                  force((n) => n + 1);
                }}
                onPatch={canManage ? patchLive : () => undefined}
              />
              <p className="mt-2 text-xs text-body">
                White boxes with the ID, PIN and QR are printed by the system on top of your design
                (they keep the QR scannable). Everything outside them is yours. The blue dashed line
                is where the cover is cut.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Print preview</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-xs">
              {preview.error ? (
                <InlineError error={preview.error} />
              ) : preview.data ? (
                <img
                  src={preview.data}
                  alt="Exact print preview"
                  className={`w-full border border-hairline bg-canvas ${preview.isFetching ? 'opacity-60' : ''}`}
                  data-testid="studio-preview"
                />
              ) : (
                <LoadingState />
              )}
              <p className="text-body">
                Rendered by the production print engine with sample data — exactly what prints.
              </p>
              {d && d.validationErrors.length > 0 && !dirty && (
                <ul className="text-danger">
                  {d.validationErrors.map((w) => (
                    <li key={w}>• {w}</li>
                  ))}
                </ul>
              )}
              {d && d.validationWarnings.length > 0 && !dirty && (
                <ul className="flex flex-col gap-1">
                  {d.validationWarnings.map((w) => (
                    <li key={w} className="flex items-start gap-1">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {w}
                    </li>
                  ))}
                </ul>
              )}
              {d && !dirty && (
                <button
                  type="button"
                  className="self-start font-medium underline"
                  onClick={() => navigate(`/print-designs/${d.id}`)}
                >
                  Test print, sheet preview and activation →
                </button>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Layers + properties */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Layers</CardTitle>
            </CardHeader>
            <CardContent>
              <LayersPanel
                doc={doc}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onPatch={patch}
                onMove={moveZ}
                onDuplicate={duplicate}
                onDelete={remove}
              />
            </CardContent>
          </Card>
          {selected && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Properties</CardTitle>
              </CardHeader>
              <CardContent>
                <fieldset disabled={!canManage}>
                  <PropertiesPanel
                    layer={selected}
                    onPatch={(p) =>
                      patch(
                        selected.id,
                        'x' in p && !('part' in p) && selected.part !== 'both'
                          ? { ...p, part: partAt(p.x!, selected.w) }
                          : p,
                      )
                    }
                    onReplaceImage={() => pickImage({ replace: selected.id })}
                  />
                  {selected.kind === 'image' && files.get(selected.fileId) && (
                    <p className="mt-2 text-xs text-body">
                      {files.get(selected.fileId)!.originalFilename} ·{' '}
                      {files.get(selected.fileId)!.format === 'SVG'
                        ? 'vector'
                        : `${files.get(selected.fileId)!.widthPx} × ${files.get(selected.fileId)!.heightPx} px`}
                    </p>
                  )}
                </fieldset>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Tool({
  icon: Icon,
  label,
  onClick,
  busy,
}: {
  icon: typeof Type;
  label: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex flex-col items-center gap-1 rounded border border-hairline px-1 py-2 hover:bg-canvas-soft disabled:opacity-50"
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}

function viewBoxAspect(vb: string | null): number {
  const [, , w, h] = (vb ?? '0 0 1 1').split(' ').map(Number);
  return w! / h!;
}
