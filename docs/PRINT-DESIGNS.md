# Print Designs: admin-controlled Safety ID artwork

Admins change the visual design of the 4.5 × 1 in Safety ID sticker without code changes. The
print engine ([SAFETY-ID-PRINT](SAFETY-ID-PRINT.md)) is unchanged: units, 48-up sheets, cut and
cover geometry, six-digit PIN, QR and PIN escrow all stay as they were.

## 1. Artwork vs dynamic print data

| Admin artwork (uploaded)                                           | System-generated (never in the artwork)                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Backgrounds, OZZO branding, colours, shapes, textures, static text | Safety ID, six-digit PIN (vector text), QR (black on white, quiet zone)       |
| Optional cover artwork (inside the cover print box)                | White credential panel (whole 1.15 in middle zone), cover die/placement marks |
| Uniform scale + X/Y offset of the base artwork                     | Cut lines, cover geometry, protected target, test-print marker                |

Drawing order per unit: base artwork (clipped to the unit) → white credential panel → ID → PIN →
QR → cover alignment marks → cover (custom artwork clipped to the cover print box, or the default
yellow REMOVE / ONLY IN EMERGENCY / ▲ OPEN cover). Artwork can never reach the QR, its quiet zone,
the PIN or the ID: the white panel is drawn over the artwork, and the QR is always black modules
on white.

### Two artwork fits (decided by the file's aspect ratio)

Only the **emergency panel** — the left 2.2 × 1 in (55.88 × 25.4 mm) — ever shows artwork. The
white Safety ID / PIN / QR column and the removable cover are always printed over the rest.

| Fit                        | Aspect  | Example sizes                            | Placed in                                          |
| -------------------------- | ------- | ---------------------------------------- | -------------------------------------------------- |
| **Panel** (recommended)    | 2.2 : 1 | viewBox `0 0 220 100`; PNG 1320 × 600 px | exactly the emergency panel: can't touch the ID/QR |
| Full sticker (still works) | 4.5 : 1 | viewBox `0 0 450 100`; PNG 2700 × 600 px | the whole unit; only its left 2.2 in shows         |

A full-sticker design whose panel is drawn even slightly wider than 2.2 in gets cut straight
through by the Safety ID column (the "overlap" admins saw), so the editor warns on every 4.5 : 1
design and recommends the panel fit. Templates for designers are linked in the editor
(`/print-templates/ozzo-emergency-panel-template.svg`, `…/ozzo-full-sticker-template.svg`); their
guides live in a `GUIDES_DELETE_BEFORE_EXPORT` layer, and an upload that still contains it is
refused so guides can never print. The preview's "Show Guides" outlines the visible artwork area.

### Layering: design on top (default for new designs)

`print_designs.artwork_on_top` (migration `20261027090000_print_design_artwork_on_top`):

| Setting                        | Drawing order                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **On top** (new designs)       | white Safety ID panel → **artwork** (clipped at the base / cover kiss cut) → white keep-clear boxes → ID, PIN, QR |
| Under the panel (old versions) | artwork (emergency zone only) → white Safety ID panel → ID, PIN, QR                                               |

On top, nothing of the design is cut by the Safety ID column. The **keep-clear boxes** (1.5 pt
white margin) cover the protected target (PIN + QR + 4-module quiet zone) and the rotated Safety ID
text, so those always scan and read whatever the artwork does; the QR is never covered. The cover
zone is never printed with base artwork (it is the separate removable cover). Every version created
before this setting keeps `false`, so batches already printed with it re-export identically. The
editor's "Design on top (recommended)" checkbox switches it (preview `?artworkOnTop=1|0`).

## 2. Data model

`print_artwork_files` (immutable, content-addressed): `storage_key` (`print-designs/<uuid>.svg|png`,
private), `format`, `original_filename` (sanitised, display only), `mime_type`, `sha256` (stored
bytes — for SVG the sanitized file; unique, dedupes uploads), `source_sha256` (file as uploaded),
`size_bytes`, `width_px`/`height_px` (PNG), `svg_view_box`, `effective_dpi` (PNG at 100 %),
`test_only`, `warnings`, `uploaded_by`. Every value is computed on the server.

`print_designs`: `family_id` + `version` (unique together), `name`, `status` (DRAFT / ACTIVE /
ARCHIVED), `artwork_type`, `base_artwork_file_id`, `cover_artwork_file_id`, `scale_percent`,
`offset_x_mm`, `offset_y_mm`, `validation_errors`, `validation_warnings`, `created_by_admin_id`,
`created_at`, `updated_at`, `activated_at`, `archived_at`. Partial unique index: at most one
ACTIVE design.

`safety_id_batches` + `print_design_id`, `print_design_version` (CHECK: both or neither). NULL =
the built-in layout (every batch created before Print Designs, or while no design is active).
Migration `20261016090000_phase9_print_designs`, additive only.

