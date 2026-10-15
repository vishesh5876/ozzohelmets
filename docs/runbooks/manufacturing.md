# Runbook: manufacturing a batch (Safety ID QR labels + activation PINs)

Phase 9: every QR is a **Safety ID**. Helmet batches create one linked Safety ID per helmet by
default; stickers and cards come from standalone Safety ID batches (section below). Details:
[SAFETY-ID-MANUFACTURING](../SAFETY-ID-MANUFACTURING.md).

Who: users with `batches:write`, `batches:generate` and `export:manufacturing` (SUPER_ADMIN,
ADMIN). The manufacturing CSV contains **plaintext one-time activation PINs**. Treat it like
cash.

## Before the first production batch

- [ ] `PUBLIC_EMERGENCY_BASE_URL` is the final production domain (for example
      `https://safe.example.com`). **Every printed QR code encodes it permanently.** Changing the
      domain later means every label points at the old one. Keep that domain registered and
      redirecting forever.
- [ ] `PIN_HASH_PEPPER` is final and backed up offline. Rotating it after printing invalidates
      every unused PIN on every label.
- [ ] `PIN_ESCROW_KEYS` and `DATA_ENCRYPTION_KEYS` are backed up offline.
- [ ] A **physical test print** from this environment has been scanned with at least one iPhone
      and one Android phone (LAUNCH-CHECKLIST → physical QR test).

## Steps

1. **Model:** admin → Helmet models. Create or confirm the model and SKU (warranty months come
   from the model).
2. **Batch:** admin → Batches → New. Pick the model, manufacturing date and quantity. Keep
   **Generate a Safety ID for each helmet** ticked (default) unless these helmets get no QR.
3. **Generate:** press Generate. The job runs in the background. Wait for `COMPLETED`.
   Generation hashes each PIN with Argon2id, one at a time per API process
   (`ARGON2_MAX_CONCURRENCY=1`). Measured on a 4 vCPU development machine: about 27 PINs per
   second (5,000 in 188 s); time your first real batch on the production server. The limiter queue is FIFO, so a login waits behind at most the PIN hash in
   progress, not the whole batch. Generate large batches outside peak hours anyway.
4. **Export:** Batches → batch → Export manufacturing CSV
   (`helmetCode,serialNumber,model,batchCode,qrUrl,activationPin,safetyCode`; the first six
   columns are unchanged from Phase 8, `qrUrl` and `activationPin` belong to the linked Safety
   ID). The export is audited
   (`batch.export.manufacturing_csv`). Transfer it to the printer over an encrypted channel (SFTP, or an
   encrypted archive whose password is sent separately). **Never email the plain CSV.**
5. **Print:** the QR code encodes `qrUrl`. The Helmet ID and Code128 barcode
   (`/admin/helmets/:id/barcode`) go inside the helmet. The PIN goes on the scratch-off or
   sealed card in the box, never on the outside.
6. **Quality check:** scan 5 random labels from the printed run. Each must open
   `/e/<token>` showing "Safety ID not activated", and `/verify/<token>` must show the right
   model and Helmet ID.
7. **Mark printed:** Batches → batch → Mark printed. Helmets become `PRINTED`, and the PIN
   escrow is **purged**: PINs can no longer be exported, and the CSV shows an empty
   `activationPin`. Do this as soon as printing has been confirmed.
8. **Destroy** every copy of the CSV at the printer and on your machines. Record the date and
   who confirmed it.

## Problems

| Problem                                           | Action                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Generation `FAILED` (or interrupted by a restart) | API logs; press Generate again. It resumes the same batch (allowed from `PENDING`/`FAILED`).                                     |
| Need to reprint labels **before** mark-printed    | Export again (audited).                                                                                                          |
| Need to reprint labels **after** mark-printed     | QR codes and Helmet IDs can be re-rendered (`/admin/helmets/:id/qr`), but **PINs cannot**: generate a new batch for those units. |
| CSV leaked before the helmets were sold           | Treat as compromised: do not ship the batch; mark those helmets as deactivated/recalled; make a new batch.                       |
| A misprinted or unreadable QR on a sold helmet    | Support links a replacement helmet ([REPLACEMENT](../REPLACEMENT.md)), or re-renders the same QR as a sticker.                   |

