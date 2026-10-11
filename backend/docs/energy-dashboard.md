# Private Energy & Budget read API

The router in `src/routes/energy.ts` mounts at `/api/energy` after the existing session, API-token scope, CSRF and 2FA middleware. All three GET endpoints require an authenticated interactive session and set `Cache-Control: private, no-store`:

- `/summary?month=YYYY-MM` uses the Europe/Copenhagen calendar month and returns one repeatable-read snapshot. `telemetry` contains currently fresh watts, integrated lab kWh, fleet coverage and observation age. `price`, `cost` and `funding` use `null` and `unavailable` until their own accounting services supply coherent values.
- `/history?range=24h|7d` returns at most 100 aggregate points from stored server samples. Each point includes the number of measured servers, so a partial fleet is visible.
- `/hosts` returns generated `Server 01` aliases, measured watts, observed hardware mode, age/staleness and monitoring state. It never returns node references, management addresses, serials, meter identifiers or credentials.

The member UI lives at `/energy`. This first integrated slice deliberately distinguishes measured values from cost forecasts and payment receipts. It contains no synthetic production data and performs no upstream fetch or control write during a page read. Mode policy reasons, retail price, cost components, PayPal ledger and budget allocation are integration work before issue #239 can close. The integration owner mounts the router in the shared `index.ts` during branch merge.
