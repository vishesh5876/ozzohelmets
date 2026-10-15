# Safety ID manufacturing: generate, export, print

How Safety IDs (QR + one-time six-digit Activation PIN) are produced. Physical product, geometry,
print engine and QA: [SAFETY-ID-PRINT](SAFETY-ID-PRINT.md). Step-by-step operator checklist:
[runbooks/manufacturing.md](runbooks/manufacturing.md). Domain rules: [SAFETY-ID](SAFETY-ID.md).

## 1. Two ways to make Safety IDs

| Way                                                                           | Result                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Helmet batch** with "Generate a Safety ID for each helmet" (default **on**) | One Safety ID per helmet, created and linked in the same chunk transaction as the helmet. A companion Safety ID batch (`HELMET_LINKED`) is created with the helmet batch and completes with it. |
| **Safety ID batch, STANDALONE**                                               | Stickers / cards with no helmet. Admin → Safety ID Batches → New → quantity.                                                                                                                    |
| **Safety ID batch, HELMET_LINKED** for an existing helmet batch               | One Safety ID for each helmet of that batch that has none yet (for example a batch created with the option off).                                                                                |

A helmet batch created with the option **off** produces helmets with no QR and no PIN (product
identity only); add Safety IDs later with a HELMET_LINKED batch.

## 2. Generation

A durable, resumable chunked job started by the API (same pattern as helmet batches):

- `POST /admin/safety-id-batches/:id/generate` claims the batch atomically (`PENDING`/`FAILED` →
  `GENERATING`), so two clicks or two API instances never generate twice.
- Each chunk (`BATCH_GENERATION_CHUNK_SIZE`) prepares random codes, tokens and six-digit PINs
  (`crypto.randomInt`, zero-padded strings), assigns `unit_index` (1-based, contiguous: the print
  order), hashes the
  PINs (Argon2id + `PIN_HASH_PEPPER`, through the per-process Argon2 limiter), encrypts each PIN
  into the escrow (AES-256-GCM, `PIN_ESCROW_KEYS`, AAD = Safety ID id), then inserts the chunk
  and advances `generated_count` in one transaction. A unique-identifier collision retries the
  chunk with fresh identifiers.
- Progress lives in Postgres; the admin page polls it. On boot, a batch left `GENERATING` by a
  crashed process is marked `FAILED`; "Resume generation" continues from `generated_count`.
- For a linked Safety ID the helmet mirrors the Safety ID's public token and PIN hash (one PIN
  hash per helmet; a Phase 8 build could still serve it after a rollback).

Measured on the development container (4 vCPU): 5,000 standalone Safety IDs in 188 s (about 27
PINs/s; PIN Argon2 19 MiB, t=2, `ARGON2_MAX_CONCURRENCY=1`). Time your first production batch;
generate large batches outside peak hours.

## 3. Export and print

PIN-bearing exports exist only while the batch is **not printed** and the escrow still holds the
PINs. Order everywhere: unit index ascending; CSV rows = PDF positions for the same layout.

| Export                                                                 | Content                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safety ID CSV `…/export/safety-ids.csv`                                | `safetyCode,publicQrUrl,activationPin,qrPayload,batchCode,unitIndex,sheet,sheetRow,sheetColumn,linkedHelmetCode,linkedHelmetSerial,model` (helmet columns empty for standalone; import `activationPin` as text) |
| Print PDF `…/export/print.pdf`                                         | True-size vector PDF, default 12 × 18 in, 48 × 4.5 × 1 in units (sticker + integrated yellow cover). Refused after escrow purge (`PIN_ESCROW_PURGED`). `?proof=1` adds QA guides.                               |
| Cut guide `/admin/safety-id-print/cut-guide.pdf`                       | One sheet of die lines (`ThroughCut`, `CutContour` spot colours), no artwork, no PINs                                                                                                                           |
| Helmet manufacturing CSV `/admin/batches/:id/export/manufacturing.csv` | Phase 8 columns unchanged (`helmetCode,serialNumber,model,batchCode,qrUrl,activationPin`) + `safetyCode` appended; `qrUrl` and `activationPin` are the linked Safety ID's                                       |

Security of every export:

- `safety-ids:export` permission (SUPER_ADMIN, ADMIN, MANUFACTURING).
- Audited with the number of PINs included (`X-Pins-Included` header); export count and last
  export time shown on the batch page ("Exported for printing" PIN state).
- `Cache-Control: no-store`, `Content-Disposition: attachment`; streamed from memory (no temp
  file, nothing persisted); PINs never logged or put in audit metadata.
- Transfer to the printer encrypted (SFTP or an encrypted archive). Never email the plain file.

## 4. Mark printed (escrow purge)

`POST /admin/safety-id-batches/:id/mark-printed` (or marking the helmet batch printed, which
also marks its companion Safety ID batch): `GENERATED` Safety IDs become `PRINTED` (now
activatable) and **every escrowed PIN of the batch is deleted** in the same transaction. After
that, exports contain no PINs and lost PINs cannot be recovered: generate new Safety IDs for
those units. Mark printed only after the physical sheets were printed and checked — downloading
the PDF never marks anything printed; the admin asks "Printing completed?" first. Before the
purge a reprint with the same PINs is possible; after it a PIN-bearing reprint is impossible and
no different PIN is ever generated silently (a re-issue workflow would be a separate feature).

## 5. PIN states (admin)

| State                  | Meaning                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| Available for printing | escrow present, never exported                                           |
| Exported for printing  | escrow present, exported at least once                                   |
| Unused · escrow purged | batch marked printed; only the hash remains, the printed PIN still works |
| Consumed               | used for activation; escrow gone                                         |

The PIN itself is never shown in the admin UI or API responses.

## 6. Quality check

Every run: the five-point scan test (top-left, top-right, centre, bottom-left, bottom-right
units of a sheet, several phones) and the cover-fit checks in
[SAFETY-ID-PRINT § 9](SAFETY-ID-PRINT.md#9-physical-qa-required-before-mass-production). Each
scanned unit: `/e/<token>` must show "Safety ID not activated" with
"Activate Safety ID"; `/verify/<token>` must show "Safety ID verified" (standalone: "No
registered product is currently linked to this Safety ID."; linked: the right model and Helmet
ID).
