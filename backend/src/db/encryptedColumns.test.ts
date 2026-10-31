import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../testUtils/pgTestDb.ts';
import { eloverblikConnections, paypalConfigs } from './schema/index.ts';

// init.ts and secrets.ts read DATABASE_URL / SECRET_ENCRYPTION_KEY at import
// time, so they are imported after the throwaway database exists.
let testDb: TestDatabase;
let closeDb: (() => Promise<void>) | undefined;

before(async () => {
  testDb = await createTestDatabase();
  process.env.DATABASE_URL = testDb.url;
  process.env.SECRET_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';
  ({ closeDb } = await import('./client.ts'));
});

after(async () => {
  await closeDb?.();
  await testDb?.drop();
});

test('power and energy credentials take part in secret rotation', async () => {
  const { planEncryptedSecretRotation, rotateEncryptedSecrets } = await import('./init.ts');
  const { decryptSecret, isEncryptedSecret } = await import('../utils/secrets.ts');
  await testDb.db.insert(eloverblikConnections).values({ id: 1, refresh_token: 'plain-refresh-token' });
  await testDb.db.insert(paypalConfigs).values({ environment: 'sandbox', client_secret: 'plain-client-secret' });

  const plan = await planEncryptedSecretRotation();
  assert.equal(plan.columns['hardware_connections.secret'], 0);
  assert.equal(plan.columns['eloverblik_connections.refresh_token'], 1);
  assert.equal(plan.columns['paypal_configs.client_secret'], 1);

  await rotateEncryptedSecrets();
  const [meter] = await testDb.db.select().from(eloverblikConnections).where(eq(eloverblikConnections.id, 1));
  const [paypal] = await testDb.db.select().from(paypalConfigs).where(eq(paypalConfigs.environment, 'sandbox'));
  assert.ok(isEncryptedSecret(meter.refresh_token!));
  assert.ok(isEncryptedSecret(paypal.client_secret!));
  assert.equal(decryptSecret(meter.refresh_token!), 'plain-refresh-token');
  assert.equal(decryptSecret(paypal.client_secret!), 'plain-client-secret');
});

test('startup check flags a secret encrypted under a different key with the same key id', async () => {
  const { countUndecryptableSecrets } = await import('./init.ts');
  const { encryptSecret } = await import('../utils/secrets.ts');
  assert.equal(await countUndecryptableSecrets(), 0);
  // Right envelope and current key id, but ciphertext made with another key.
  const good = encryptSecret('x');
  const [iv, , ct] = good.split('.');
  const forged = `${iv}.${Buffer.alloc(16, 7).toString('base64url')}.${ct}`;
  await testDb.db.update(paypalConfigs).set({ client_secret: forged }).where(eq(paypalConfigs.environment, 'sandbox'));
  assert.equal(await countUndecryptableSecrets(), 1);
});