## Internal acceptance-test helmets

Never use a customer's helmet for testing. Create test helmets under a dedicated model:

| Field       | Value                                             |
| ----------- | ------------------------------------------------- |
| Model name  | `OZZO INTERNAL TEST`                              |
| SKU         | `OZZO-INTERNAL-TEST` (must match exactly)         |
| Batch notes | `TEST-ACCEPTANCE-001` (and so on), what it is for |

Helmets of this SKU work exactly like real ones, but they are left out of platform analytics
(`ANALYTICS_EXCLUDED_MODEL_SKUS`, default `OZZO-INTERNAL-TEST`). The marker is never shown on
public pages. Risk alerts caused by staff scanning test helmets can be closed with **Dismiss as
internal acceptance test** (kept in the alert history and the audit log). Keep one activated
test helmet with a synthetic emergency profile for the external uptime monitor and
`scripts/production-smoke.sh` (`TEST_TOKEN`).

## Physical Activation PIN presentation: open decision

The physical format of the Activation PIN is **not decided yet** and does not block the pilot.
Whatever is chosen must keep the PIN hidden until purchase, be tamper-evident, be readable once
uncovered, and never appear on the outside of the box or in the QR code.

| Option                                               | Pros                                      | Cons / risks                                                 |
| ---------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Scratch-off panel on a card in the box               | familiar, tamper-evident, cheap at volume | needs a specialist printer; scratching can damage characters |
| Sealed / folded card (security envelope)             | simple printing, no special ink           | envelopes can be steamed open and resealed                   |
| Protected sticker inside the helmet (peel-off cover) | stays with the helmet, hard to lose       | applied at the factory; a careless reseller could peel it    |
| Printed inside the packaging (e.g. under a flap)     | no extra part                             | packaging is often thrown away before activation             |

For the pilot (10–20 internal helmets) a sealed card is enough. Record the final decision here
and in the manufacturing contract.

## Print design (artwork)

Before a production run, check Admin → **Print Designs**: the ACTIVE design contains the approved
OZZO artwork, shows _VECTOR_ or ≥ 300 DPI, and its **Download Test Print** sheet has been printed
and scanned. New batches bind the active design version (or the one chosen in **New Safety ID
batch**); the batch page shows it under _Print Design_. See [PRINT-DESIGNS](../PRINT-DESIGNS.md).

## Standalone Safety IDs (stickers, cards)

1. Admin → **Safety ID Batches** → **New Safety ID batch** → mode _Standalone_, quantity, notes →
   **Create and generate**. Wait until the batch shows all Safety IDs generated.
2. Review the **Print sheets** card: sheet count (`ceil(units / 48)`, last sheet units), the
   48-up warning, **Preview unit** / **Preview sheet** (sample data) and the vendor layout
   (defaults: 12 × 18 in, 4 × 12, no margins/gutters). The OZZO logo asset must show as loaded.
3. **Export CSV** (`safetyCode,publicQrUrl,activationPin,qrPayload,batchCode,unitIndex,sheet,sheetRow,sheetColumn,linkedHelmetCode,linkedHelmetSerial,model`;
   import `activationPin` as **text** — six digits with leading zeros) and **Download 12 × 18
   Print PDF** (true size: print at 100 %, never "fit to page"). Send **Download cut guide** if
   the vendor needs the die lines. Both PIN files are audited: same handling as above.
4. Physical QA on the first real sheet: measurements, cover fit and the five-point scan test
   ([SAFETY-ID-PRINT § 9](../SAFETY-ID-PRINT.md#9-physical-qa-required-before-mass-production)).
   Reprints with the same PINs are possible until step 5.
5. **Mark printed** → confirm "Printing completed?" (escrow destroyed for good, Safety IDs become
   activatable; downloading never does this). Destroy the files.

For an existing helmet batch made without Safety IDs: Safety ID Batches → New → mode _For an
existing helmet batch_ → pick the batch. Each helmet without a Safety ID gets one.
