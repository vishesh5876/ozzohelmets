# Support SOP

For support staff (role SUPPORT; some steps need ADMIN or SUPER_ADMIN). Related:
[CUSTOMER-SUPPORT](../CUSTOMER-SUPPORT.md) · [ACCOUNT-RECOVERY](../ACCOUNT-RECOVERY.md) ·
[compromised QR](compromised-qr.md) · [REPLACEMENT](../REPLACEMENT.md) ·
[PILOT feedback log](../PILOT.md#feedback-process).

## The seven identifiers and credentials. Never mix them up.

| Name               | Looks like                    | Who has it                                                                                   | What it does                                                                      | Support may ask for it?                                                        |
| ------------------ | ----------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Safety ID**      | `SI-A8F3-KL92`                | printed next to the QR (sticker, card or helmet label); public                               | identifies one emergency QR; may be linked to a helmet or standalone              | **yes**: safe to share                                                         |
| **Helmet ID**      | `HM-A8F3-KL92`                | printed inside the helmet; public                                                            | identifies one physical helmet (product, warranty)                                | **yes**: safe to share                                                         |
| **Customer ID**    | `CU-K7PX-92LM`                | the customer (Account page); public-ish                                                      | identifies an account; can be used to sign in (with the password)                 | **yes**: safe to share                                                         |
| **Activation PIN** | 8 characters, e.g. `7KQ2M9XA` | printed with the Safety ID (sealed card in the helmet box, or the sticker/card pack)         | proves possession for the **first** activation of that Safety ID. Works once      | **never**. If a customer reads it out, tell them not to share it again         |
| **Recovery Code**  | `RK-XXXX-XXXX-XXXX`           | the customer (shown once at sign-up, can be regenerated)                                     | resets a forgotten password, with the email / Customer ID / Helmet ID             | **never**                                                                      |
| **Transfer Code**  | `TR-XXXX-XXXX-XXXX`           | the current owner (generated when selling or giving away a helmet or a standalone Safety ID) | lets the next owner claim it. Single use, expires                                 | **never**                                                                      |
| **Recovery Grant** | `AR-XXXX-XXXX-XXXX-XXXX`      | issued by a SUPER_ADMIN after identity checks                                                | last-resort password reset when the customer lost both password and Recovery Code | support **issues** it (SUPER_ADMIN) and hands it over by phone; never by email |

Support never needs a password, an Activation PIN, a Recovery Code or a Transfer Code. Anyone
asking for them is not following this SOP.

## Finding things

- **Admin → Safety IDs**: Safety ID (`SI-…`), Helmet ID, Customer ID or batch code. The Safety ID
  page shows status, Activation PIN state, owner, linked helmet (or "Standalone"), ownership
  history and support actions. Global and customer search also accept `SI-` codes; the customer
  page lists Safety IDs separately from helmets.

- **Admin → Helmets**, single search box: Helmet ID (any case or spacing), serial, batch code
  (`BAT-…`), model name or SKU. With customer access you can also use the owner's email or
  Customer ID. Exact identifiers return one result.
- **Admin → Customers**: email, Customer ID or Helmet ID. The customer page links to their
  helmets, warranty, security events and support actions. Medical details are never shown to
  support.
- **Activation PIN state** on a helmet page:
  - _Available for manufacturing_: the batch has not been exported yet.
  - _Unused · exported for printing_: the CSV has been exported.
  - _Unused · escrow purged_: unused, but nobody can retrieve the PIN any more.
  - _Consumed_: already used to activate.

## Common requests

| Customer says                                | Do                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "My Activation PIN doesn't work"             | Check the helmet: PIN state _Consumed_ means it was already activated (by whom? check the owner, never reveal it to the caller). _Unused_ means a typo (0/O, 1/I: PINs avoid ambiguous characters), or too many attempts (wait an hour). Lost card → [manufacturing runbook](manufacturing.md#problems). |
| "I forgot my password"                       | Point them to **Forgot password?** with their email, Customer ID or Helmet ID **and their Recovery Code**.                                                                                                                                                                                               |
| "I lost my password and my Recovery Code"    | Verify identity (owned Helmet ID, purchase details, phone call to the registered account). Then a SUPER_ADMIN issues a **Recovery Grant** (customer page → Account Recovery Grant), read out by phone. All sessions are revoked when it is used.                                                         |
| "I sold / gave away my helmet"               | The owner creates a **Transfer Code** (helmet page → Transfer). The new owner uses **Claim**. Support can cancel a pending transfer.                                                                                                                                                                     |
| "My QR shows the wrong person" / copied QR   | [compromised QR runbook](compromised-qr.md).                                                                                                                                                                                                                                                             |
| "Emergency page doesn't show my information" | Customer dashboard: _Emergency information is not active yet_ → finish emergency setup; or sharing is off for that helmet → helmet page → _Show emergency info on this helmet_.                                                                                                                          |
| "Delete my account"                          | Customer: Account → Delete account. Support: Privacy requests. Note: deletion currently disables the account and hides the emergency information; it does not erase data (see DATA-INVENTORY).                                                                                                           |
| Suspicious sign-ins                          | Customer page → **Sign out all sessions** (reason required). Suspend only if abuse is likely; suspension never hides the rider's emergency information.                                                                                                                                                  |

## Safety rules

- Never read medical information to anyone. Support views don't show it.
- Never tell a caller who owns a helmet, or where or when it was scanned.
- Destructive actions (suspend, lock, mark deleted, revoke ownership) always need a written
  reason and are audited. They are grouped under **Restrictive actions** on the customer page.
- Log every pilot issue in the feedback log ([PILOT](../PILOT.md#feedback-process)).

## Safety IDs (Phase 9)

| Customer says                                   | Do                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "My PIN doesn't work" (Safety ID)               | Admin → Safety IDs → the `SI-` code. _Consumed_: already activated (check the owner, never reveal it). _Not activated_ but PIN fails: typo or too many attempts (wait). Status _Generated_: the batch was never marked printed → manufacturing.                                 |
| "It says the helmet is owned by someone else"   | The Safety ID is linked to a helmet owned by another account (`SAFETY_ID_LINK_CONFLICT`). Do not unlink on request. Check the purchase story; if the helmet was resold without a transfer, the previous owner creates a Transfer Code, or follow the ownership dispute process. |
| "I have two Safety IDs; only one shows my info" | Sharing is per Safety ID: My Safety IDs → the Safety ID → **Turn on emergency sharing**.                                                                                                                                                                                        |
| "I gave my sticker/card to someone"             | Standalone Safety ID: owner → My Safety IDs → the Safety ID → **Generate Transfer Code**; the new owner uses **Claim a Safety ID**. A linked Safety ID moves with its helmet's transfer.                                                                                        |
| "My sticker was copied / lost"                  | Deactivate the Safety ID (admin, password confirmed, reason required): its QR shows "no longer active" immediately. Issue a new standalone Safety ID. Reactivate only if it turns up and is confirmed safe.                                                                     |
| "Which code do I give support?"                 | The Safety ID or Helmet ID (both public). Never the PIN.                                                                                                                                                                                                                        |

Admin actions on a Safety ID (deactivate, reactivate, link, unlink, QR integrity, revoke
ownership) are audited and need a reason; deactivate and revoke ownership also need your
password. Link/unlink only fixes manufacturing mistakes (wrong label on a helmet); never use it
to move a Safety ID between customers.
