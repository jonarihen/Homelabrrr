import crypto from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema/index.ts';
import { runMigrations } from '../db/migrate.ts';

// Per-test-file throwaway PostgreSQL database with the real schema applied.
// Tests fail loudly when the server is unreachable — a silently skipped DB
// test rots. Start one locally with:
//   docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18-alpine
// (CI provides the same as a service container.)
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

export interface TestDatabase {
  /** Connection URL of the throwaway database (pass as DATABASE_URL to subprocesses). */
  url: string;
  name: string;
  pool: pg.Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `homelabrrr_test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach the test PostgreSQL server at ${ADMIN_URL.replace(/\/\/[^@]*@/, '//***@')} — start one (see src/testUtils/pgTestDb.ts) or set TEST_DATABASE_URL. (${(err as Error).message})`
    );
  }
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const dbUrl = url.toString();

  const pool = new pg.Pool({ connectionString: dbUrl, max: 5 });
  await runMigrations(pool);
  const db = drizzle(pool, { schema });

  return {
    url: dbUrl,
    name,
    pool,
    db,
    async drop() {
      await pool.end();
      const cleaner = new pg.Client({ connectionString: ADMIN_URL });
      await cleaner.connect();
      await cleaner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleaner.end();
    },
  };
}