## 3. Versioning rules

- A version is **locked** once it is not a DRAFT or any batch uses it. Locked versions never
  change. `PATCH` on a locked version → `PRINT_DESIGN_LOCKED`; the editor offers **Save as New
  Version** (same family, next version, DRAFT).
- **Duplicate** creates a new family (`<name> (copy)`, v1, DRAFT); the source is untouched.
- **Activate** validates fully (files present with matching SHA-256, rules, a real sample PDF
  render), then the previous ACTIVE design becomes ARCHIVED and this one ACTIVE. Existing batches
  are not touched. Audited.
- **Archive**: not selectable for new batches; old batches still print with it. An archived
  version can be re-activated. Only an unused DRAFT can be deleted.
- **New batches** bind the requested design (ACTIVE or a valid DRAFT, never ARCHIVED) or, by
  default, the ACTIVE one. Helmet-batch companion Safety ID batches bind the ACTIVE design in the
  same transaction.
- **Exports** load the batch's own design version and re-hash its files. A missing or altered file
  fails with `PRINT_DESIGN_UNAVAILABLE`: "The print design used by this batch is unavailable." It
  never falls back to the current design.

## 4. SVG

Preferred format; stays **vector** in the PDF. Processing:

1. **Strict sanitizer** (`svg-sanitizer.ts`): parsed as XML. `<!DOCTYPE>`/`<!ENTITY>` (entity
   bombs, XXE), CDATA and processing instructions are refused before parsing. Only whitelisted
   elements (`svg g defs path rect circle ellipse line polyline polygon text tspan clipPath
linearGradient radialGradient stop`) and attributes (geometry, transform, presentation
   attributes, safe inline `style`) survive. **Rejected with a clear message** rather than
   silently dropped: `script`, `foreignObject`, `iframe`, `image`, `use`, `style` sheets, `a`,
   filters, masks, patterns, markers, symbols, animation, nested `<svg>`, event handlers (`on*`),
   `javascript:`/`data:`/`http(s):`/`file:` or protocol-relative references, `@import`, any
   non-local `url()`. Removed as inert: `metadata`, `title`, `desc`, Inkscape/Sodipodi/Sketch
   attributes. Every id is prefixed and local `#id`/`url(#id)` references rewritten. The stored
   file is a fresh serialisation of the whitelisted tree. Limits: 5 MB, 50,000 elements, depth 64
   (`PRINT_ARTWORK_SVG_MAX_BYTES`, `PRINT_ARTWORK_SVG_MAX_ELEMENTS`).
2. **Dimensions**: a numeric `viewBox` is required. Base artwork must be 2.2 : 1 (panel, e.g.
   `0 0 220 100`) or 4.5 : 1 (full sticker, `0 0 450 100`) within 1 %, otherwise it is rejected —
   never stretched.
3. **PDF**: rendered with svg-to-pdfkit into a **Form XObject** (vector), defined once per PDF and
   referenced by every unit (a 5,000-unit file embeds the artwork once). The renderer gets no
   image, document or font loaders: live text maps only to the PDF standard fonts (a warning
   suggests converting text to outlines). Nothing can trigger a network or file read (no SSRF).

The admin preview embeds the sanitized SVG inside an SVG served with
`Content-Security-Policy: default-src 'none'` and displayed through `<img>`.

## 5. PNG

- **Inspection** (`png-inspector.ts`): signature and IHDR are read from the raw bytes _before_
  decompression; a declared size above `PRINT_ARTWORK_PNG_MAX_PIXELS` (40 M) or 30,000 px per side
  is refused without allocating it (decompression bombs). 8-bit (palette ≤ 8-bit), non-interlaced
  only. Then a bounded full decode (sharp, `limitInputPixels`) rejects corrupt/truncated files,
  and pdfkit must be able to open it. Max 15 MB (`PRINT_ARTWORK_PNG_MAX_BYTES`).
- **DPI**: effective DPI = pixels ÷ printed inches on the lower axis, at the design's scale.
  Panel: minimum 660 × 300 px, recommended 1320 × 600 px. Full sticker: minimum 1350 × 300 px,
  recommended 2700 × 600 px (300 / 600 DPI). Labels: ≥ 600 DPI
  _Excellent_, ≥ 300 _Good_, below _Too low for production_. Enlarging the artwork lowers the
  DPI and is re-checked. Low-resolution uploads are refused unless a SUPER_ADMIN ticks
  "test-only": such artwork can be previewed and test-printed but never activated or used for a
  batch. Images are never upscaled.
- **PDF**: the original PNG bytes are embedded **once per PDF** (pdfkit image XObject, Flate,
  alpha kept as SMask), never JPEG-compressed, never resized, never re-encoded on upload, drawn at
  exactly its placed box.

## 6. Positioning

