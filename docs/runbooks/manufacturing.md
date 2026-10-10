# Runbook: manufacturing a batch (QR labels + activation PINs)

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
2. **Batch:** admin → Batches → New. Pick the model, manufacturing date and quantity.
3. **Generate:** press Generate. The job runs in the background. Wait for `COMPLETED`.
   Generation hashes each PIN with Argon2id, one at a time per API process
   (`ARGON2_MAX_CONCURRENCY=1`). Each hash costs about 150–200 ms of CPU, so expect several
   minutes per 1,000 helmets. This is an estimate from the login measurements, so time your
   first real batch. The limiter queue is FIFO, so a login waits behind at most the PIN hash in
   progress, not the whole batch. Generate large batches outside peak hours anyway.
4. **Export:** Batches → batch → Export manufacturing CSV
   (`helmetCode,serialNumber,model,batchCode,qrUrl,activationPin`). The export is audited
   (`batch.export.manufacturing_csv`). Transfer it to the printer over an encrypted channel (SFTP, or an
   encrypted archive whose password is sent separately). **Never email the plain CSV.**
5. **Print:** the QR code encodes `qrUrl`. The Helmet ID and Code128 barcode
   (`/admin/helmets/:id/barcode`) go inside the helmet. The PIN goes on the scratch-off or
   sealed card in the box, never on the outside.
6. **Quality check:** scan 5 random labels from the printed run. Each must open
   `/e/<token>` showing "not yet activated", and `/verify/<token>` must show the right model and
   Helmet ID.
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
