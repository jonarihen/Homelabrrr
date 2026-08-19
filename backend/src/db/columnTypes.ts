import { customType } from 'drizzle-orm/pg-core';

// Postgres bytea <-> Node Buffer. Only webauthn_credentials.public_key uses it.
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
