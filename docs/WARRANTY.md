# Warranty

Phase 4. A warranty covers **one physical helmet**, not a person. It is registered by the owner,
survives ownership transfers, and is computed entirely on the server from the helmet model's
policy. It is **customer-driven**: the owner declares how and where they bought the helmet. There
is no retailer/dealer entity ([ADR-001](ADR-001-no-retail-inventory.md)) and no claims or
service-centre workflow yet.

## Model policy

`helmet_models.warranty_enabled` (default `true`) and `warranty_months` (default 24, CHECK 0–240)
are edited in the admin model form. A model with the warranty disabled (or 0 months) cannot be
registered (`409 WARRANTY_NOT_AVAILABLE`). Changing a model's term does **not** retroactively
change existing warranties; corrections are explicit per helmet.

## Data

| Table               | Purpose                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `helmet_warranties` | One row per helmet (unique `helmet_id`): purchase date, start/end, stored status, source, registrant, private purchase details, proof key, void fields, replacement link |
| `warranty_history`  | Append-only events (`REGISTERED`, `DATE_CORRECTED`, `ADMIN_UPDATED`, `VOIDED`, `RESTORED`, `REPLACED`, `ISSUED_FOR_REPLACEMENT`, `PROOF_UPLOADED`, `PROOF_REMOVED`)      |

Database CHECKs: start ≤ end and purchase ≤ start; `VOID ⇔ void_reason/voided_at set`; proof key,
content type and upload time all set or all null.

## Status

Stored: `ACTIVE`, `VOID`, `REPLACED`, `CANCELLED` (`EXPIRED` exists in the enum for future use).
Effective status is **derived on read** — there is no cron:

- no row → `NOT_REGISTERED`
- `ACTIVE` and `warranty_end_date` < today (UTC) → `EXPIRED`
- otherwise the stored status.

The admin list filter uses the same rule in SQL (status + date), so "Expired" lists are exact.

## Dates (`WarrantyPolicyService`)

- Coverage starts on the purchase date and **ends on the last covered day**:
  `end = purchaseDate + months − 1 day` (3 Oct 2026 + 24 months → 2 Oct 2028). Month arithmetic
  clamps to month end (31 Jan + 1 month → 28/29 Feb).
- Purchase date may not be in the future (tolerance `WARRANTY_PURCHASE_DATE_TOLERANCE_DAYS`, default
  1, for time zones) nor before the helmet's batch manufacturing date
  (`400 INVALID_PURCHASE_DATE`).
- All dates are `DATE` columns handled as UTC calendar days; the browser never computes coverage.

## Customer registration

`POST /customer/helmets/:id/warranty { purchaseDate, purchaseChannel?, sellerName?, sellerCity?, invoiceNumber?, notes? }`

- Only the **current owner**, and only while the helmet is `ACTIVATED`, `ACTIVE`, `LOST`, `STOLEN`,
  `DAMAGED` or `RECALLED` (`409 WARRANTY_NOT_REGISTRABLE` otherwise).
- Helmet + ownership rows are locked (helmet → ownership order) and `helmet_id` is unique, so two
  concurrent submissions can't create two warranties. A repeated submit **with the same purchase
  date** returns the existing record (idempotent); anything else → `409 WARRANTY_ALREADY_REGISTERED`.
- Free text is trimmed, control characters stripped, lengths limited.
- Purchase channel: `BRAND_WEBSITE`, `DEALER`, `MARKETPLACE`, `RETAIL_STORE`, `OTHER` — a
  customer-declared label only. The seller is free text (`sellerName`, `sellerCity`); there is no
  seller/organisation link and none is planned.

## Proof of purchase

`POST|GET|DELETE /customer/helmets/:id/warranty/proof` (multipart field `proof`).

- JPEG, PNG, WebP or PDF, up to `WARRANTY_PROOF_MAX_BYTES` (10 MB). Validated by **content**, not
  by extension or declared type: images are fully decoded and re-encoded to WebP (metadata incl.
  GPS stripped, input pixel limit, max 2400 px); PDFs must start with `%PDF-`, end with `%%EOF`
  and contain no JavaScript, launch actions, embedded files or rich media — they are stored as-is
  and only ever served as downloads.
