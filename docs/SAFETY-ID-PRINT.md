# Safety ID print: 4.5 × 1 in sticker, six-digit PIN, 12 × 18 in 48-up

Final physical product and print engine for Safety IDs (Phase 9 final print update). Supersedes
the A4 HTML print sheet. Domain rules: [SAFETY-ID](SAFETY-ID.md) · workflow:
[SAFETY-ID-MANUFACTURING](SAFETY-ID-MANUFACTURING.md) · operator steps:
[runbooks/manufacturing.md](runbooks/manufacturing.md).

> **Not print-ready for mass production yet.** That status requires one real 12 × 18 in sheet
> printed on the production material, measured, covered/uncovered and scanned
> ([§ 9](#9-physical-qa-required-before-mass-production)), and the original OZZO logo vector
> ([§ 5](#5-ozzo-logo-asset)). Neither has happened.

## 1. The product: one unit, three zones

One Safety ID = **one 4.5 × 1 in unit on one liner** (324 × 72 pt). The removable yellow cover is
**inside** that unit; the unit is not 5.5 in.

```
┌──────────────────────┬──────────────┬──────────────┐
│ [OZZO]               │ I PIN: 146628│  ┌────────┐  │
│ IN CASE OF           │ D ┌────────┐ │  │ REMOVE │  │
│ EMERGENCY            │ : │   QR   │ │  │ONLY IN │  │
│ FOR MY MEDICAL INFO  │ S │        │ │  │EMERGENC│  │
│ (SCAN ME) ────────►  │ I └────────┘ │  │ ▲ OPEN │  │
│                      │              │  └────────┘  │
└──────────────────────┴──────────────┴──────────────┘
  emergency 2.20 in     credential     cover zone
                        1.15 in        1.15 in
```

| Zone             | Size (in)   | Size (mm)     | Content                                                                  |
| ---------------- | ----------- | ------------- | ------------------------------------------------------------------------ |
| Emergency panel  | 2.20 × 1.00 | 55.88 × 25.40 | OZZO logo, IN CASE OF / EMERGENCY, FOR MY MEDICAL INFORMATION, SCAN ME → |
| Credential panel | 1.15 × 1.00 | 29.21 × 25.40 | `ID: SI-XXXX-XXXX` (rotated, stays visible), `PIN: 146628` above the QR  |
| Cover zone       | 1.15 × 1.00 | 29.21 × 25.40 | Yellow removable cover (own kiss cut) with emergency instructions only   |
| **Unit**         | **4.5 × 1** | 114.3 × 25.4  | Emergency + credential = permanent base sticker; cover = peel-off piece  |

Installation: apply the base sticker (emergency + credential panels), peel the yellow cover from
the right-hand zone and stick it over the PIN + QR, lining it up with the four grey corner marks
(they disappear under a correctly placed cover). In an emergency: remove cover → QR visible →
scan → emergency information.

All numbers are derived in code (`apps/api/src/modules/print/sticker-layout.ts`) from the design
constants in `sticker-design.ts`, validated by `geometryIssues()` and asserted by unit tests.
Physical QA adjustments are made **only** in `sticker-design.ts`; the unit is never scaled.

### Design decision: rotated Safety ID

The spec's example shows a short numeric `ID: 795872` above the PIN. Real Safety IDs are
`SI-XXXX-XXXX` (12 characters, unchanged Phase 9 architecture). Above the PIN, that line plus the
cover overlap leaves no room for a scannable QR in 1 inch. The Safety ID is therefore printed
rotated along the left edge of the credential panel, outside the cover footprint, so it stays
visible after installation (spec § 14 preferred layout) while the QR gets the full height.

## 2. Final dimensions (default safe area 2 mm)

| Item                                | Value                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Unit                                | 114.30 × 25.40 mm (324 × 72 pt)                                                          |
| Protected target (PIN + QR + QZ)    | **19.15 × 21.40 mm** at x 61.99, y 2.00 mm from the unit's top-left                      |
| QR incl. quiet zone                 | **19.15 × 19.15 mm** (0.754 in)                                                          |
| QR symbol (version 5, 37 × 37)      | 15.75 mm, module **0.43 mm**                                                             |
| Quiet zone                          | **4 modules = 1.70 mm** each side (solid white, nothing intrudes)                        |
| Applied cover footprint on the base | 22.15 × 24.40 mm at x 60.49, y 0.50 mm                                                   |
| Removable cover (die line)          | **22.15 × 24.40 mm**, corner radius 1 mm, centred in the cover zone (x 88.62, y 0.50 mm) |
| Cover overlap beyond the target     | **1.5 mm** every side                                                                    |
| Cover yellow ink                    | die + 1 mm bleed (clamped to the cover zone): 24.15 × 25.40 mm                           |
| Cut tolerance assumed               | 0.5 mm (cover and quiet zone keep ≥ 0.5 mm from every cut)                               |
| Safe area (text/logo)               | 2 mm from every cut edge (configurable 1–4 mm)                                           |

QR version depends on the URL length: `https://ozzohelmets.cloud/e/<22>` (50 chars) and anything
up to ~60 bytes is version 5 at error correction Q. A longer `PUBLIC_EMERGENCY_BASE_URL` raises
the version and shrinks the modules; the engine refuses modules below 0.33 mm.

## 3. Cover fit (how it is guaranteed)

- Target = PIN text top → QR quiet-zone bottom, QR width. Cover = target + overlap on every side
  (`coverDie.w = target.w + 2 × 1.5 mm`), so a centred cover covers the whole QR, its quiet zone
  and the PIN.
- The applied cover stays ≥ 0.5 mm inside the base sticker (never overhangs), right of the
  Safety ID and clear of the emergency panel.
- The cover die sits in the cover zone ≥ 0.5 mm from every through-cut and from the base | cover
  kiss cut.
- The cover carries only `REMOVE / ONLY IN / EMERGENCY / ▲ OPEN` (no PIN, QR, Safety ID, helmet
  or medical data) — asserted by a unit test.

Assumptions to confirm physically: hand placement within ±1.5 mm (the overlap); cover material
opaque enough that the QR cannot be scanned through it; adhesive removable without damaging the
QR.

## 4. QR

- Content: exactly the Safety ID's public URL (`publicHelmetUrl(publicToken)` = CSV
  `publicQrUrl` = `qrPayload`). No decorative or sample QR in production files (previews use a
  non-existent sample token and are never exported).
- Vector: dark-module runs as filled rectangles; black on a solid white backing; no logo, colour,
  gradient or artwork behind or over it. Error correction **Q** (~25 %).
- Unit tests decode the rendered QR (rasterised) and compare it with the URL.

## 5. OZZO logo asset

> **Superseded for new batches by [Print Designs](PRINT-DESIGNS.md):** the approved logo is part
> of the admin-uploaded artwork. This section applies to the built-in layout, which batches
> without a print design (all batches created before Print Designs) keep using.

**Status: the original OZZO artwork was not in the repository, so it has not been supplied to the
print engine.** The engine never redraws or approximates the mark. Until the asset is configured:

- production (`NODE_ENV=production`): print PDFs are refused with `PRINT_LOGO_MISSING`;
- development/test: a dashed box reading "LOGO ASSET MISSING" marks the logo position;
- the admin batch page shows a red warning.

Preparing the asset (from the original vector artwork, e.g. Illustrator/AI/EPS/PDF):

1. Outline all text and strokes; release clipping masks; expand appearance.
2. Export as SVG with **transforms applied to coordinates** (no `transform=`), `viewBox` set,
   paths only.
3. Give each letter's path(s) an id: `ozzo-o1`, `ozzo-z1`, `ozzo-z2`, `ozzo-o2` (more paths per
   letter allowed: `ozzo-o1-counter`). Use `fill-rule="evenodd"` where the source does.
4. Set `PRINT_LOGO_SVG_PATH` to the file. The loader rejects transforms, strokes, non-path shapes,
   unknown ids or a missing letter, so a bad export cannot silently distort the mark.

Colour treatment applied by the engine (source fills are ignored): **O black, first Z `#EC1C22`,
second Z black, O black**. Scaling is uniform (11 pt logo height, width from the artwork's
aspect ratio). `GET /admin/safety-id-print/status` and the print audit record the asset's SHA-256
so QA can confirm which artwork was printed. `apps/api/test/fixtures/print/test-logo-fixture.svg`
is four plain blocks for tests only — never use it for production.

## 6. Colours, fonts

| Name                   | PDF (RGB)                        | CMYK reference (confirm with vendor)          |
| ---------------------- | -------------------------------- | --------------------------------------------- |
| OZZO red               | `#EC1C22`                        | 0 / 100 / 100 / 0 (≈ #ED1C24)                 |
| Black                  | `#000000`                        | 0 / 0 / 0 / 100 (QR: plain K, not rich black) |
| White                  | `#FFFFFF`                        | substrate (no white ink)                      |
| Cover yellow           | `#FFD100` (`PRINT_COVER_YELLOW`) | ≈ Pantone 109 C / 0 / 16 / 100 / 0            |
| Corner marks / divider | `#8C8C8C`, `#BDBDBD`             | K 55 / K 30                                   |

The PDF is RGB with solid fills (no gradients, no transparency). If the vendor needs CMYK or a
PDF/X file, convert with their profile in their RIP and check that the QR stays 100 K and the
red/yellow match the references above. Fonts: PDF base-14 Helvetica / Helvetica-Bold (not
embedded, metric-compatible substitutes everywhere). If the vendor requires embedded fonts, set
`PRINT_FONT_REGULAR_PATH` / `PRINT_FONT_BOLD_PATH` to licensed TTF/OTF files; layout is measured
with the same fonts.

## 7. Sheet layout

Default preset `12x18_48UP`: 18 × 12 in landscape (1296 × 864 pt), 4 columns × 12 rows =
**48 complete units** (each with its cover), margins 0, gutters 0, bleed 0.

> 48-up uses the full 12 × 18 inch sheet with shared cut lines. Confirm your print vendor's
> trimming/bleed requirements.

- Configurable per download (admin "Print vendor layout", or query fields on the endpoints):
  sheet width/height, unit width/height, columns, rows, outer margin X/Y, gutters, bleed, safe
  area. Unit must stay 4.5 × 1 in; any layout that doesn't fit, or bleed without room (zero
  gutter ⇒ bleed 0), is a validation error (`PRINT_LAYOUT_INVALID`). Labels are never scaled.
- Placement: row-major from the top-left at `outerMargin + index × (unit + gutter)`; leftover
  sheet space goes right/bottom.
- Sheets = `ceil(units / 48)`. Positions after the last unit stay blank; nothing is duplicated.
  Examples: 48 → 1; 49 → 2; 96 → 2; 100 → 3 (48 + 48 + 4); 1000 → 21 (20 full, last 40);
  5000 → 105 (last 8).
- Order: Safety ID batch → `unit_index` ascending (1-based, set at generation; existing rows were
  backfilled in their previous export order). CSV rows = PDF positions (`sheet`, `sheetRow`,
  `sheetColumn` columns).

## 8. Cut / trim assumptions and the cut guide

- Through-cut (trim) on the unit grid; with zero gutter neighbouring units **share** one cut line
  (13 horizontal + 5 vertical lines for 48-up, each drawn once).
- Kiss cuts per unit: the base | cover split (vertical line at 3.35 in) and the rounded cover
  outline. The cover zone outside the cover is weeded matrix.
- The artwork PDF contains **no** cut marks. `Download cut guide` (`/admin/safety-id-print/cut-guide.pdf`)
  is a separate sheet-size PDF with spot colours `ThroughCut` and `CutContour` (rename to the
  vendor's convention). A proof PDF (`print.pdf?proof=1`, filename `-PROOF`) overlays the cut
  lines and outlines target/cover for QA only.
- Artwork near edges is white except the cover zone's yellow, which may reach the unit's top and
  bottom edge — those neighbours are other units' cover zones/matrix, so trim drift there is
  invisible.

## 9. Physical QA (required before mass production)

A PDF or screen check is **not** sufficient. Print one full 12 × 18 sheet on production material
and record results in the release notes.

**Measure** (calipers / steel rule): unit 114.3 × 25.4 mm (4.5 × 1 in); credential panel and cover
zone 29.2 mm; cover 22.15 × 24.4 mm; QR incl. quiet zone 19.15 mm; target 19.15 × 21.4 mm.

**Cover fit** (≥ 5 units): cover width/height vs target width/height; cut tolerance (die drift);
adhesive positioning by hand with the corner marks. **Fail** if the QR or quiet zone shows, the
PIN shows, the cover overlaps the emergency text or the Safety ID, the cover damages or leaves
residue on the QR, or the QR does not scan after removal.

**Five-point scan test** (at least three phones, iOS and Android, native camera): top-left,
top-right, centre, bottom-left, bottom-right units. For each: QR scans; the correct Safety ID
opens (compare with `ID:` and the CSV row); the printed PIN matches the CSV; nothing clipped; the
cover peels; the cover fully hides PIN + QR when applied; scan again after removal.

Checklist record: sheet/batch, material, printer, date, measurements, per-position results,
phones/OS, pass/fail, photos. Only then can the batch be marked printed and production be
called print-ready.

## 10. Print vendor decisions still pending

Software does not decide adhesive chemistry or material. Ask the vendor:

- Removable cover adhesive (clean removal, no residue on the QR) and cover **opacity** (QR must
  not scan through it).
- Permanent base adhesive; helmet-surface compatibility (painted ABS/polycarbonate, curvature).
- Water, UV and heat resistance; laminate (matte vs gloss — gloss can glare for scanners).
- Trim/die tolerance and whether 48-up with shared cut lines and zero bleed is acceptable; minimum
  distance between kiss cut and through cut (design assumes 0.5 mm).
- Cut-file conventions (spot names, separate file vs layer), PDF/X / CMYK profile, embedded fonts.
- Exact cover yellow (Pantone/CMYK) and red match to `#EC1C22`.
- "Dry edge" / unadhesived OPEN tab feasibility for the cover's bottom band.

## 11. Security of print files

Print PDFs and CSVs contain Activation PINs: `safety-ids:export` permission; every export audited
before data is sent (counts, sheets, layout, logo hash — never a PIN); `Cache-Control: no-store`,
attachment download, no public URL; streamed from memory (no temporary file, nothing persisted);
PINs never logged. After **Mark printed** the escrow is purged and PIN-bearing reprints are
refused (`PIN_ESCROW_PURGED`); a different PIN is never generated silently. Previews and the cut
guide contain no PIN.