Scale (50–200 %, default 100), X and Y offsets (±25 mm, default 0). The target box (the
emergency panel for a 2.2 : 1 file, the unit for 4.5 : 1) is scaled around its centre and moved; the artwork is fitted into it **uniformly** (aspect ratio locked) and
clipped to the unit. There is no independent X/Y scale anywhere (unit tests check that the drawn
box always has the artwork's own aspect ratio). The editor shows the scaled physical size. Cover
artwork fills the cover print box uniformly, centred, edges clipped (a warning reports how much
is trimmed when its aspect differs by more than 5 %).

The ID, PIN, QR, quiet zone and cover target cannot be moved by Print Designs. Moving them would
need a separate _Advanced Print Layout Editor_ with its own validation (not built).

## 7. Previews, guides, test print

- **Preview Unit / Preview Sheet** (`GET /admin/print-designs/:id/preview/unit.svg|sheet.svg`):
  sample data (ID `SI-7958-72SA`, PIN `146628`, a QR to a non-existent sample token), produced by
  the same layout engine and display list as the production PDF (only the final drawing backend
  differs). Unsaved position values can be previewed (`scalePercent`, `offsetXMm`, `offsetYMm`).
- **Show Guides** (`guides=1`): sticker boundary, print safe area, white credential panel,
  dynamic ID area, protected target, QR + quiet zone, cover placement and cover cut. Never in
  production files.
- **Download Test Print** (`GET …/test-print.pdf`): one true-size 12 × 18 in sheet, 48 sample
  units, each marked **TEST PRINT** in red; never a real Safety ID or PIN. Audited.

## 8. API and permissions

| Endpoint                                                                                                    | Permission              |
| ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| `GET /admin/print-designs`, `/active`, `/:id`, previews, `test-print.pdf`                                   | `print-design:view`     |
| `POST /admin/print-designs/artwork` (multipart `file`, `role`, `testOnly`)                                  | `print-design:manage`   |
| `POST /admin/print-designs`, `PATCH /:id`, `POST /:id/new-version`, `/duplicate`, `/archive`, `DELETE /:id` | `print-design:manage`   |
| `POST /admin/print-designs/:id/activate`                                                                    | `print-design:activate` |
| `POST /admin/safety-id-batches` `{ printDesignId? }`                                                        | `safety-ids:generate`   |

Roles: SUPER_ADMIN all; ADMIN view / manage / activate; MANUFACTURING view (and choose a design
when creating a batch); SUPPORT and ANALYTICS_VIEWER none. Test-only uploads: SUPER_ADMIN only.

Errors: `INVALID_ARTWORK`, `PRINT_DESIGN_NOT_FOUND`, `PRINT_DESIGN_LOCKED`,
`PRINT_DESIGN_INVALID`, `PRINT_DESIGN_UNAVAILABLE`.

## 9. Audit

`print_design.artwork_uploaded` (format, role, sha256, source sha256, size), `.created`,
`.updated`, `.version_created`, `.duplicated`, `.activated` (previous active design/version),
`.archived`, `.deleted`, `.test_print` — each with design version and artwork SHA-256s. Batch
creation records `printDesignId`/`printDesignVersion`. Every print PDF export records `designId`,
`designVersion`, `designName`, `designSha256 { base, cover }`, the batch (entity id), the
exporting admin and time. Never a PIN.

## 10. Migration and the OZZO logo

Additive: no Safety ID, QR, PIN or ownership data changes. No design is seeded: the original OZZO
logo artwork is not in the repository, so the built-in layout can't be turned into a faithful
design without falsifying it. Existing batches keep `print_design_id = NULL` and print with the
built-in layout (production still requires `PRINT_LOGO_SVG_PATH` for those). **For new batches,
upload and activate a design that contains the approved OZZO logo** (first Z `#EC1C22` must be in
the source artwork; the engine never recolours uploaded designs).

## 11. Print-vendor considerations

Same as [SAFETY-ID-PRINT § 10](SAFETY-ID-PRINT.md#10-print-vendor-decisions-still-pending), plus
the in-house option: the editor's **Sheet layout** picks the sheet for Preview Sheet and the test
print. For your own printer + cutter use the 30-up layout (margins, 1.2 mm drawn bleed by edge
mirroring, registration marks, 100 mm scale bar; see
[SAFETY-ID-PRINT § 7](SAFETY-ID-PRINT.md#7-sheet-layout)). Also:
confirm the vendor RIP renders PDF Form XObjects with gradients/clip paths as in the proof (check
the test print); dark artwork next to the white credential panel shows trim drift at the
0.5 mm level — prefer artwork that doesn't depend on a hairline-exact edge there; on the 48-up
sheet (shared cut lines, no bleed) artwork reaching the unit edge shows drift as a sliver of the
neighbour, so prefer the 30-up cutter layout for full-bleed designs; RGB artwork colours are converted by the vendor's profile; live SVG text prints
with standard fonts (outline text before upload).
