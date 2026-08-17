import { sql, eq } from 'drizzle-orm';
import { db, type DbOrTx } from './client.ts';
import { settings } from './schema/index.ts';

// The key/value settings table. This is the ONLY sanctioned upsert for it —
// the SQLite codebase repeated the same ON CONFLICT statement in 8+ places.

export async function setSetting(key: string, value: string, database: DbOrTx = db): Promise<void> {
  await database
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } });
}

export async function getSetting(key: string, database: DbOrTx = db): Promise<string | null> {
  const [row] = await database.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return row ? row.value : null;
}

export async function deleteSetting(key: string, database: DbOrTx = db): Promise<void> {
  await database.delete(settings).where(eq(settings.key, key));
}
