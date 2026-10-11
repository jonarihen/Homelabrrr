import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../testUtils/pgTestDb.ts';
import { manualContributions, paypalPostings, paypalTransactions, users } from '../db/schema/index.ts';

process.env.SECRET_ENCRYPTION_KEY = '78'.repeat(32);
const fixture = await createTestDatabase();
process.env.DATABASE_URL = fixture.url;
test.after(() => fixture.drop());
const manual = await import('./manualContributions.ts');
const { verifiedContributionSnapshot } = await import('./paypal.ts');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());
const postings = async () => (await fixture.db.select().from(paypalPostings)).map((row) => `${row.merchant_id}:${row.posting_kind}:${row.amount_ore}`).sort();

test.before(async () => {
  await fixture.db.insert(users).values([{ id: 1, username: 'member-manual', password: 'unused' }, { id: 2, username: 'admin-manual', password: 'unused', is_admin: true }]);
});

test('a member report is evidence only until an admin confirms it with evidence', async () => {
  const report = await manual.reportManualContribution(1, { amount: '250.00', reference: 'Bank ref 2026-10-AB12', receivedOn: today });
  assert.equal(report.status, 'reported');
  assert.deepEqual(await postings(), [], 'unverified reports never post');
  assert.equal((await verifiedContributionSnapshot('live')).grossOre, 0);
  await assert.rejects(manual.confirmManualContribution(2, report.id, { evidence: '' }), /EVIDENCE_REQUIRED/);
  await manual.confirmManualContribution(2, report.id, { evidence: 'Statement line 14' });
  await assert.rejects(manual.confirmManualContribution(2, report.id, { evidence: 'again' }), /MANUAL_ALREADY_DECIDED/);
  assert.deepEqual(await postings(), ['manual:gross:25000']);
  assert.equal((await verifiedContributionSnapshot('live')).knownNetOre, 25000);
});

test('duplicate references and already imported PayPal payments are refused', async () => {
  await assert.rejects(manual.reportManualContribution(1, { amount: '250.00', reference: 'bank-ref 2026 10 ab12', receivedOn: today }), /DUPLICATE_REFERENCE/);
  await fixture.db.insert(paypalTransactions).values({ environment: 'live', merchant_id: 'MERCHANT123', provider_transaction_id: '8AB12345CD678901E',
    provider_kind: 'capture', status: 'posted', currency: 'DKK', gross_ore: 10000 });
  await assert.rejects(manual.recordManualContribution(2, { amount: '100.00', reference: '8AB12345CD678901E', receivedOn: today, evidence: 'x-ref' }),
    /DUPLICATE_PROVIDER_PAYMENT/);
  await fixture.db.insert(paypalPostings).values({ environment: 'live', merchant_id: 'MERCHANT123', provider_transaction_id: 'CAPLIVE1', posting_kind: 'gross',
    source_id: 'CAPLIVE1', user_id: 1, amount_ore: 5000, currency: 'DKK', effective_at: new Date(), verification: 'fixture' });
  const similar = await manual.reportManualContribution(1, { amount: '50.00', reference: 'TRANSFER-5555', receivedOn: today });
  await assert.rejects(manual.confirmManualContribution(2, similar.id, { evidence: 'statement' }), /SIMILAR_PROVIDER_PAYMENT/);
  await manual.confirmManualContribution(2, similar.id, { evidence: 'statement; separate transfer confirmed', acknowledgeSimilar: true });
  const rejected = await manual.reportManualContribution(1, { amount: '10.00', reference: 'REJECTME1', receivedOn: today });
  await manual.rejectManualContribution(2, rejected.id, { reason: 'not received' });
  assert.equal((await manual.reportManualContribution(1, { amount: '10.00', reference: 'REJECTME1', receivedOn: today })).status, 'reported',
    'a rejected reference can be reported again');
});

test('reversal appends a linked negative posting and keeps history', async () => {
  const [row] = await fixture.db.select().from(manualContributions).where(eq(manualContributions.reference_key, 'BANKREF202610AB12'));
  await manual.reverseManualContribution(2, row.id, { reason: 'bank returned transfer' });
  await assert.rejects(manual.reverseManualContribution(2, row.id, { reason: 'twice' }), /MANUAL_NOT_CONFIRMED/);
  assert.ok((await postings()).includes('manual:reversal:-25000'));
  assert.ok((await postings()).includes('manual:gross:25000'), 'the original posting is never deleted');
  await assert.rejects(manual.reportManualContribution(1, { amount: '1.00', reference: 'x', receivedOn: today }), /INVALID_REFERENCE/);
  await assert.rejects(manual.reportManualContribution(1, { amount: '1.00', reference: 'FUTURE1', receivedOn: '2999-01-01' }), /INVALID_DATE/);
  await assert.rejects(manual.reportManualContribution(1, { amount: '-1', reference: 'NEGATIVE1', receivedOn: today }), /INVALID_AMOUNT/);
});
