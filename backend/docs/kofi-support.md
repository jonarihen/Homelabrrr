# Ko-fi support

**Not verified against Ko-fi.** Ko-fi's webhook settings page (`https://ko-fi.com/manage/webhooks`) and its help article on webhooks both answered HTTP 403 when this integration was designed on 2026-11-09. The payload format was taken from secondary sources: a third-party AsyncAPI description, one forum post with a single Donation example, and a search summary of the help article. No real Ko-fi account or payment has been used. Treat the payload format, Ko-fi's retry behaviour and the Ko-fi menu names as unverified until the [live checklist](#live-checklist) has been completed with a real payment.

Ko-fi is a second, optional way for members to support the lab, next to PayPal checkout and manual bank transfer. A member pays on the operator's public Ko-fi page. Ko-fi then sends a webhook to Homelabrrr, and the payment is recorded as a live DKK receipt in the same ledger PayPal and manual receipts use. Support is voluntary. It never changes access, quotas or priority, and no authorization code reads any Ko-fi table.

What the integration does not do:

- It creates nothing at Ko-fi and calls no Ko-fi API. It only receives webhooks. Homelabrrr never sees card data.
- It does not convert currencies or estimate fees. The ledger is DKK only, and an administrator enters the DKK amount and the fee that actually arrived.
- It does not learn about refunds or ended memberships. Ko-fi sends no event for either, so a refund is recorded by hand (see [Reversal and void](#reversal-and-void)), and a membership that ends simply stops producing payments.
- It has no sandbox. Ko-fi events are always `live`, under the merchant scope `kofi`.
- Disabling it does not stop Ko-fi memberships. Members keep being charged at Ko-fi, deliveries are refused with `503`, and payments missed that way must be recorded as manual receipts.

The Ko-fi panel is on the Support payments admin page (`/admin/paypal`), outside the sandbox/live selector. Every Ko-fi admin route requires an administrator's interactive session; API tokens are refused. Saving the configuration, enabling or disabling, dismissing a review item, recording a foreign payment in DKK, entering a fee, and reversing or voiding a receipt also require recent reauthentication.

## Setup

1. **Check the webhook URL.** Open Admin → Support payments → Ko-fi. The setup card shows the webhook URL, `https://<portal>/api/payments/kofi/webhook` (`https://lab.aaris.tech/api/payments/kofi/webhook` in production). It is built from `PORTAL_BASE_URL`, falling back to `ALLOWED_ORIGIN`. If the card shows `RETURN_ORIGIN_NOT_CONFIGURED` or `WEBHOOK_ORIGIN_INVALID` instead, set that variable to the exact HTTPS portal origin first.
2. **Save the page URL and the verification token.** Ko-fi generates the verification token and shows it on its webhook settings page, which was at `https://ko-fi.com/manage/webhooks` at design time. **The exact Ko-fi menu names and field labels are unverified**; look for the page that has a webhook URL field and a verification token. In the Ko-fi panel, enter your page URL (`https://ko-fi.com/<handle>`; only `ko-fi.com` or `www.ko-fi.com` over HTTPS is accepted) and paste the token (8–256 printable characters, no spaces). The token is write-only: it is encrypted at rest, never shown again and never returned by the API. The panel only says whether one is stored. Leaving the token field empty on a later save keeps the stored token.
3. **Paste the webhook URL into Ko-fi.** On the same Ko-fi page, paste the URL from step 1 into the webhook URL field and save. Until step 4, deliveries with the right token are refused with `503` and nothing is stored.
4. **Enable.** Click **Enable**. It is refused with `KOFI_NOT_CONFIGURED` unless both a token and a page URL are stored. Once enabled, the Ko-fi card and link appear on `/support`. Saving the configuration or replacing the token never changes the enabled state.
5. **Link member emails.** Homelabrrr has no member email addresses of its own, so a payment is matched to a member only through a payer email an administrator has linked. Either add the email under **Linked emails** before the member pays, or choose the member on their first payment in the review queue and leave **remember this email** ticked. Ask members to use the same email on Ko-fi every time.
6. Work through the [live checklist](#live-checklist) before relying on the integration.

## Exposure and environment

`POST /api/payments/kofi/webhook` is the only Ko-fi path that works without a session. In production that is `POST https://lab.aaris.tech/api/payments/kofi/webhook`. Every other method or path under `/api/payments/kofi/` goes through the normal session and CSRF checks and answers `401` or `403`.

Nginx Proxy Manager requirements:

- Let that one path through without an access list. If the proxy host has an access list, this path must be exempt from it. Nothing else needs to be opened for Ko-fi.
- Send `X-Forwarded-Proto: https`. The backend refuses a delivery it sees as plain HTTP with `403`.
- Keep `TRUST_PROXY` correct (`2` in production: Nginx Proxy Manager plus the bundled nginx). The per-client rate limit uses the client address derived from it.
- **Do not log request bodies at the edge.** The verification token travels inside the body, so a body log is a copy of the secret.

The bundled `frontend/nginx.conf` needs no change. Run a single backend replica, as the PayPal workers already require.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KOFI_WEBHOOK_RATE_LIMIT_PER_MINUTE` | `60` | Per-client limit on the Ko-fi webhook ingress. An invalid value or a value of 0 or less falls back to the default |
| `KOFI_WEBHOOK_GLOBAL_RATE_LIMIT_PER_MINUTE` | `300` | Limit on the Ko-fi webhook ingress across all clients |

There is no other Ko-fi variable. The token and the page URL are set in the admin panel, not in the environment.

The endpoint answers with an empty body in every case. Checks run in this order, and the first failure decides:

| Case | Status | Stored |
| --- | --- | --- |
| Rate limit exceeded, per client or global | `429` | nothing |
| Request not seen as HTTPS | `403` | nothing |
| Body larger than 64 kB | `413` | nothing |
| Not form-encoded, no `data` field, or `data` is not a JSON object | `400` | nothing |
| `verification_token` missing or wrong, or no token is stored | `401` | nothing |
| Token valid, integration disabled | `503` | nothing |
| Token valid, `message_id` missing or malformed | `400` | nothing |
| Token valid, new `message_id` | `200`, sent after the event is committed | one inbox event, `pending` |
| Token valid, `message_id` already stored | `200` | no second event, no reprocessing |
| Database failure | `500` | nothing |

Ko-fi is reported to resend a delivery that does not get exactly `200`, with the same `message_id`. The number of retries and their schedule are unpublished and unverified. The token is a static shared secret inside the body, not a signature. It is compared in constant time and removed from the event before storage.

## Processing rules

A background worker processes stored events right after each delivery and every 60 seconds. The checks below run top to bottom, and the first match decides. "Review" means the event waits in the Ko-fi review queue with that reason code. A review item never posts to the ledger by itself, and while it is open it blocks finalized net, like every review item.

| Event | Outcome |
| --- | --- |
| Transaction id is Ko-fi's sample id `00000000-1111-2222-3333-444444444444` | Ignored as a test (`TEST_EVENT`). No review item, no receipt |
| Type `Commission` or `Shop Order` | Review `UNSUPPORTED_TYPE` |
| Any type other than `Donation` or `Subscription` | Review `UNKNOWN_TYPE` |
| Currency is not three capital letters | Review `INVALID_CURRENCY` |
| Amount is not a decimal string such as `"50.00"` (a JSON number is refused), or is outside 1.00–10 000.00 for DKK or 0.01–100 000.00 for another currency | Review `INVALID_AMOUNT` |
| Transaction id missing or malformed | Review `INVALID_TRANSACTION_ID` |
| Timestamp unparseable, more than 24 hours after receipt, or more than 400 days old | Review `INVALID_TIMESTAMP` |
| The transaction id is already the reference of a manual receipt that was not rejected | Review `DUPLICATE_MANUAL_RECEIPT` |
| A receipt with this transaction id exists with the same amount and kind | Ignored (`DUPLICATE_TRANSACTION`). No second receipt |
| A receipt with this transaction id exists with a different amount or kind | Review `TRANSACTION_CONFLICT` |
| Currency is valid but not DKK, and every check above passed | Review `CURRENCY_NOT_DKK`, offered as **Record in DKK**, whether or not the email is linked |
| DKK, payer email missing or not a valid address | Review `EMAIL_MISSING`, can be linked |
| DKK, payer email not linked to a member | Review `MEMBER_UNMATCHED`, can be linked |
| DKK, payer email linked to a member | **Recorded** for that member as a receipt awaiting its fee |
| Unexpected error while processing | Retried with backoff, then review `PROCESSING_FAILED` after 5 attempts |

A `Donation` becomes a donation receipt. A `Subscription` becomes a subscription receipt, for first and recurring payments alike: each payment has its own Ko-fi transaction id and its own receipt. The tier name and the first-payment flag are shown in review only. One Ko-fi transaction id can produce at most one receipt, in any casing or hyphenation, even when Ko-fi sends it again under a new message id.

**Member matching.** The payer email is trimmed and lowercased, then hashed with a key that is unique to this install (HMAC-SHA256). Only the hash and a masked hint such as `an…@example.dk` are stored in the member mapping, never the clear-text address. One email can belong to one member only. The payer name and message are never used for matching. Deleting a member removes their linked emails, and later payments from those addresses go to review. An email becomes "verified" only through an administrator: by choosing a member in **Link** or **Record in DKK** with **remember this email** ticked (the default), or by entering the address under **Linked emails** beforehand. Members cannot claim an email themselves.

**Review queue actions.**

- **Link** is offered for `EMAIL_MISSING` and `MEMBER_UNMATCHED`. Choose a member, or **no member** for a payer who is not a member (the payment is counted but belongs to nobody). The checks above are run again, the receipt is recorded awaiting its fee, and with **remember this email** the address is linked so the next payment is matched automatically.
- **Record in DKK** is offered for `CURRENCY_NOT_DKK`. It requires reauthentication because it posts money. See [Foreign-currency payments](#foreign-currency-payments).
- **Retry** sends the event back to the worker. Use it after adding a linked email or fixing the cause of a failure.
- **Dismiss** requires reauthentication and a note of 3–500 characters. It records the event as not lab income, posts nothing and stops the item from blocking net.

Link and Record in DKK work only while the event's payload is still retained. The PayPal review table does not list Ko-fi events, but the PayPal page's review and unresolved counts include them.

## Money flow

Amounts are integer øre in DKK. A Ko-fi webhook carries the amount the payer was charged, never the fee and never what arrived. The fee is therefore always entered by an administrator from the real payout. This step is also the human check that the payment exists, which matters because the webhook is protected by a shared token, not a signature: an event forged with a leaked token still cannot reach the ledger without this step.

### DKK payments

A DKK payment from a linked email, or one linked from the review queue, is recorded with its gross amount only, in the state **awaiting fee** (`net_unresolved`). It has no ledger postings yet. Under **Receipts**, choose **Enter fee** and type the actual fee in DKK (between 0 and the gross). The receipt is then posted, once, as gross and fee, and the next allocation run counts it. Enter `0.00` only when the fee really was zero. A fee that was typed wrong cannot be edited: reverse the receipt and record a manual receipt with a different reference.

### Foreign-currency payments

The operator's Ko-fi page charges EUR, so in practice every payment takes this path. A payment in a currency other than DKK is never recorded automatically. It waits in the review queue as `CURRENCY_NOT_DKK` and shows the original amount, for example `5.00 EUR`. Choose **Record in DKK** and fill in:

- the member (preselected when the email is already linked), or **no member**;
- **DKK received**: the DKK value of the payment **before** fees, between 1.00 and 10 000.00;
- **Fee in DKK**: the fees deducted from it, between 0 and the DKK amount;
- optionally a note, and whether to remember the email.

This records one posted DKK receipt in a single step: gross, fee and net (gross minus fee) are final, the original amount and currency are kept next to it for reference, and the item leaves the review queue. It cannot be done twice for the same event. Homelabrrr applies no exchange rate of its own.

If Ko-fi lets the page charge in DKK, switching to it removes this step: each payment is then matched by email and needs only the fee. Whether Ko-fi offers DKK is unverified.

### Where to read the DKK amount and the fee

Ko-fi does not hold the money. The operator's Ko-fi page pays out through Stripe, so the real figures are in the Stripe account, not in Ko-fi and not in the webhook. For each payment, open the payment in Stripe and read its balance transaction: the amount in DKK, the fees and the net. Enter the amount as **DKK received** and the fees as **Fee in DKK**, then check that the net Homelabrrr shows equals Stripe's net for that payment.

- A payout to the bank can bundle several payments. Use the per-payment lines of the payout, not the payout total.
- Do not enter the net as **DKK received**. The fee would then be subtracted twice.
- Unverified: the labels Stripe uses, whether any Ko-fi platform fee is listed among the fees, and whether this Stripe account converts each EUR payment to DKK when it is paid. If Stripe only converts at payout, there is no DKK figure per payment and this document does not define how to split one. Settle that with the first real payment before recording anything (see the checklist).
- If the page is ever paid out through PayPal instead, read the same three figures from the PayPal transaction.

### Why the budget says "Unknown"

A missing fee is never treated as zero, because that would count money that did not arrive: the net would be overstated by the unknown fee, and nothing in the budget is estimated. A receipt awaiting its fee is left out of every total, and it makes the monthly funding read **Unknown** and the allocation unresolved, for its own month and for every later month, until the fee is entered or the receipt is voided. An open review item, including one waiting for **Record in DKK**, also blocks finalized net until it is settled or dismissed. "Unknown" on `/energy` after a Ko-fi payment therefore means an administrator step is waiting. It does not mean an error. The setup card counts these as pending events, items needing review, items awaiting a DKK amount, and receipts awaiting a fee.

### Reversal and void

Nothing is reversed automatically, because Ko-fi reports no refunds. When a payment is refunded or charged back, record it under **Receipts**:

- **Reverse** a posted receipt. A reason of 3–500 characters is required. This appends a negative posting for the gross and, optionally, a fee credit between 0 and the recorded fee (default `0.00`; enter what Stripe actually returned). It can be done once. Existing postings are never changed.
- **Void** a receipt that is still awaiting its fee. It posts nothing and unblocks the budget.

A reversed or voided Ko-fi transaction id cannot be recorded again. A correction is a manual receipt with a different reference.

### Manual receipts and duplicates

Members are told not to report a Ko-fi payment as a bank transfer as well. Two guards back that up. A manual report, admin record or confirmation whose reference equals a recorded Ko-fi transaction id is refused with `DUPLICATE_PROVIDER_PAYMENT`. Confirming a manual receipt for a member who has a Ko-fi receipt of the same amount within four days either side is refused with `SIMILAR_PROVIDER_PAYMENT` unless the administrator explicitly acknowledges it. In the other order, a Ko-fi event whose transaction is already a manual receipt is held as `DUPLICATE_MANUAL_RECEIPT`.

### What members see

While Ko-fi is enabled, `/support` shows a Ko-fi card with a link to the page. Members also see their own Ko-fi receipts (amount, date and status: awaiting fee, counted, reversed or voided). A payment in another currency is counted at the DKK amount the owner actually received.

## Retention and audit

- **Never stored:** the `verification_token` sent with an event, and the `shipping` object (postal address and phone number). Both are removed before the event is written. They are also absent from logs, metrics and audit rows.
- **Stored encrypted:** the configured verification token and the email hash key (`kofi_config.verification_token`, `kofi_config.email_hash_key`). Both are covered by `SECRET_ENCRYPTION_KEY` rotation, and neither is returned by any API response. Restoring a backup needs the same key to decrypt them.
- **Payer data in events:** the rest of the payload (name, email, message) is kept for 30 days after processing for processed and dismissed events, then replaced by an empty object. Pending and review events keep their payload until they are resolved, so resolve them promptly.
- **Kept indefinitely:** the event id, type, Ko-fi transaction id, timestamps, status, reason, admin notes, receipts and postings, and the hash and hint of each linked email until it is removed or the member is deleted.

Audit actions: `kofi.config.save`, `kofi.toggle`, `kofi.review.link`, `kofi.review.settle`, `kofi.review.retry`, `kofi.review.dismiss`, `kofi.receipt.fee`, `kofi.receipt.reverse`, `kofi.member_email.add` and `kofi.member_email.remove`. Audit rows carry ids only, never a token, an email address or note text.

## Verification boundary

Everything in this document was verified only with a payload fixture built from the secondary sources above and a throwaway PostgreSQL database with all migrations applied. No request reached Ko-fi or Stripe, and no real Ko-fi account, page, webhook or payment was involved. Still unverified: the field names and types Ko-fi really sends, that it sends EUR for this page, how it handles a non-200 answer and how often it retries, the sample id its test button uses, whether the page currency can be DKK, the Ko-fi menu names, and where exactly Stripe shows the DKK amount and fee.

## Live checklist

Do this once with a real, small payment before telling members about the page. None of these items has been verified.

- [ ] From outside the network, `POST https://lab.aaris.tech/api/payments/kofi/webhook` is reachable, and other paths under `/api/payments/kofi/` answer `401` or `403`.
- [ ] Send a real small payment through the Ko-fi page with a known email.
- [ ] The delivery is answered with `200` and exactly one event appears in the Ko-fi panel (**last event** updates, one new item). No duplicate appears later.
- [ ] The event's currency is what you expect (EUR) and the review item shows type, amount, name, email and message correctly. Empty or wrong fields mean the real field names differ from the assumed format; stop and report it.
- [ ] Link the email: add it for the member under **Linked emails**. It is listed as a masked hint only, and the review item now shows that member (EUR: preselected in **Record in DKK**; DKK: use **Retry**, or **Link** instead of adding it first).
- [ ] Find the payment in Stripe. Confirm that Stripe shows a DKK amount and fee per payment, and note where.
- [ ] Record the DKK amount and fee (**Record in DKK**; for a DKK page, **Enter fee**). The net shown equals Stripe's net.
- [ ] `/energy` no longer shows "Unknown" because of this payment, and the month's support includes the net amount after the next allocation run.
- [ ] The member sees the receipt as counted on `/support`.
- [ ] Wrong token: send the endpoint a request with a wrong `verification_token` (for example with `curl`). It answers `401`, nothing new appears in the panel, and **last error** shows `INVALID_TOKEN`.
- [ ] Press Ko-fi's webhook test button, if it has one. Either **last test event** updates and no review item appears, or a review item appears. In the second case dismiss it with a note (never use **Record in DKK** on a test), and note the sample id and currency Ko-fi used.
- [ ] Rotate the token: get a new token from Ko-fi (whether Ko-fi can regenerate one is unverified), save it in the panel straight away, then confirm a delivery with the new token is accepted and one with the old token gets `401`.
- [ ] Optional: make the endpoint fail once (disable the integration, send a payment, enable again) and note whether and when Ko-fi redelivers.
- [ ] Optional: a second payment from the same email. For EUR it is preselected for the right member; for DKK it is recorded without review.

## Troubleshooting

**Last error** in the setup card is the more recent of the last refused delivery and the last event sent to review, so it shows either a code from the first table or a reason from the second. Refused deliveries are recorded there at most once per 60 seconds.

Refused deliveries (nothing was stored):

| `lastErrorCode` | Meaning | What to do |
| --- | --- | --- |
| `INVALID_TOKEN` | The delivery's token is missing or differs from the stored one, or no token is stored | Copy the token from Ko-fi again and save it. If you did not expect any delivery, someone is probing the endpoint; a wrong token stores nothing |
| `DISABLED` | The token was right but the integration is disabled | Enable it. Ko-fi may redeliver; record anything it does not redeliver as a manual receipt |
| `MALFORMED` | The body was not the expected form field `data` holding a JSON object, or it had no usable `message_id` | If this happens for a real payment, Ko-fi's format differs from the assumed one. Do not rely on the integration until that is resolved |

A `429` (rate limit), `403` (not HTTPS), `413` (body too large) or `500` (database failure) is not recorded in the panel. Check the proxy's access log for the status. A `403` on every delivery means `X-Forwarded-Proto: https` is not being forwarded. A `401` or `403` with a JSON body means the request did not reach the webhook route at all: check the exact path and that the method is `POST`.

Review reasons:

| Reason | Meaning | What to do |
| --- | --- | --- |
| `CURRENCY_NOT_DKK` | A valid payment in another currency | **Record in DKK** with the figures from Stripe. Dismiss it if it is a test or not lab income |
| `MEMBER_UNMATCHED` | The payer email is not linked to a member | **Link** it to the member, or to no member. Or add the email under **Linked emails**, then **Retry** |
| `EMAIL_MISSING` | The event has no usable email | **Link** it by hand. There is no email to remember, so the next payment needs linking again |
| `UNSUPPORTED_TYPE` | A Ko-fi commission or shop order | These are not recorded. Dismiss with a note |
| `UNKNOWN_TYPE` | A type the integration does not know | Dismiss with a note. If Ko-fi sends this for ordinary donations, the format differs from the assumed one |
| `INVALID_CURRENCY` | The currency is not a three-letter code | Dismiss with a note. If the payment was real, record it as a manual receipt |
| `INVALID_AMOUNT` | The amount is not a decimal string, or is outside the accepted range | Same as above |
| `INVALID_TRANSACTION_ID` | The Ko-fi transaction id is missing or malformed | Same as above |
| `INVALID_TIMESTAMP` | The timestamp is unreadable, more than 24 hours ahead of receipt, or older than 400 days | Same as above |
| `DUPLICATE_MANUAL_RECEIPT` | This transaction was already recorded as a manual receipt | The money is already counted. Dismiss with a note saying so |
| `TRANSACTION_CONFLICT` | A receipt with this transaction id exists with a different amount or kind | Compare both with Stripe. Dismiss the event. If the existing receipt is the wrong one, reverse it and record a manual receipt with a different reference |
| `PROCESSING_FAILED` | Processing failed 5 times with an unexpected error | **Retry**. If it fails again, check the backend log |

Errors from admin actions:

| Error | Meaning |
| --- | --- |
| `KOFI_NOT_CONFIGURED` | Enable needs both a stored token and a page URL |
| `INVALID_PAGE_URL`, `INVALID_TOKEN_FORMAT` | The page URL is not `https://ko-fi.com/<handle>`, or the token is not 8–256 printable characters without spaces |
| `EMAIL_ALREADY_LINKED` | The email is linked to another member. Remove that link under **Linked emails** first |
| `REVIEW_EVENT_NOT_LINKABLE`, `REVIEW_EVENT_NOT_SETTLEABLE` | The item is no longer open, has a reason that does not allow the action, or its payload is no longer retained |
| `FEE_OUT_OF_RANGE` | The fee is larger than the gross, or the fee credit is larger than the recorded fee |
| `KOFI_RECEIPT_NOT_UNRESOLVED` | A fee was already entered for this receipt, or it was reversed or voided |
| `KOFI_RECEIPT_ALREADY_REVERSED` | The receipt was already reversed or voided |

Other symptoms:

- **The budget shows "Unknown".** Open the Ko-fi panel and clear the counts: record or dismiss review items, and enter the fee for (or void) every receipt awaiting one.
- **The PayPal page shows a review count but its table is empty.** The items are Ko-fi events. They are listed in the Ko-fi panel only.
- **A payment was made but nothing arrived.** Check the webhook URL saved at Ko-fi, the proxy's access log for the delivery and its status, and whether the integration was disabled at the time. If Ko-fi does not redeliver, record the payment as a manual receipt.
- **The Ko-fi card is missing on `/support`.** The integration is disabled, or no page URL is stored.
- **A refund happened at Ko-fi or Stripe.** Nothing arrives by webhook. Reverse or void the receipt by hand.
