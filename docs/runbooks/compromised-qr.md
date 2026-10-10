# Runbook: compromised (copied / cloned) QR label

A QR label is "compromised" when its token is suspected to be copied onto another product (for
example a counterfeit helmet), or when someone else holds a photo of it. The token is public by
design. It only reveals what the owner chose to share, and it cannot be used to take ownership:
activation needs the one-time PIN, and transfer needs the owner's transfer code.

**Rule: a compromised status never removes the rider's emergency information.** The real helmet's
owner may still crash and need it. See [QR-ABUSE-DETECTION](../QR-ABUSE-DETECTION.md#qr-integrity).

## Signals

- Risk alerts in admin → Analytics → Alerts: unusual scan volume or locations for one helmet
  (`helmet:<id>:volume|anomaly`).
- Customer report ("my QR shows someone else's helmet", or scans the owner did not make in their
  scan summary).
- Public product report from `/verify/<token>` ("this helmet looks fake").
- Marketplace listings showing the same Helmet ID on several products.

## Steps

1. **Review** (support): admin → Helmets → helmet → activity and scan summary. Compare with the
   owner's account. Contact the owner through the registered email to confirm they hold the real
   helmet (the Helmet ID printed inside it must match).
2. **Mark UNDER_REVIEW** (`qr-integrity:manage`, SUPER_ADMIN or ADMIN): helmet → QR integrity →
   `UNDER_REVIEW`, with a note. Audited as `helmet.qr_integrity.changed`. Nothing changes for the
   public yet.
3. **Confirm → COMPROMISED:** the verification page then shows the neutral notice ("This QR code
   has been reported as possibly copied. Check that the Helmet ID printed inside the helmet
   matches…"). The emergency page keeps working for the owner's helmet.
4. **Offer a replacement label or helmet:** a physically different helmet linked as a
   replacement ([REPLACEMENT](../REPLACEMENT.md)). The old token then shows "replaced". The
   owner switches emergency sharing on for the new helmet explicitly.
5. **Batch-wide:** several helmets from one batch compromised → look for a leaked manufacturing
   CSV (audit `batch.export.manufacturing_csv`: who exported, when). Unsold units: mark them
   `DEACTIVATED` or `RECALLED`. Sold units: contact the owners. Treat it as a SEV2 incident.
6. **Close:** back to `NORMAL` with a note if the suspicion was wrong. Record the outcome in the
   alert (resolve/dismiss).

## What not to do

- Do not deactivate an owned, active helmet just because its QR was copied. That would hide the
  real rider's emergency information.
- Do not tell the reporter who owns the helmet or what the scan locations were.
- Do not regenerate a token in place. Printed labels cannot be changed, so a replacement is the
  only clean path.
