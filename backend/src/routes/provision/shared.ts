import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { provisionedVms, users, sshKeys } from '../../db/schema/index.ts';
import { decodeNodeRef } from '../../utils/nodeRef.ts';
import { getRolePermissions } from '../../utils/permissions.ts';
import { resolveSshKeys, unusableKeysError, assertLoginPossible } from '../../utils/cloudInitCredentials.ts';
import { validatePassword } from '../../utils/validation.ts';

export function serializeNodeIdentity(nodeValue: any) {
  const { nodeName, nodeRef } = decodeNodeRef(nodeValue);
  return {
    node: nodeName || String(nodeValue || ''),
    nodeRef: nodeRef || String(nodeValue || ''),
  };
}

export function serializeProvisionRow(row: any) {
  // steps is a jsonb column — it arrives as an array already.
  const steps = Array.isArray(row.steps) ? row.steps : [];
  return {
    ...row,
    steps,
    ...serializeNodeIdentity(row.node),
  };
}

// ─── Deployment progress (step tracking) ─────────────────────────────────────
// Each provisioning job carries a JSON array of steps on its provisioned_vms
// row so the UI can render a live stepper. A step is { key, label, status },
// status ∈ 'pending' | 'active' | 'done' | 'error' | 'skipped'. Steps that
// finish synchronously before the row exists are seeded 'done' at insert time;
// the background pollers advance the rest.

// Normalize a step list into the jsonb-ready array stored on the row.
export function stepList(steps: any[]) {
  return steps.map((s) => ({ key: s.key, label: s.label, status: s.status || 'pending', note: s.note || '' }));
}

export async function setStep(provisionId: number, key: string, status: string, note?: string) {
  await db.transaction(async tx => {
    const [row] = await tx.select({ steps: provisionedVms.steps })
      .from(provisionedVms).where(eq(provisionedVms.id, provisionId)).for('update').limit(1);
    const steps: any[] = Array.isArray(row?.steps) ? (row!.steps as any[]) : [];
    const step = steps.find((s) => s.key === key);
    if (!step) return;
    step.status = status;
    if (note !== undefined) step.note = note;
    await tx.update(provisionedVms).set({ steps }).where(eq(provisionedVms.id, provisionId));
  });
}

// ─── Cloud-init option parsing (shared by clone + from-image) ────────────────
// Returns { opts } to hand to the config step, or { error: { status, message } }
// on a validation failure. SSH keys are always read from the requesting user's
// own stored keys.
//
// `cloudInitCapable` says the guest gets its credentials from cloud-init and
// nothing else (a cloud image, or a template flagged cloud_init). Those deploys
// must end up with a password or an installable key — see
// utils/cloudInitCredentials.js.

export async function parseCloudInitOptions(
  { ciUser, ciPassword, sshKeyIds, ipMode, ipAddress, ipGateway, allowNoLogin }: any,
  userId: number,
  cloudInitCapable = false,
): Promise<{ opts: any } | { error: { status: number; message: string } }> {
  const opts: any = {};
  if (ciUser) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(ciUser)) {
      return { error: { status: 400, message: 'Invalid cloud-init username (lowercase letters, digits, - and _)' } };
    }
    opts.ciUser = ciUser;
  }
  if (ciPassword) {
    try { opts.ciPassword = validatePassword(String(ciPassword), 'Cloud-init password'); }
    catch (err: any) { return { error: { status: 400, message: err.message } }; }
  }
  if (Array.isArray(sshKeyIds) && sshKeyIds.length > 0) {
    // Load every requested row — including the ones with no stored public key —
    // so a key that can't be installed is named back to the user instead of
    // being filtered out and the deploy running on with no key at all.
    const numericIds = sshKeyIds.map(Number).filter(Number.isInteger);
    const rows = numericIds.length > 0
      ? await db.select({ id: sshKeys.id, name: sshKeys.name, public_key: sshKeys.public_key })
        .from(sshKeys)
        .where(and(eq(sshKeys.user_id, userId), inArray(sshKeys.id, numericIds)))
      : [];
    const { keys, unusable } = resolveSshKeys(sshKeyIds, rows);
    if (unusable.length > 0) {
      return { error: { status: 400, message: unusableKeysError(unusable) } };
    }
    if (keys.length > 0) opts.sshKeys = keys.join('\n');
  }
  // A cloud image has no default password and a locked default user, so a deploy
  // with neither credential boots into a VM nobody can log into — unless the
  // user explicitly ticked "I know this VM will have no login".
  try {
    assertLoginPossible({ ciPassword: opts.ciPassword, sshKeys: opts.sshKeys, cloudInitCapable, allowNoLogin: allowNoLogin === true });
  } catch (err: any) {
    return { error: { status: err.status || 400, message: err.message } };
  }
  if (ipMode === 'static') {
    if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(ipAddress || '')) {
      return { error: { status: 400, message: 'Static IP must be in CIDR form, e.g. 10.0.20.50/24' } };
    }
    if (ipGateway && !/^(\d{1,3}\.){3}\d{1,3}$/.test(ipGateway)) {
      return { error: { status: 400, message: 'Gateway must be an IPv4 address' } };
    }
    opts.ipConfig = ipGateway ? `ip=${ipAddress},gw=${ipGateway}` : `ip=${ipAddress}`;
  } else if (ipMode === 'dhcp') {
    opts.ipConfig = 'ip=dhcp';
  }
  return { opts };
}

// A non-admin needs can_provision to reach clone / from-image / images.
// can_provision here is the effective value: role assigned → the role
// decides; no role → the per-user column.
export async function loadProvisioner(req: any) {
  const [user] = await db
    .select({
      id: users.id, can_provision: users.can_provision, is_admin: users.is_admin, role_id: users.role_id,
    })
    .from(users)
    .where(eq(users.id, req.session.userId))
    .limit(1);
  if (!user) return user;
  return {
    ...user,
    can_provision: user.role_id
      ? (await getRolePermissions(user.role_id)).has('can_provision')
      : user.can_provision,
  };
}