- Stored privately under a random key (`warranty-proofs/<uuidv7>.<ext>`) through the file-storage
  abstraction; never public, never in the cache, never in logs or audit metadata.
- Downloads are sent as attachments with `X-Content-Type-Options: nosniff` and a locked-down CSP.
- Customer access: the **registrant while they still own the helmet** only.
- Admin access: `warranty:document-view` (SUPER_ADMIN, SUPPORT), audited as
  `warranty.proof_viewed` on every download.

## Transfer inheritance

The warranty stays with the helmet when it is transferred:

- The new owner sees status, purchase date and coverage dates.
- The previous owner's **private details** (channel, seller, city, invoice number, notes) and the
  **proof document** are hidden from every later owner, and the proof endpoints return 404 for
  them. The portal says: "Purchase details and documents from a previous owner are private and not
  shown."
- The previous owner loses all access to the helmet's warranty with the ownership.

## Replacement policy

When support links a replacement (Phase 3 replacement flow), inside the same transaction:

- the original warranty becomes `REPLACED` (history + audit);
- unless the replacement helmet already has its own warranty, a new one is issued
  (`source = REPLACEMENT`, `replacement_of_warranty_id` → original) with coverage per
  `WARRANTY_REPLACEMENT_POLICY`:
  - `INHERIT_END_DATE` (default) — from the link date to the **original end date**; a
    replacement never extends coverage;
  - `NEW_TERM` — a full model term from the link date;
  - an admin `replacementWarrantyEndDate` override on the replacement request wins over both
    (cannot be in the past).
- `VOID`, `CANCELLED` or already `REPLACED` warranties are never inherited. Invoice and proof are
  never copied.

## Admin

Pages: **Warranties** (search by Helmet ID, Customer ID, serial or invoice number; filter by
effective status) and **Warranty detail** (coverage, owner/registrant Customer IDs, private
details, audited proof download, full history).

| Action  | Endpoint                                                                                                                                | Permission               | Notes                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List    | `GET /admin/warranties?search&status&page&pageSize`                                                                                     | `warranty:view`          |                                                                                                                                                                        |
| Detail  | `GET /admin/warranties/:id`                                                                                                             | `warranty:view`          | includes history                                                                                                                                                       |
| Correct | `PATCH /admin/warranties/:id { purchaseDate?, startDate?, endDate?, purchaseChannel?, sellerName?, invoiceNumber?, reasonCode, note? }` | `warranty:manage`        | reason ∈ CUSTOMER_REQUEST, DATA_ENTRY_ERROR, DOCUMENT_VERIFIED, REPLACEMENT_ADJUSTMENT, OTHER; a new purchase date recomputes coverage unless explicit dates are given |
| Void    | `POST /admin/warranties/:id/void { reason, note? }` + `X-Recent-Auth`                                                                   | `warranty:void`          | reason ∈ INVALID_PURCHASE, TAMPERED_PRODUCT, DUPLICATE_REGISTRATION, ADMIN_CORRECTION, OTHER; from ACTIVE/EXPIRED                                                      |
| Restore | `POST /admin/warranties/:id/restore { note? }`                                                                                          | `warranty:void`          | VOID → ACTIVE (expiry still derived from the end date)                                                                                                                 |
| Proof   | `GET /admin/warranties/:id/proof`                                                                                                       | `warranty:document-view` | audited                                                                                                                                                                |

Nothing is ever deleted. Every change writes `warranty_history` (dates old → new; free-text fields
recorded **by name only**) and an audit entry (`warranty.registered`, `warranty.updated`,
`warranty.voided`, `warranty.restored`, `warranty.proof_uploaded`, `warranty.proof_viewed`,
`warranty.proof_removed`). Every change also invalidates the public verification cache.

## Public exposure

The public verification page shows only the effective status and end date — never purchase
details, the registrant or the document. See [PRODUCT-AUTHENTICITY](PRODUCT-AUTHENTICITY.md).

## Phase 5 notes

- Customer dashboard shows a warranty summary (active / expired / not registered) and a
  "Warranty not registered" notice per in-service helmet; the portal has a Warranty overview page.
- The customer data export includes warranties for owned helmets; purchase details only where the
  customer was the registrant.
- The admin customer view shows the number of warranties the customer registered and each owned
  helmet's warranty status. No claims workflow yet.
