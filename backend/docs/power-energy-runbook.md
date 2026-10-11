# Power & Energy operator runbook

This runbook covers the private Power & Energy features (epic #232, issues #233–#240). Follow the sections in order: each stage depends on the previous one. Deeper reference material lives in:

- [eloverblik.md](eloverblik.md): ElOverblik Customer API details, failure states and charge observations
- [energy-dashboard.md](energy-dashboard.md): the member read API, contract succession, finalized months, refund policy and bills
- [paypal-support.md](paypal-support.md): PayPal setup, reconciliation, refunds and the review queue

> **Verification boundary.** Every behaviour described here was verified only with fixtures, fakes and throwaway PostgreSQL databases. Nothing was tested against a live HPE iLO, a real ElOverblik account or meter, or a PayPal sandbox or live account. The one exception is a bounded, read-only query to the public Energi Data Service on 2026-10-08, which confirmed field names and units. Before you trust any of this in production, work through the [live verification checklist](#13-live-verification-checklist).

## 1. Prerequisites and what stays disabled by default

- Run a single backend replica. The telemetry collector, power controller, ElOverblik sync and PayPal workers all assume one process.
- Keep `SECRET_ENCRYPTION_KEY` safe and backed up separately. The iLO passwords, the ElOverblik refresh token and the PayPal client secrets are encrypted at rest, and key rotation covers all three (`hardware_connections.secret`, `eloverblik_connections.refresh_token`, `paypal_configs.client_secret`).
- Every admin route below requires an administrator session. Hardware connection routes accept `can_manage_hosts`. Power control, energy data, electricity pricing and PayPal administration are admin-only. Routes that write to hardware or move money also require recent reauthentication.

A fresh install or an upgrade changes nothing until you configure it:

| Feature | Default | Turned on by |
| --- | --- | --- |
| iLO connection | none | Adding one per node (Admin → PVE Hosts → Hardware) |
| Power telemetry collection | off | An explicit per-node switch, available only after a successful read-only test |
| Automatic power changes | off | Saving a policy, turning on **Allow automatic changes**, then **Enable live control** (reauthentication plus acknowledgement) |
| ElOverblik import | off | Saving a token *and* selecting a meter |
| Spot price download (Energi Data Service) | off | Creating an active *spot* contract. The download uses a public dataset and needs no credentials |
| Extra lab loads | none | Adding one explicitly |
| Fixed-fee allocation | none | Choosing a manual share or a household proportion |
| PayPal checkout (sandbox and live separately) | off | Admin → PayPal. Live also needs reauthentication and `confirmLive` |

No simulated data is shown as real. Values without a source show as *unknown* or *unavailable*.

## 2. iLO connections and monitoring first

**Account and privileges.** Create a dedicated iLO local account for Homelabrrr on each server. Do not reuse the Administrator account.

- Connection tests and monitoring only send Redfish `GET` requests, so an account that can log in and read is enough. A `403` is reported as `insufficient_privilege`, which is separate from `authentication_failed` (`401`).
- Live control sends one `PATCH` to `/redfish/v1/Systems/<id>` that sets only `Oem.Hp.PowerRegulatorMode` (iLO 4) or `Oem.Hpe.PowerRegulatorMode` (iLO 5) to `Min`, `Dynamic` or `Max`. The test cannot check write privilege. The Hardware panel shows it as *unverified* until a real controlled change succeeds. Grant the smallest iLO privilege that lets this PATCH succeed on your firmware, and confirm the choice on real hardware (see the checklist).
- Three consecutive credential rejections (`401`) auto-disable collection for that node (`hardware_collection_auto_disabled` in the audit log). Each rejection also backs off for at least 15 minutes. Together these keep a stale password from tripping the iLO login lockout. To recover, update the password, test, and re-enable. The power controller never auto-disables itself. On credential errors it backs off for up to 60 minutes and sends one notification per failure streak.

**TLS.** Leave **Verify TLS** on. If the management network uses an internal CA, paste the CA certificate (PEM) into the connection. Unverified TLS is refused unless the server runs with the break-glass setting `ALLOW_INSECURE_UPSTREAM_TLS=true`, which also affects Proxmox and FortiGate. Management addresses go through the SSRF guard. Cloud metadata (`169.254.169.254`, `100.100.100.200`), loopback and multicast are refused, and redirects are never followed.

**Add and test.** In Admin → PVE Hosts, open **Hardware** on a node. Each physical node gets its own connection, even if one PVE API endpoint exposes several nodes. Enter the address, port, account and password, then run **Test**.

- The password is write-only and never returned to the browser.
- A test reads the generation, firmware, physical identity, regulator mode, chassis input watts and optional health data. Failed results are kept and shown.
- An edit that changes the target (address or port) requires the password again, disables collection and control, and keeps the stored physical identity. The next test must find the *same* server.
- If a different server answers, decommission the connection and create a new one. Old energy history then never belongs to the replacement.
- If a node is renamed, use **Rebind** (`POST /api/admin/hardware-connections/:id/rebind`). It keeps the hardware ID and history and requires another test.

**Monitoring first.** After a successful test, turn on **Power telemetry** and let it run for at least several days before you enable any control.

- Polling runs about every 60 s (`HARDWARE_POLL_INTERVAL_MS`, minimum 30000), at most two nodes at a time, under a 2-minute crash-recovery lease.
- Each iLO request has a 15 s wall-clock deadline, and a whole discovery has 60 s.
- Samples are integrated into 15-minute UTC buckets. Gaps longer than three poll intervals stay uncovered rather than being interpolated.
- Values are operational sensor estimates, not revenue-grade metering. UPS losses and other equipment are not included, so model those as extra lab loads (section 5).
- Poll outcomes are exported on `/metrics` as `homelabrrr_hardware_telemetry_polls_total{result,code}`.

**Decommission.** Deleting a connection decommissions it. The credential is cleared and the identity record stays as a tombstone. Only an *active* connection blocks deletion of its PVE host. There is no hard-purge API, so archived telemetry ages out through retention (section 11).

## 3. ElOverblik meter data

1. In the ElOverblik portal, create a **Customer API** refresh token. Homelabrrr never uses the ThirdParty API.
2. In Admin → Energy Data, paste the token. It is encrypted, and saving it does not start a sync.
3. Choose one meter from the linked list. Scope defaults to **household** (whole-household consumption). Choose `dedicated_lab` only for a meter that measures the lab alone. Household readings are never counted as server consumption. They are a comparison and a basis for fixed-fee allocation only.
4. Selection starts a 13-month backfill in 30-day chunks about a minute apart. Normal refresh then runs every six hours. A manual resync has a five-minute cooldown, and a period resync (`from`/`to`, at most 31 days) closes a recorded gap.

**Pauses and reconnecting.**

- `Retry-After` is honoured (clamped to 24 h) and persisted. Other failures back off exponentially from 15 minutes to 12 hours.
- A rejected token (*reconnect required*), an unauthorized meter or a missing meter stops all polling and token use. It also sends one private `energy.meter_attention` notification. Fix it by pasting a new token or reselecting the meter.
- Selecting a different meter starts its own backfill and inherits nothing.
- **Disconnect** deletes the token and keeps history. Pass `purgeHistory: true` to delete imported intervals and charge observations as well.

ElOverblik data lags behind real time, and the latest interval end is shown. See [eloverblik.md](eloverblik.md) for the full failure semantics.

## 4. Electricity contract, tariffs and price basis

Under Admin → Energy Data → **Electricity contract & cost**:

- Pick DK1 or DK2 explicitly. Choose either *spot plus charges* or a *fixed all-in* variable rate, and set the valid dates, retailer margin, required tariff components, VAT fraction and whether each tariff already includes VAT. Fixed monthly charges are entered separately, in øre.
- Nothing is preloaded: no supplier, tax or network tariff. An empty required term makes the price *incomplete*, while an explicit `0.000000` is a known zero. A fixed all-in rate is never combined with spot.
- With an active spot contract, `DayAheadPrices` for that area is cached in 15-minute intervals. The scheduler checks hourly, with a six-hour gate. It honours `429`, keeps cached prices through outages and backfills up to three missing days per run. Prices are never invented for unpublished hours.
- Two price bases exist. **Variable retail including VAT, excluding fixed fees** is the default for power policy. **Spot only, excluding retail additions** is labelled as such wherever it is used.

**Contract changes.** Use **End** (`/contracts/:id/end`) or **Supersede** (`/contracts/:id/supersede`, which ends the contract and activates its successor at the same instant). Both need a reason and are audited. An end date that would cut into a finalized month is refused (`FINALIZED_PERIOD`). *Deactivate* now means *withdraw*: a deactivated contract prices nothing, including past dashboard months. If you deactivated a contract in the past to switch supplier, re-enter it with end dates. A month that spans two contracts is priced under each contract for its own part, and the fixed fees are pro rata.

## 5. Optional extra loads and fixed-fee allocation

- **Extra lab loads** are dated, constant-watt estimates for things iLO does not measure (switch, UPS overhead). They are labelled as estimates and kept apart from measured kWh. Inclusive or upstream meter readings are rejected.
- **Fixed-fee allocation** defaults to *none*. You can choose a manual share or a household-energy proportion. A partial or ambiguous household series suppresses the share.

## 6. Weekly schedule and power control

Admin → PVE Hosts → Hardware → **Power policy**.

**Preset schedule** (`Europe/Copenhagen`): High on Mon–Fri 16:00–02:00 and Sat–Sun 12:00–22:00, Low otherwise. An overnight window belongs to the day it starts. DST gaps and repeated hours follow local wall time. A nonexistent start moves to the first valid minute, and a repeated hour uses its earlier occurrence for a start and its later occurrence for an end. Only Low, Dynamic and High (iLO Min/Dynamic/Max) are written. Homelabrrr never sends a reboot, BIOS change, power cap, power on/off or VM action.

**Enabling, in order:**

1. Save the policy, then check the **seven-day preview** and the *if enabled* draft preview. Both use the controller's own decision resolver. Price-dependent hours beyond published prices show as unknown.
2. Turn on **Allow automatic changes** (requires an enabled schedule or price policy).
3. **Enable live control**. This requires recent reauthentication, an explicit acknowledgement, an active and online connection with a known identity, and a test that found a readable runtime regulator mode.

The worker evaluates enabled nodes every 60 s. Before any write it re-reads the host and refuses to act if the host is off, booting or in an unknown power state, or if the mode is *OS Control* or unknown.

**Manual override.** **Apply now** requires live control and reauthentication. It does not require automatic changes to be on. Duration options:

- a fixed number of minutes (default 180, range 1–1440)
- until the next boundary of the enabled weekly schedule (unavailable without one)
- until cleared

When the override expires, the controller resolves the schedule and price again. **Clear override** removes it immediately.

**Pausing.**

- **Pause node automation** stops automatic changes on one node.
- **Pause all automation** stops them server-wide and requires reauthentication.
- Pausing leaves the hardware in its current mode.
- Disabling only the weekly schedule keeps an explicitly enabled price-only policy running.
- **Disable live control** stops every new iLO command.

**External changes (drift).** If someone changes the mode outside Homelabrrr (iLO UI, RBSU), the node goes into an *external-change hold* and automatic writes stop.

- With a schedule enabled, the hold lifts at the next weekly boundary and adopts the freshly read mode.
- Price-only policies, and drift to OS Control or an unknown mode, wait for **Resume after external mode change**.
- Resume reads the iLO again. It fails, and the hold stays, if the read fails, the host is not running, or the mode is OS Control or unknown.

**Claim, lease and the point of no recall.**

- Each action first takes a per-node claim with a 240 s lease. The lease is renewed before each slow phase. Within that window the read is capped at 45 s, the pre-dispatch phase at 90 s and the write at 120 s.
- Before the PATCH, a *requested* operation row is committed, and only while the claim is still held. **From that commit on, the request cannot be recalled.** Disabling control or pausing only stops *future* actions.
- After the PATCH, up to three read-backs about 2 s apart decide between *verified* and *unknown*. A timeout or an unconfirmed result counts as unknown, never as success.
- Failed or unknown outcomes back off for 1, 2, 4 … minutes, up to one hour. The mode is re-read before any retry, and one notification is sent per failure streak.
- An abandoned claim, for example after a crash or a restore, is cleared on the next load and recorded as unknown, so edits are not blocked forever.
- Every operation records the actor, the policy, schedule and price-policy revisions, the price value, interval and source, and the thresholds. See **Operation history**.

## 7. Price cap and boost rules

All values are DKK/kWh decimal strings (a Danish decimal comma is accepted). They apply to the chosen basis, contract and area, and are evaluated per 15-minute price interval.

- **Expensive (cap):** a price strictly above the upper threshold caps the scheduled mode at the chosen cap mode (Low or Dynamic). The cap is released once the price falls to or below *threshold − hysteresis*.
- **Cheap (boost):** a price strictly below the lower threshold selects High, including at negative prices. The boost is released at or above *threshold + hysteresis*.
- Hysteresis defaults to 0 and cannot be negative. The two release bands must not overlap, or the policy is rejected.
- **Minimum automatic upshift interval** defaults to 5 minutes (0–1440). An automatic mode increase does not happen again within that time after the last one. Manual commands are exempt.
- **Missing, incomplete or mismatched price** (wrong basis, contract or area, or outside its interval) falls back to the weekly schedule, with reason `price_unavailable_fallback`. In a price-only policy it falls back to the explicit **price-only default**, which you must choose because none is prefilled.
- A corrupt saved policy applies a defensive restriction. It never boosts, an enabled cap still applies, and it never moves above the current mode.
- Forecasts and household meter data are never used to authorize a mode change.

## 8. Bills, monthly statements and refunds

- **Actual bills** are private records and stay separate from calculated lab cost. **Revise** voids the old bill and appends a revision, and **Void** withdraws one. **Paid** records the cumulative amount paid, which stays *partially paid* until it reaches the invoice amount. A preview shows an estimated lab share only when the bill covers exactly that month and household coverage is comparable.
- **Finalization** (`POST /api/admin/electricity-pricing/months/:month/finalize`) is for completed months. It requires full server and price coverage and a known fixed-fee allocation. Otherwise it is refused unless you pass `acknowledgePartial: true`. That records the missing coverage as `finalized_partial`, and funding allocation then treats the month's cost as unknown. Each finalization appends an immutable statement revision with an input fingerprint. A tariff change that would affect a finalized period is rejected, and an explicit recalculation appends a new revision.
- **Refund carry-forward policy:**
  - A refund or reversal that pushes a month's support below zero shows in that month, as a negative closing balance and an owner-funded adjustment.
  - Only positive credit carries forward.
  - A loss is never carried into later months. Later contributions never repay it, it never becomes contributor debt, and it is never counted twice.

  See [energy-dashboard.md](energy-dashboard.md).

## 9. PayPal private support

PayPal support is optional and voluntary. It never changes access, quotas or priority. Manual bank transfer is a fallback, not the main workflow. For full detail, see [paypal-support.md](paypal-support.md).

1. **Account.** You need a verified PayPal **Business** account that accepts DKK, plus one REST app per environment with Checkout, Subscriptions and the Transaction Search reporting scope. A personal account may not be eligible.
2. **Sandbox before live.** Sandbox and live keep completely separate credentials, merchant IDs, webhooks, plans and ledgers, and sandbox postings never count toward live totals. Enable sandbox first. Enabling live requires reauthentication and explicit live confirmation.
3. **Setup.** In Admin → PayPal, save the client ID, the secret (write-only) and the receiving merchant ID. Stale form saves are refused (`CONFIG_VERSION_CONFLICT`). Then run **Register webhook**, **Create product** and **Create monthly plan**. These are idempotent per environment and app, and the request IDs are persisted before each call. After that, run **Test connection**, which is read-only.
4. **Webhook reachability.** Through the reverse proxy, expose **only** `POST /api/payments/paypal/webhook/<environment>` to the internet, over HTTPS, and forward `X-Forwarded-Proto`. Keep the rest of the portal, iLO and Proxmox private. Events are acknowledged only after signature verification and durable storage. Rate limits are `PAYPAL_WEBHOOK_RATE_LIMIT_PER_MINUTE` (default 120, per client) and `PAYPAL_WEBHOOK_GLOBAL_RATE_LIMIT_PER_MINUTE` (default 600). PayPal's simulator events fail verification by design, so never weaken verification to make them pass.
5. **Reconciliation.** It runs every `PAYPAL_RECONCILE_INTERVAL_MINUTES` (default 360, range 15–1440), plus a pass shortly after startup. It recovers missed events, reads back uncertain captures, reconciles each subscription in isolation, and retries missing fee and refund details. Admin → PayPal shows reconciliation health, subscriptions, the review queue and a formula-safe CSV export (which requires reauthentication).
6. **Fee unknowns.** A missing fee or net amount is recorded as `net_unresolved`, never as zero, and it blocks the finalized net until it is resolved. Pending payments, denials and disputes are shown but never subtracted. Non-DKK amounts are stored verbatim and never summed into DKK.
7. **Cancellation.** Members can cancel their own subscriptions, and admins can cancel any subscription with reauthentication. Cancellation is confirmed only by provider readback. Deleting a member requests cancellation of their subscriptions and is blocked until PayPal confirms it. Plans use `payment_failure_threshold: 1` and `auto_bill_outstanding: false`, so a failed payment suspends the subscription instead of building up debt.
8. **Disabling new checkout** (Admin → PayPal, disable the environment) stops new approvals. It **does not cancel existing subscriptions**, so cancel those separately if needed. Retiring a plan likewise only stops new approvals.
9. **Manual bank transfer.** A member reports the transfer, which never posts by itself. An admin then confirms it with evidence, which posts one live DKK receipt. Duplicates of imported PayPal transactions are refused, and a correction appends a reversal.

## 10. Member Energy & Budget dashboard and privacy

- `/energy` (**Energy & Budget**) is visible to every signed-in member with an interactive session. `/support` hosts the optional PayPal support flow.
- Members see aggregate server watts, kWh and fleet coverage, servers by generated alias (`Server 01`…), the observed and desired mode with a reason, the current price with its validity, the calculated cost (live estimate or finalized statement) and aggregate funding.
- Responses never include node references, management addresses, serial numbers, meter IDs, household readings, credentials, contributor identities or merchant identifiers. All responses are `Cache-Control: private, no-store`.
- Reading the page never triggers an upstream fetch or a hardware write.
- Admins also see an admin panel with setup links, telemetry/meter/bill/PayPal health, the household-sharing toggle and exports, built only from stored state.
- **Household-total sharing** is off by default. On `/energy` (admin panel) choose *invoiced* or *paid*; this needs identity confirmation and is audited. Members then see only that month's total, the bill kind and its paid status, taken from non-void settlement bills covering exactly that month (or advance bills if no settlement exists). It is labeled whole-household and is never added to the lab cost. Readings, meter/account IDs, references and notes are never shown. Turning it off hides the total on the next request.
- **Exports.** Members: *Download this month as CSV* gives their summary as field/value rows. Admins: *Export budget records CSV* (from/to month, at most 120 months, reauthenticated and audited) gives every cost-statement and allocation revision with selected fields, live data only; use the PayPal page for the payment ledger. Text cells that look like spreadsheet formulas are neutralized.

## 11. Backup, restore and retention

**Backup and restore.** The scheduled encrypted `pg_dump` backups (see README → *Configure encrypted, verified, off-host backups* and *Disaster-recovery restore*) include every power, energy and PayPal table. Restoring needs the same `SECRET_ENCRYPTION_KEY` (or the previous keyring) to decrypt the iLO, ElOverblik and PayPal secrets. After a restore:

- Abandoned power-control claims are cleared and recorded as unknown. The controller re-reads every node before it acts.
- The PayPal inbox's replay protection blocks re-posting of already-processed events. Run a reconciliation and check the review queue.
- Check ElOverblik coverage and run period resyncs for any gap.

**Retention:**

| Data | Default | Env var |
| --- | --- | --- |
| Raw iLO watt samples | 30 days (min 2) | `HARDWARE_RAW_RETENTION_DAYS` |
| 15-minute server energy buckets | 730 days (min 400) | `HARDWARE_INTERVAL_RETENTION_DAYS` |
| Daily server energy totals | 1826 days (never shorter than buckets) | `HARDWARE_DAY_RETENTION_DAYS` |
| ElOverblik intervals and cached spot prices | 1830 days | `ENERGY_HISTORY_RETENTION_DAYS` |
| Processed PayPal webhook payloads | 30 days, then emptied (IDs and ledger kept) | none |
| Finalized cost statements, ledger, allocations | kept | none |


## 12. Disable and rollback, per feature

| Feature | Stop it | What remains |
| --- | --- | --- |
| Automatic power changes | **Pause all automation** (immediate, server-wide), then **Disable live control** per node. Restore the desired mode by hand in iLO if needed. A request already sent cannot be recalled | Policies, operation history, telemetry |
| Manual override | **Clear override** | Audit entry |
| Telemetry collection | Turn off **Power telemetry** on the node | The last reading, shown with its true age, and the history |
| iLO connection | Decommission (delete) it | Tombstone identity and history, until retention removes it |
| Price rules | Disable the price policy. The schedule continues | Saved thresholds |
| ElOverblik | **Disconnect** (optionally `purgeHistory`) | Intervals and charges, unless purged |
| Spot prices | End or withdraw the spot contract | Cached prices, until retention removes them |
| PayPal checkout | Disable the environment in Admin → PayPal. Cancel subscriptions separately | Ledger, allocations, inbox evidence |
| Whole release | Roll back the images and restore the pre-upgrade backup. The Power & Energy migrations (`0004`–`0017`) are not reversible in place | n/a |

## 13. Live verification checklist

The owner must check each item on real hardware and accounts before relying on it. None of these has been verified.

**iLO (each model and firmware)**

- [ ] The test detects the correct generation, firmware, identity and current regulator mode, over verified TLS with your CA.
- [ ] The reported input watts roughly match a wall meter or PDU reading at idle and under load.
- [ ] A monitoring-only account works, and a wrong password auto-disables collection after three tries without locking the iLO account.
- [ ] A manual override to each of Low, Dynamic and High is applied and verified by read-back, and the write-privilege status becomes known. Choose and record the smallest working iLO privilege.
- [ ] Nothing else changes on the server: no reboot, BIOS change or power cap.
- [ ] The external-change hold triggers when you change the mode in the iLO UI, and both Resume and the boundary auto-release behave as described.
- [ ] Off and booting hosts are left alone.
- [ ] Watch a DST weekend (last Sunday of March or October) under the weekly schedule.

**ElOverblik**

- [ ] The token exchange works, your meter appears, and the 13-month backfill completes. Daily totals match the ElOverblik portal.
- [ ] Revoking the token produces *reconnect required* and one notification.

**Pricing and bills**

- [ ] The spot plus tariff plus VAT price for a sample hour matches your supplier invoice.
- [ ] A finalized month's statement agrees with the real bill, within the expected lab share.

**PayPal sandbox, then live with a small amount**

- [ ] The webhook is reachable only on its own path. Other paths return `401`/`403` from outside.
- [ ] One-off checkout, a monthly subscription through at least one installment, the actual fee, a partial and a full refund, and cancellation from PayPal's side all reconcile correctly.
- [ ] A reconciliation pass after a simulated webhook outage recovers the missed events.
- [ ] Sandbox amounts never appear in live totals.

**Backup**

- [ ] A restore into a scratch environment decrypts iLO, ElOverblik and PayPal secrets, and does not re-post PayPal events or re-send iLO commands.
