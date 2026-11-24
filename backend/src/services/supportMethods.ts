import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { paypalSubscriptions } from '../db/schema/index.ts';

// Owner switches for the member-facing support methods. PayPal and Ko-fi keep
// their switch on their own configuration row; bank-transfer reports have no
// configuration, so their switch is a plain setting. Unset means enabled (the
// behaviour before the switch existed): only the stored string 'false' turns
// member reports off. Administrators can record and confirm transfers either way.

export const BANK_TRANSFER_SETTING = 'support_bank_transfer_enabled';

export async function bankTransferEnabled() {
  return (await getSetting(BANK_TRANSFER_SETTING)) !== 'false';
}
export async function setBankTransferEnabled(enabled: boolean) {
  await setSetting(BANK_TRANSFER_SETTING, enabled ? 'true' : 'false');
  return { enabled };
}

/** A live subscription PayPal may still bill: the member must be able to reach the page to cancel it. */
export async function hasOpenLiveSubscription(userId: number) {
  const [row] = await db.select({ id: paypalSubscriptions.id }).from(paypalSubscriptions).where(and(eq(paypalSubscriptions.user_id, userId),
    eq(paypalSubscriptions.environment, 'live'), notInArray(paypalSubscriptions.status, ['CANCELLED', 'EXPIRED']))).limit(1);
  return Boolean(row);
}
