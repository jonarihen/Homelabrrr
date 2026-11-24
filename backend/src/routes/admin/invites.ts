import { Router } from 'express';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { users, invites, vmAssignments } from '../../db/schema/index.ts';
import { sanitizeError } from '../../utils/sanitize.ts';
import { sendError } from '../../utils/httpError.ts';
import { logAudit } from '../../utils/audit.ts';
import { syncVmTagsSafe } from '../../utils/vmTags.ts';
import { generateInviteToken, hashInviteToken, normalizeInvitePreset, summarizeInvitePreset, inviteStatus } from '../../utils/invites.ts';
import { revokeUserSftpSessions } from '../../utils/sftpSessions.ts';
import { closeUserConsoles } from '../../utils/consoleSockets.ts';
import { assertUserCanBeDeleted } from '../../services/provisionOwnership.ts';
import { cancelSubscriptionsBeforeUserDeletion } from '../../services/paypal.ts';
import { PayPalError } from '../../services/paypalClient.ts';
import { pUsers } from './shared.ts';
import { ensureCanManageTargetUser } from './userHelpers.ts';

const router = Router();

// ─── Invites (one-time self-registration links) ──────────────────────────────
// Managed by can_manage_users. Generate returns the raw token exactly once (the
// DB only ever holds its hash); the admin UI turns it into a shareable URL.

router.get('/invites', pUsers, async (req, res) => {
  const rows = await db.select().from(invites).orderBy(desc(invites.created_at));
  res.json(await Promise.all(rows.map(async (row) => {
    // preset is a jsonb column — already an object.
    const preset = row.preset || {};
    return {
      id: row.id,
      status: inviteStatus(row),
      createdBy: row.created_by_username,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedBy: row.used_by_username,
      revokedAt: row.revoked_at,
      requires2fa: !!row.require_2fa,
      preset: await summarizeInvitePreset(preset),
    };
  })));
});

router.post('/invites', pUsers, async (req, res) => {
  const result = await normalizeInvitePreset(req.body, {
    allowAdmin: !!req.session.isAdmin,
    allowPrivileges: !!req.session.isAdmin,
  });
  if ('error' in result) return res.status(400).json({ error: result.error });
  const { preset } = result;

  // Expiry: positive number of days, or empty/omitted for "never expires".
  let expiresAt: Date | null = null;
  const rawExpiry = req.body.expiresInDays;
  if (rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== '') {
    const days = parseInt(rawExpiry, 10);
    if (!Number.isInteger(days) || days <= 0) {
      return res.status(400).json({ error: 'Expiry must be a positive number of days (empty = never)' });
    }
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const require2fa = req.body.require2fa ? 1 : 0;
  const token = generateInviteToken();
  const tokenHash = hashInviteToken(token);

  // preset is a jsonb column — pass the object directly.
  const [r] = await db.insert(invites).values({
    token_hash: tokenHash, created_by: req.session.userId, created_by_username: req.session.username,
    preset, require_2fa: !!require2fa, expires_at: expiresAt,
  }).returning({ id: invites.id });

  await logAudit(req, 'admin_create_invite', `invite #${r.id}`, `role=${(preset as any).roleId ?? 'none'} require2fa=${require2fa}`);

  // Raw token returned ONCE — never persisted, never retrievable again.
  res.json({
    id: r.id,
    token,
    expiresAt,
    requires2fa: !!require2fa,
    preset: await summarizeInvitePreset(preset),
  });
});

router.delete('/invites/:id', pUsers, async (req, res) => {
  const [invite] = await db.select().from(invites).where(eq(invites.id, Number(req.params.id))).limit(1);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  if (invite.used_at) return res.status(400).json({ error: 'Invite has already been used' });
  if (invite.revoked_at) return res.status(400).json({ error: 'Invite is already revoked' });
  await db.update(invites).set({ revoked_at: new Date() }).where(eq(invites.id, invite.id));
  await logAudit(req, 'admin_revoke_invite', `invite #${invite.id}`, '');
  res.json({ ok: true });
});

router.delete('/users/:id', pUsers, async (req, res) => {
  if (!await ensureCanManageTargetUser(req, res, req.params.id)) return;
  if (parseInt(req.params.id) === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  // Keep the member and financial mapping until every provider subscription
  // has a confirmed terminal state. Checkout being disabled does not stop bills.
  try { await cancelSubscriptionsBeforeUserDeletion(Number(req.params.id)); }
  catch (err) {
    if (err instanceof PayPalError) return res.status(err.status).json({ error: err.code });
    return res.status(500).json({ error: sanitizeError(err) });
  }
  // Assignments cascade away with the user — capture them (and the username,
  // which won't exist anymore) so the owner tags get cleared from PVE.
  let deleted;
  try {
    deleted = await db.transaction(async tx => {
      await assertUserCanBeDeleted(tx, Number(req.params.id));
      const [target] = await tx.select({ username: users.username }).from(users).where(eq(users.id, Number(req.params.id))).limit(1);
      const orphanedVms = await tx.select({ node: vmAssignments.node, vmid: vmAssignments.vmid })
        .from(vmAssignments).where(eq(vmAssignments.user_id, Number(req.params.id)));
      await tx.delete(users).where(eq(users.id, Number(req.params.id)));
      return { target, orphanedVms };
    });
  } catch (err) { return sendError(res, err); }
  const { target, orphanedVms } = deleted;
  revokeUserSftpSessions(Number(req.params.id));
  closeUserConsoles(Number(req.params.id));
  await logAudit(req, 'admin_delete_user', req.params.id, '');
  for (const vm of orphanedVms) {
    await syncVmTagsSafe(vm.node, vm.vmid, { retired: [target?.username].filter(Boolean) });
  }
  res.json({ ok: true });
});

export default router;
