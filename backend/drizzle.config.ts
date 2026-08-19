import { defineConfig } from 'drizzle-kit';

// Generation only: `npm run db:generate` diffs src/db/schema against ./drizzle.
// Migrations are applied by src/db/migrate.ts (not drizzle-kit push/migrate),
// which records versions in the schema_migrations table.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
});
