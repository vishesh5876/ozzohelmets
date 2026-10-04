# Product authenticity

Phase 4 adds a public **product verification** page and anonymous **product reports**. This is a
foundation for anti-counterfeit work, not a counterfeit detector. The page shows **manufacturer
registry facts only** (Helmet ID, model, manufacture date, lifecycle label, warranty status) —
never retailer, distributor, seller or supply-chain information, and never owner data.

## What a successful check means — and what it doesn't

A QR code is just a URL. Anyone can photograph a genuine label and print it on another helmet. So
a match proves only that **this Helmet ID exists in the manufacturer's registry**; it does **not**
prove that the shell in front of you is the helmet that ID was issued to. The page says exactly
that:

> ✓ Product identity verified — this Helmet ID exists in the manufacturer's registry. This
> confirms the registered identity, not the physical helmet itself.

The page never says "genuine", "authentic helmet" or "counterfeit". An unknown or malformed token
shows:

> **We could not verify this Helmet ID.** Check the QR code or contact support.

(A failed lookup can be a damaged sticker, a typo or an old printout — never an accusation.)
Clone signals (scan velocity, impossible travel, many devices) are Phase 6 work on top of the
`helmet_scans` telemetry recorded here.

## Endpoint

`GET /public/verify/:token` (no auth, public throttler policy) →

```jsonc
// VERIFIED
{
  "state": "VERIFIED",
  "message": "Product identity verified: …",
  "product": { "helmetCode": "HM-…", "modelName": "…", "brand": "…", "sku": "…", "manufactured": "2026-09", "batchRef": "…" },
  "lifecycle": { "label": "In service", "warning": null },
  "activated": true,
  "warranty": { "status": "ACTIVE", "endsOn": "2028-09-14" } | null,
  "recallWarning": null
}
// NOT_VERIFIED (unknown or malformed token)
{ "state": "NOT_VERIFIED", "message": "We could not verify this Helmet ID. Check the QR code or contact support." }
```

Never included: owner, Customer ID, internal UUIDs, serial number, PIN material, purchase details,
invoice, proof, emergency data. Lifecycle labels: Not yet activated / In service / Reported lost /
Reported stolen / Marked damaged / Replaced / No longer active / Recalled, with the matching
warning. `recallWarning` is the recall-ready contract (set for `RECALLED` helmets; a recall
campaign entity is future work).

- **Cache**: VERIFIED responses are cached in Redis (`public-verify:v1:<token>`) and invalidated
  together with the emergency cache on every lifecycle, ownership, warranty or model change.
  NOT_VERIFIED responses are not cached.
- **Telemetry**: each lookup of a known token logs a deduplicated `VERIFY` scan (hashed IP, UA,
  country) next to the existing `EMERGENCY_PAGE` scans (enum value present since Phase 1).

## Pages

The standalone, framework-free emergency bundle serves both `/e/:token` (emergency) and
`/verify/:token` (verification); nginx routes `^~ /verify/` to `emergency.html`. The emergency
page links to "Verify product identity" and the verification page links back to "Emergency
information" — the two stay independent (verification never reveals emergency data; emergency
access never depends on warranty or verification).

## Product reports

Anyone can report a problem from the verification page, without an account.

`POST /public/product-reports { publicToken? | helmetCode?, reason, description?, contactEmail? }` → `202`

- Reasons: `QR_COPIED`, `DETAILS_MISMATCH`, `LOOKS_COUNTERFEIT`, `ID_DAMAGED`, `OTHER`.
- Description ≤ 1000 chars, control characters stripped, rendered as plain text by the admin UI;
  email optional, normalised, ≤ 254 chars.
- Rate limit: `PRODUCT_REPORTS_PER_IP_PER_HOUR` (5) per hashed IP, plus the public throttler.
- A token that doesn't resolve is still stored (`helmet_id = null`) — a copied or forged QR is
  exactly what reports are for. The response never reveals whether the token exists.
- Reports are **never public**. Audit (`product_report.created`) holds the reason and helmet link
  only — never the description or email.

Admin **Product reports** page (`product-report:view`; status changes need
`product-report:manage`): `GET /admin/product-reports?status&page`,
`PATCH /admin/product-reports/:id { status, note? }` with statuses `OPEN → REVIEWING →
RESOLVED | DISMISSED`; reviewer and time recorded, audited as `product_report.status_changed`.

## Public emergency rule (revised in Phase 4)

| Status                               | Emergency page                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACTIVE (switch on, profile complete) | approved information                                                                                                                                     |
| DAMAGED, RECALLED                    | approved information **only if this helmet was already sharing** (switch on, profile enabled), shown with a warning first; otherwise status message only |
| LOST, STOLEN, REPLACED, DEACTIVATED  | status message only, no personal data                                                                                                                    |

Rationale: a helmet is most likely to be marked damaged right after the crash that damaged it, when
responders still need the rider's information. Recalled helmets may still be worn. Lost/stolen
helmets are probably not on the owner's head; replaced/retired ones are out of service.
