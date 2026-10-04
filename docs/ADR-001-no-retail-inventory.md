# ADR-001 — No retail, distributor or inventory model

- **Status:** accepted (2026-10-04)
- **Context:** a dealer/distributor/inventory phase (organisations, partner users, stock ledger,
  transfers, dealer sales) was prototyped. It added a fourth app, a partner auth realm and a
  sale-before-activation dependency, without improving the one thing that matters for a rider:
  proving they physically hold the helmet.

## Decision

The platform intentionally does not model retail/distributor inventory. Physical possession is
proven using the helmet's one-time activation PIN.

- The product has three surfaces only: **Admin**, **Customer** and the **public QR** pages.
- A helmet may be activated from `PRINTED`, `IN_INVENTORY` or `SOLD`
  (`ACTIVATABLE_STATUSES` in `packages/types/src/lifecycle.ts`, applied by `ActivationPolicy`).
  No sale record is required. `IN_INVENTORY` / `SOLD` remain optional admin bookkeeping statuses.
- The first activation binds an account **email** as the sign-in identifier. Email is not
  verified and never proves ownership; the PIN does.
- Warranty purchase details are customer-declared (`purchaseChannel` enum + free-text
  `sellerName`). Public verification shows manufacturer registry facts only.

## Consequences

- No partner app, partner RBAC, stock ledger, manifests or dealer-sale reversals to secure or run.
- The prototype was never merged, so no cleanup migrations exist; the schema never contained it.
- Retail analytics (sell-through, regional stock) are out of scope. If needed later, they should
  be an import/reporting concern, not a gate on activation.
