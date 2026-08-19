// Postgres error-code helpers. Never branch on driver error message text —
// codes are the stable contract (conventions rule M9).

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  // Drizzle wraps driver errors (DrizzleQueryError) with the original on .cause.
  return e?.cause?.code ?? e?.code;
}

/** 23505 unique_violation — the replacement for `err.message.includes('UNIQUE')`. */
export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === '23505';
}

/** 23503 foreign_key_violation. */
export function isForeignKeyViolation(err: unknown): boolean {
  return pgCode(err) === '23503';
}
