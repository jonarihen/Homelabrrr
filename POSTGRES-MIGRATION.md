# Homelabrrr — SQLite → PostgreSQL migration

This release moves Homelabrrr's entire data layer from **SQLite** to **PostgreSQL**, rewrites the backend on **Drizzle ORM** and **TypeScript**, and makes upgrading an existing install a single command. This document is a plain-language summary of what changed and exactly how to move over and keep up to date.

- Branch / PR: `pg-migration` → **[PR #151](https://github.com/jonarihen/Homelabrrr/pull/151)** (14 commits)
- Every feature works the same as before — this is an infrastructure change, not a functional one.

---

## TL;DR — how to upgrade

For an existing SQLite install, upgrading is automatic:

```bash
git pull
docker compose up -d --build
```

On the **first boot against an empty PostgreSQL database**, the backend finds the old `db.sqlite` (still sitting on the `db_data` volume) and imports it for you — users, hosts, keys, assignments, leases, audit history, and every encrypted secret — then never does it again. Watch it:

```bash
docker compose logs -f backend | grep sqlite_auto_import
curl --fail http://127.0.0.1:8181/api/health/ready
```

**Before you start:** add a database password to your `.env` and keep your existing `SECRET_ENCRYPTION_KEY` (see [Upgrade guide](#upgrade-guide) for the one required `.env` change and rollback).

---

## What changed

### Database

| Before | After |
| --- | --- |
| SQLite, one file on the `db_data` volume | **PostgreSQL 17** (bundled `postgres` service, or your own) |
| `better-sqlite3`, synchronous calls | **Drizzle ORM** over **node-postgres (`pg`)** with a shared pool |
| `0`/`1` integer flags | real `boolean` columns |
| `'YYYY-MM-DD HH:MM:SS'` text timestamps | `timestamptz` (ISO-8601 over the API) |
| JSON stored as `TEXT` | native `jsonb` |
| Binary as `BLOB` | `bytea` |
| Inline `CREATE TABLE IF NOT EXISTS` / `try…catch ALTER` | numbered SQL migrations under `backend/drizzle/`, applied by a small advisory-locked runner and recorded in `schema_migrations` |
| Session store in the SQLite file | Drizzle-backed session store |

Four references that used to dangle are now real `ON DELETE SET NULL` foreign keys, and the indexes PostgreSQL doesn't create automatically (foreign-key columns, retention scans) were added.

### Backend

- Now **TypeScript**, run directly on **Node 26** via native type stripping — **no build step** (`node src/index.ts`).
- The old `src/db.js` is replaced by a `src/db/` package: `schema/` (46 tables), `client.ts` (the pool), `migrate.ts` (the runner), `init.ts` (`initDatabase()`), `sessionStore.ts`, `errors.ts`, `settings.ts`.
- ~600 query call sites across ~40 modules were rewritten to async Drizzle. Where SQLite's synchronous behaviour mattered, the logic was redesigned to be correct on Postgres (the power scheduler uses an optimistic compare-and-set, lease and node-maintenance sweeps claim rows in transactions, rate limiters run as single transactions).

### Backups

- Nightly encrypted backups are now `pg_dump` custom-format archives (`homelabrrr-<stamp>.dump.enc`) instead of SQLite copies; the AES-256-GCM encryption, off-host copy, and retention behaviour are unchanged.
- Verification reads the archive's table of contents with `pg_restore --list`; restore goes through `pg_restore` into a **new** database.

### Deployment

- `docker compose` now starts a `postgres:17-alpine` service (its own `pg_data` volume); the backend waits for it to be healthy.
- The backend image dropped the native build toolchain and the root entrypoint (both existed only for SQLite file ownership) — it runs as `USER node` and carries the `postgresql17-client` for backups.
- The old `db_data` volume is **kept for one release** as the import source and rollback path.

### Verification (what was tested)

- 621 backend tests pass; lint clean; the database layer type-checks under full strict mode.
- A legacy SQLite fixture imports losslessly (every row/encrypted-value/bcrypt/audit count verified), and the server boots against the imported data and decrypts stored secrets.
- A real `docker compose up --build` against a seeded `db_data` volume auto-imports on first boot and does not re-import on restart.

---

## Upgrade guide

### The easy path (recommended)

1. **Add a database password** to your `.env` (the only new required value):

   ```dotenv
   POSTGRES_PASSWORD=choose-a-strong-password
   ```

   Keep your existing `SECRET_ENCRYPTION_KEY` exactly as it is — the encrypted columns are copied byte-for-byte and still need that key to decrypt. (See `.env.example` for the full PostgreSQL block, including how to point at an external database with `DATABASE_URL`.)

2. **Pull and rebuild:**

   ```bash
   git pull
   docker compose up -d --build
   ```

   Compose starts PostgreSQL, waits for it, then the backend applies its migrations and — seeing the empty database plus the old `db.sqlite` — imports it automatically before it starts serving.

3. **Confirm it:**

   ```bash
   docker compose logs backend | grep sqlite_auto_import
   curl --fail http://127.0.0.1:8181/api/health/ready
   ```

   You should see a `sqlite_auto_import_complete` line with the table/row counts. Sign in and spot-check **Admin → Operations**.

4. **Take a backup.** Once you have taken and verified your first PostgreSQL backup, you can remove the old `db_data` volume. Until then, keep it — it is your rollback.

**Safety guarantees of the auto-import:** it only ever runs into an **empty** database, only **once** (guarded by a `sqlite_auto_import` settings flag), never writes over existing data, and leaves the SQLite file untouched. If it finds rows that the new foreign keys would reject, it nulls just those references and reports the count.

### The manual path (opt-out)

Prefer to run the copy yourself — e.g. into an external database, or to inspect the verification table before starting the app? Set `AUTO_IMPORT_SQLITE=false` and follow the **Migrating from SQLite → The manual path** section in the README. In short:

```bash
docker compose stop backend
docker compose up -d postgres           # wait until healthy

# throwaway container: no native toolchain needed (reads via built-in node:sqlite)
docker run --rm \
  -v <project>_db_data:/old:ro \
  -v $(pwd)/backend:/app -w /app \
  --network <project>_internal \
  node:26.5.1-alpine sh -c "npm ci --omit=dev --ignore-scripts && \
    node src/scripts/importSqlite.ts --source /old/db.sqlite \
    --target postgres://homelabrrr:$POSTGRES_PASSWORD@postgres:5432/homelabrrr --null-orphans"

docker compose up -d --build backend frontend
curl --fail http://127.0.0.1:8181/api/health/ready
```

Import-tool flags: `--source`, `--target`, `--force` (allow a non-empty target), `--include-sessions`, `--null-orphans`.

### Rollback

The SQLite data on `db_data` is never modified, so reverting is:

```bash
git checkout <pre-migration-tag-or-commit>
docker compose up -d --build
```

Keep the `db_data` volume until your first PostgreSQL backup is verified.

---

## Keeping up to date after the move

Ongoing updates are the same one command:

```bash
git pull
docker compose up -d --build
```

Schema changes ship as new numbered files in `backend/drizzle/` and **apply themselves on boot** (the migration runner is transactional and advisory-locked, so it is safe even if the container restarts mid-way). There is no separate migration step to run.

For developers changing the schema: edit `src/db/schema`, run `npm run db:generate`, hand-trim the generated SQL file (drizzle-kit output is a draft), and commit it. Never edit an already-applied migration — add a new file. Full conventions are in `backend/docs/postgres-conventions.md`.

---

## New / changed environment variables

| Variable | Purpose |
| --- | --- |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | the bundled `postgres` service (only `POSTGRES_PASSWORD` is required) |
| `DATABASE_URL` | assembled from the above by Compose; set it directly to use an external PostgreSQL |
| `PG_POOL_SIZE` | max pooled connections (default `10`) |
| `AUTO_IMPORT_SQLITE` | `auto` (default) imports a legacy `db.sqlite` on first boot; `false` opts out |
| `DB_PATH` | legacy — now only the auto-import / import-tool source path |

`SESSION_SECRET`, `SECRET_ENCRYPTION_KEY`, and the `INITIAL_ADMIN_*` bootstrap variables are unchanged.
