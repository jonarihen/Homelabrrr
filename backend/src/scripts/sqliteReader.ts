import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

// A minimal read-only SQLite adapter over Node's built-in node:sqlite, exposing
// just the better-sqlite3 surface the import tool uses. Using the built-in
// module means the import runs with ZERO extra dependencies — including inside
// the production backend image, which is what makes auto-import-on-boot
// possible (better-sqlite3 is only a devDependency).

interface ReaderStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

export interface SqliteReader {
  prepare(sql: string): ReaderStatement;
  pragma(name: string, opts?: { simple?: boolean }): unknown;
  close(): void;
}

export function openSqliteReadonly(path: string): SqliteReader {
  // Open as immutable: SQLite treats the file as never-changing, so it needs no
  // -wal/-shm sidecars, no locks, and no write access to the file or its
  // directory. That is exactly right for importing a legacy database — and it
  // is what lets auto-import read a WAL-mode db.sqlite the server user does not
  // own (a plain read-only open would try to create a -shm and fail). The URI
  // form requires an absolute, encoded path. A missing file still throws.
  const uri = `file:${encodeURI(resolve(path)).replace(/\?/g, '%3f').replace(/#/g, '%23')}?immutable=1`;
  const db = new DatabaseSync(uri, { readOnly: true });
  return {
    prepare(sql: string): ReaderStatement {
      const stmt = db.prepare(sql);
      return {
        all: (...params: unknown[]) => stmt.all(...(params as never[])),
        get: (...params: unknown[]) => stmt.get(...(params as never[])),
        iterate: (...params: unknown[]) => stmt.iterate(...(params as never[])) as IterableIterator<unknown>,
      };
    },
    pragma(name: string, opts?: { simple?: boolean }): unknown {
      const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
      if (opts?.simple) {
        return row ? Object.values(row)[0] : undefined;
      }
      return row;
    },
    close() {
      db.close();
    },
  };
}
