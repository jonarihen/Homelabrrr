import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.ts';
import { log } from '../utils/logger.ts';

// Single shared pool + Drizzle instance for the whole backend. The Pool is
// lazy — no connection is opened at import time, so importing this module is
// always safe; the first query (initDatabase()) establishes connectivity.
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL must be set before the application can start');
}

export const pool = new pg.Pool({
  connectionString: url,
  max: Number(process.env.PG_POOL_SIZE || 10),
});

// An idle client erroring (e.g. the server restarted) must never crash the
// process — the pool replaces the client on next checkout.
pool.on('error', (err) => {
  log('warn', 'pg_pool_idle_client_error', { error: err?.message });
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;
// The transaction callback parameter — structurally compatible with Db for
// every query surface the app uses. Modules that accept an injected database
// (conventions rule M14) type it as DbOrTx.
export type DbOrTx = Pick<Db, 'select' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction' | 'query'>;

export async function closeDb(): Promise<void> {
  await pool.end();
}
