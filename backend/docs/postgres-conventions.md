# PostgreSQL + Drizzle conversion conventions

This document is the contract for every module converted from synchronous better-sqlite3
to async Drizzle/PostgreSQL. Follow it exactly; deviations belong in a review comment, not in code.

## Schema property naming

Schema property keys are **snake_case, identical to the column names** (`stop_time`, not
`stopTime`). Row objects serialize directly into API responses in many routes; camelCase keys
would silently change the frontend JSON contract. Table export names are camelCase
(`export const vmSchedules = pgTable('vm_schedules', ...)`).

## Imports and structure

- Import the database as `import { db } from '../db/client.ts'` (adjust depth). Schema tables come
  from `import { users, vlans, ... } from '../db/schema/index.ts'`.
- Import specifiers always carry the explicit `.ts` extension (Node native type stripping).
- TypeScript must be **erasable-syntax-only**: no `enum` (use `const X = {...} as const`),
  no `namespace`, no constructor parameter properties.
- **S1 — no module-scope DB access, no module-scope timers.** Anything that ran at import time
  moves into an exported function invoked from `src/index.ts` after `initDatabase()` resolves,
  or lazily on first call. Module-scope `db.prepare(...)` handles, seed calls, `setInterval`/
  `setTimeout` registrations are all forbidden at import time.

## Mechanical rules

- **M1 sync → async.** Any function that touches the DB becomes `async`; every caller awaits it
  (ripple upward, including through utils). Express 5 forwards rejected promises from async
  handlers to the error middleware — converting a handler to `async (req, res) => {}` is safe
  and requires no wrapper.
- **M2 reads.** `stmt.get(...)` → `const [row] = await db.select().from(t).where(...).limit(1);`
  (`row` is `undefined` when absent — same contract as before).
  `stmt.all(...)` → `await db.select()...`. Column subsets via `db.select({ a: t.a, ... })`.
- **M3 writes.** `stmt.run(...)` → `db.insert(...)` / `db.update(...)` / `db.delete(...)`.
  - `.lastInsertRowid` → `.returning({ id: t.id })`, use `rows[0].id`.
  - `.changes` → the query result's `rowCount`.
  - **Atomic claim guards must keep their predicate**: `UPDATE ... WHERE id = ? AND status = 'expected'`
    with a `rowCount === 1` check is the concurrency story at
    `routes/migrate.ts` (finalize), `routes/vms.ts` (backup finish), `utils/accountSecurity.ts`
    (recovery-code consume). Do not "simplify" these into read-then-write.
- **M4 transactions.** `db.transaction(() => {...})()` → `await db.transaction(async (tx) => {...})`.
  **Every statement inside the callback uses `tx`, never `db`** — using `db` inside a transaction
  checks out a second pool connection and can deadlock/starve the pool. Return values pass through
  the transaction call. Throwing rolls back (same as before).
- **M5 upserts.** `ON CONFLICT(...) DO UPDATE` → `.onConflictDoUpdate({ target, set })`;
  `INSERT OR IGNORE` → `.onConflictDoNothing()`. The key/value settings upsert is
  `setSetting(key, value)` from `src/db/settings.ts` — never hand-roll it again.
- **M6 booleans.** Flag columns are real `boolean` now. Rewrite `=== 1`/`!== 0` reads to
  truthiness and `? 1 : 0` writes to real booleans. Exceptions that stay numeric:
  `vm_schedules.last_off` (tri-state -1/0/1) and `vm_schedules.days` (7-bit mask).
- **M7 jsonb.** Columns typed `jsonb` in the schema arrive/depart as objects — delete the
  surrounding `JSON.parse`/`JSON.stringify`. `settings.value` stays `text`: keep parsing there.
- **M8 dates.** Timestamp columns are JS `Date` in and out.
  - `datetime('now')` value writes → omit (column default) or `new Date()`.
  - `datetime('now', '+N days')`-style arithmetic → `sql`now() + make_interval(days => ${n})``.
  - Never string-interpolate a date expression into SQL text; use `sql` fragments or computed `Date`s.
  - Comparisons in SQL: `lt(t.expiresAt, new Date())` or `sql`${t.expiresAt} < now()``.
- **M9 unique violations.** Any `err.message.includes('UNIQUE')` (and the bare catch variants) →
  `isUniqueViolation(err)` from `src/db/errors.ts` (PG error 23505; checks `err.code` and
  `err.cause?.code`). Unrecognized errors rethrow — no bare swallows.
- **M10 IN lists.** Placeholder-list generation (`ids.map(() => '?').join(',')`) →
  `inArray(t.col, values)`. **Guard `values.length === 0` with an early return first** —
  empty arrays are a Drizzle footgun.
- **M11 dynamic identifiers.** Interpolated column/table names must be whitelist-checked
  (e.g. against `PERMISSION_KEYS`) and then emitted via `sql.identifier(name)`.
  Shared SELECT fragments (`ASSIGNMENT_SELECT`, `SITE_SELECT`) become shared column-map
  objects passed to `db.select({...})`.
- **M12** = S1 above (no module-scope DB/timers).
- **M13 fire-and-forget writes.** DB writes inside `res.on('finish')` handlers (mutation audit)
  or other places that cannot await: call the async function and attach
  `.catch((err) => log('warn', ...))`. An audit failure must never crash the process.
- **M14 parameter-injected db.** Modules that already take `database` as a parameter
  (`utils/accountSecurity.ts`, `services/operationReconciliation.ts`, `utils/vlanSubnets.ts`,
  `utils/vlanAccess.ts`) keep that shape, typed as the Drizzle db/tx instance.

## Error handling

- 500 paths still go through `sanitizeError`; meaningful admin actions still `logAudit` (now awaited
  or M13'd).
- Never branch on driver error message text. `src/db/errors.ts` exports `isUniqueViolation` (23505)
  and `isForeignKeyViolation` (23503).

## Testing

- DB-touching tests use `createTestDatabase()` from `src/testUtils/pgTestDb.ts` (real schema,
  per-file throwaway database). No hand-rolled DDL fixtures.
- Tests fail loudly when `TEST_DATABASE_URL` is unreachable — no silent skips.

## While you're in there

- Fix obvious N+1 query loops in the files you own (query-per-item `.map()` bodies) with a single
  `inArray`/join/grouped query. Do not restructure beyond that.
- Match surrounding comment density and style; update comments that describe SQLite behavior.
