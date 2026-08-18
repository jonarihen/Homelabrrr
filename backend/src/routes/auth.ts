import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { generateTotpSecret, totpKeyUri, verifyTotp } from '../utils/totp.ts';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, count, desc, eq, gt, isNull, lt, max } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  apiTokens, invites, loginAttempts, recoveryCodes, sessions, twoFactorAttempts,
  users, userVlans, vmAssignments, webauthnCredentials,
} from '../db/schema/index.ts';
import { isUniqueViolation } from '../db/errors.ts';
import { requireAuth, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import { warnIfProxyMismatch } from '../middleware/trustProxyCheck.ts';
import { logAudit } from '../utils/audit.ts';
import { notify, portalLink } from '../utils/notify.ts';
import { decryptSecret, encryptSecret } from '../utils/secrets.ts';
import { syncVmTagsSafe } from '../utils/vmTags.ts';
import { generateApiToken, hashApiToken } from '../utils/apiTokens.ts';
import { effectivePermissions } from '../utils/permissions.ts';
import { hashInviteToken, inviteStatus, summarizeInvitePreset, INVITE_PERMISSION_COLUMNS } from '../utils/invites.ts';
import type { StoredInvitePreset } from '../utils/invites.ts';
import { API_TOKEN_SCOPES } from '../utils/apiTokenScopes.ts';
import { validateObject, validatePassword, validateUsername } from '../utils/validation.ts';
import {
  consumeRecoveryCode, hashRecoveryCode, parseStoredSession, removeWebauthnCredential,
  resolveWebauthnConfig, revokeOtherStoredSessions, revokeStoredSession,
} from '../utils/accountSecurity.ts';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MAX      = 10;
const TWO_FACTOR_WINDOW_MS = 10 * 60 * 1000;
const TWO_FACTOR_MAX      = 6;

const verifyTwoFactorLimiter = rateLimit({
  windowMs: TWO_FACTOR_WINDOW_MS,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many two-factor verification attempts, please try again later.' },
});

async function serializeUser(user: any) {
  // Effective permissions: legacy per-user column OR role grant (async now).
  const perms = await effectivePermissions(user);
  return {
    id: user.id,
    username: user.username,
    isAdmin: !!user.is_admin,
    twoFactorEnabled: !!user.totp_enabled,
    require2fa: !!user.require_2fa,
    roleId: user.role_id || null,
    canProvision: perms.can_provision,
    canCreateVms: perms.can_create_vms,
    permissions: {
      // Fleet reach, split (issue #73): seeAllVms is read-only, canOperateAllVms
      // is what carries power/console/edit rights across every VM.
      seeAllVms: perms.see_all_vms,
      canOperateAllVms: perms.can_operate_all_vms,
      canManageHosts: perms.can_manage_hosts,
      canManageFirewalls: perms.can_manage_firewalls,
      canManagePortForwards: perms.can_manage_port_forwards,
      canManageVlans: perms.can_manage_vlans,
      canManagePolicies: perms.can_manage_policies,
      canManageTemplates: perms.can_manage_templates,
      canManageUsers: perms.can_manage_users,
      canManageAssignments: perms.can_manage_assignments,
      canViewAuditLog: perms.can_view_audit_log,
      canEditVmHardware: perms.can_edit_vm_hardware,
      canManageWebsites: perms.can_manage_websites,
      canManagePublicIps: perms.can_manage_public_ips,
    },
  };
}

function startUserSession(req: any, user: any, { twoFactorEnrollmentOnly = false } = {}) {
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = !!user.is_admin;
  req.session.twoFactorEnrollmentOnly = twoFactorEnrollmentOnly;
  req.session.reauthenticatedAt = Date.now();
  req.session.createdAt ||= Date.now();
  req.session.lastSeenAt = Date.now();
  req.session.clientIp = String(req.ip || '').slice(0, 128);
  req.session.userAgent = String(req.headers['user-agent'] || '').slice(0, 256);
}

function clearPendingAuth(req: any) {
  delete req.session.pendingUserId;
  delete req.session.pendingUsername;
  delete req.session.pendingIsAdmin;
}

function regenerateSession(req: any): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ─── 2FA attempt limiter (two_factor_attempts) ───────────────────────────────
// attempted_at is stored as epoch-ms (bigint mode:number), not a timestamp.
// Redesign R8: each accounting touch is one short transaction so the prune,
// count, and insert observe a single consistent window.

// Prune expired rows and return the number of attempts still inside the window.
async function pruneAndCountTwoFactor(username: string): Promise<number> {
  const windowStart = Date.now() - TWO_FACTOR_WINDOW_MS;
  return db.transaction(async (tx) => {
    await tx.delete(twoFactorAttempts).where(lt(twoFactorAttempts.attempted_at, windowStart));
    const [{ c }] = await tx
      .select({ c: count() })
      .from(twoFactorAttempts)
      .where(and(eq(twoFactorAttempts.username, username), gt(twoFactorAttempts.attempted_at, windowStart)));
    return c;
  });
}

// Record one failed attempt (pruning first) and return the new in-window count.
async function recordTwoFactorFailure(username: string): Promise<number> {
  const now = Date.now();
  const windowStart = now - TWO_FACTOR_WINDOW_MS;
  return db.transaction(async (tx) => {
    await tx.delete(twoFactorAttempts).where(lt(twoFactorAttempts.attempted_at, windowStart));
    await tx.insert(twoFactorAttempts).values({ username, attempted_at: now });
    const [{ c }] = await tx
      .select({ c: count() })
      .from(twoFactorAttempts)
      .where(and(eq(twoFactorAttempts.username, username), gt(twoFactorAttempts.attempted_at, windowStart)));
    return c;
  });
}

async function clearTwoFactorAttempts(username: string): Promise<void> {
  await db.delete(twoFactorAttempts).where(eq(twoFactorAttempts.username, username));
}

// ─── Login ────────────────────────────────────────────────────────────────────

// Dummy hash compared against when the username doesn't exist, so unknown and
// known usernames take the same time (blocks user enumeration via timing).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('homelabrrr-timing-equalizer', 10);

router.post('/login', loginLimiter, async (req, res, next) => {
  try { validateObject(req.body, { fields: ['username', 'password'], required: ['username', 'password'] }); }
  catch (err: any) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const now = Date.now();
  const windowStart = now - LOCKOUT_WINDOW_MS;
  // Lockout is scoped to (username, ip) — a username-only lockout lets any
  // unauthenticated party lock an arbitrary account (targeted DoS) with a
  // handful of bad passwords. Requires TRUST_PROXY to match the real proxy
  // hop count so req.ip is the actual client.
  const clientIp = String(req.ip || '');

  // A wrong TRUST_PROXY makes every client resolve to the same proxy address,
  // which turns this per-IP lockout back into the global one issue #11 removed.
  // Warn loudly (once per process) — but keep applying the lockout: dropping it
  // in this state would be the weaker option, because a client that can reach
  // the portal from a private address can *force* the "suspicious" verdict by
  // forging X-Forwarded-For, and would then be brute-forcing with no lockout at
  // all. A misconfiguration must never be a cheaper bypass than the protection.
  warnIfProxyMismatch(req);

  // Prune expired attempts and read the in-window (username, ip) count in one
  // short transaction. attempted_at is epoch-ms.
  const attemptCount = await db.transaction(async (tx) => {
    await tx.delete(loginAttempts).where(lt(loginAttempts.attempted_at, windowStart));
    const [{ c }] = await tx
      .select({ c: count() })
      .from(loginAttempts)
      .where(and(
        eq(loginAttempts.username, username),
        eq(loginAttempts.ip, clientIp),
        gt(loginAttempts.attempted_at, windowStart),
      ));
    return c;
  });

  if (attemptCount >= LOCKOUT_MAX) {
    return res.status(423).json({ error: 'Too many failed attempts for this account from your address. Try again in 10 minutes or contact an admin.' });
  }

  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const passwordOk = bcrypt.compareSync(password, user ? user.password : DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) {
    await db.insert(loginAttempts).values({ username, ip: clientIp, attempted_at: now });
    await logAudit({ session: { username: username }, headers: req.headers, ip: req.ip } as any, 'login_failed', username, '');
    const remaining = LOCKOUT_MAX - (attemptCount + 1);
    if (remaining <= 0) {
      // This failed attempt just tripped the lockout — notify once (subsequent
      // attempts short-circuit at the guard above, so this fires a single time).
      notify('security.lockout', {
        domain: username,
        status: 'locked out',
        detail: `Account locked after ${LOCKOUT_MAX} failed logins from ${clientIp || 'unknown address'}`,
        url: portalLink('/admin/audit-log'),
      });
      return res.status(423).json({ error: 'Too many failed attempts for this account from your address. Try again in 10 minutes or contact an admin.' });
    }
    return res.status(401).json({ error: `Invalid credentials (${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout)` });
  }

  // Clear only this (username, ip) pair — clearing all rows would reset an
  // attacker's counter on another address every time the real user logs in.
  // Admin "Unlock" still clears every address for the account.
  await db.delete(loginAttempts).where(and(eq(loginAttempts.username, username), eq(loginAttempts.ip, clientIp)));

  try {
    await regenerateSession(req);

    // If 2FA is enabled, set a pending state and ask for the code
    if (user.totp_enabled) {
      req.session.pendingUserId = user.id;
      req.session.pendingUsername = user.username;
      req.session.pendingIsAdmin = !!user.is_admin;
      const [passkey] = await db
        .select({ id: webauthnCredentials.id })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.user_id, user.id))
        .limit(1);
      const hasPasskey = !!passkey;
      return res.json({ requiresTwoFactor: true, methods: ['totp', ...(hasPasskey ? ['passkey'] : []), 'recovery'] });
    }

    if (user.require_2fa) {
      startUserSession(req, user, { twoFactorEnrollmentOnly: true });
      await logAudit(req, 'login', user.username, '2FA setup required');
      return res.json({
        ...(await serializeUser(user)),
        twoFactorSetupRequired: true,
      });
    }

    startUserSession(req, user);
    await logAudit(req, 'login', user.username, '');
    return res.json(await serializeUser(user));
  } catch (err) {
    return next(err);
  }
});

// ─── Verify 2FA code (completes login) ───────────────────────────────────────

router.post('/verify-2fa', verifyTwoFactorLimiter, async (req, res, next) => {
  if (!req.session.pendingUserId || !req.session.pendingUsername) {
    return res.status(400).json({ error: 'No pending authentication' });
  }
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const pendingUsername = req.session.pendingUsername;
  const currentAttempts = await pruneAndCountTwoFactor(pendingUsername);
  if (currentAttempts >= TWO_FACTOR_MAX) {
    clearPendingAuth(req);
    return res.status(423).json({ error: 'Two-factor verification locked — too many invalid codes. Sign in again in 10 minutes.' });
  }

  const [user] = await db.select().from(users).where(eq(users.id, req.session.pendingUserId)).limit(1);
  if (!user?.totp_enabled || !user.totp_secret) {
    clearPendingAuth(req);
    return res.status(400).json({ error: 'Invalid state' });
  }

  const isValid = verifyTotp(code, decryptSecret(user.totp_secret));
  if (!isValid) {
    const attempts = await recordTwoFactorFailure(pendingUsername);
    const remaining = TWO_FACTOR_MAX - attempts;
    if (remaining <= 0) {
      clearPendingAuth(req);
      return res.status(423).json({ error: 'Two-factor verification locked — too many invalid codes. Sign in again in 10 minutes.' });
    }
    return res.status(401).json({ error: `Invalid code (${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout)` });
  }

  await clearTwoFactorAttempts(pendingUsername);

  try {
    await regenerateSession(req);
    startUserSession(req, user);
    await logAudit(req, 'login', user.username, '2FA verified');
    return res.json(await serializeUser(user));
  } catch (err) {
    return next(err);
  }
});

// ─── Invite links (public self-registration) ─────────────────────────────────
// These routes are intentionally NOT behind requireAuth — an invitee is
// anonymous until they redeem. Rate-limited like login to blunt token guessing
// and account-creation spam. Tokens are looked up by hash only.

const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many invite attempts, please try again later.' },
});

async function loadInviteByToken(token: any) {
  if (!token) return null;
  const [invite] = await db.select().from(invites).where(eq(invites.token_hash, hashInviteToken(token))).limit(1);
  return invite ?? null;
}

function inviteErrorResponse(status: string) {
  switch (status) {
    case 'used':    return { code: 410, error: 'This invite has already been used.' };
    case 'expired': return { code: 410, error: 'This invite has expired.' };
    case 'revoked': return { code: 410, error: 'This invite has been revoked.' };
    default:        return { code: 404, error: 'Invite not found.' };
  }
}

// Validate an invite and return a safe preset summary (no secrets, no token)
router.get('/invite/:token', inviteLimiter, async (req, res) => {
  const invite = await loadInviteByToken(req.params.token);
  const status = inviteStatus(invite);
  if (status !== 'open') {
    const r = inviteErrorResponse(status);
    return res.status(r.code).json({ error: r.error });
  }
  res.json({
    valid: true,
    requires2fa: !!invite!.require_2fa,
    expiresAt: invite!.expires_at,
    invitedBy: invite!.created_by_username || null,
    // invites.preset is jsonb — it arrives as an object already (no JSON.parse).
    preset: await summarizeInvitePreset(invite!.preset as StoredInvitePreset),
  });
});

// Redeem an invite: create the account with EXACTLY the preset's grants inside
// a single transaction, then mark the invite used and log the user straight in.
router.post('/invite/:token', inviteLimiter, async (req, res, next) => {
  const invite = await loadInviteByToken(req.params.token);
  const status = inviteStatus(invite);
  if (status !== 'open') {
    const r = inviteErrorResponse(status);
    return res.status(r.code).json({ error: r.error });
  }

  let username;
  let password;
  // Username policy identical to admin-created users (non-empty + unique);
  // password is policy-checked to a minimum length for self-registration.
  try {
    username = validateUsername(req.body?.username);
    password = validatePassword(req.body?.password);
  } catch (err: any) {
    return res.status(400).json({ error: err.message, code: err.code, field: err.field });
  }

  // preset is a jsonb object (no JSON.parse); flags are real booleans now.
  const preset: any = invite!.preset || {};
  const hash = bcrypt.hashSync(password, 10);
  const require2fa = !!invite!.require_2fa;

  let newUser;
  try {
    newUser = await db.transaction(async (tx) => {
      // Re-check inside the transaction to close the double-redeem race.
      const [fresh] = await tx.select().from(invites).where(eq(invites.id, invite!.id)).limit(1);
      if (inviteStatus(fresh) !== 'open') {
        const err: any = new Error('INVITE_CONSUMED');
        err.code = 'INVITE_CONSUMED';
        throw err;
      }
      const perms = preset.permissions || {};
      // Build the user row from the preset — the granular can_* flags plus the
      // fixed columns. Every flag is a real boolean.
      const values: any = {
        username,
        password: hash,
        is_admin: !!preset.isAdmin,
        role_id: preset.roleId ?? null,
        require_2fa: require2fa,
        max_cores: preset.maxCores ?? null,
        max_memory_gb: preset.maxMemoryGb ?? null,
        max_storage_gb: preset.maxStorageGb ?? null,
      };
      for (const k of INVITE_PERMISSION_COLUMNS) values[k] = !!perms[k];
      const [created] = await tx.insert(users).values(values).returning({ id: users.id });
      const userId = created.id;

      const vlanIds: number[] = preset.vlanIds || [];
      if (vlanIds.length) {
        // INSERT OR IGNORE → onConflictDoNothing (unique (user_id, vlan_id)).
        await tx
          .insert(userVlans)
          .values(vlanIds.map((vlan_id) => ({ user_id: userId, vlan_id })))
          .onConflictDoNothing();
      }

      await tx
        .update(invites)
        .set({ used_at: new Date(), used_by: userId, used_by_username: username })
        .where(eq(invites.id, invite!.id));

      const [row] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      return row;
    });
  } catch (err: any) {
    if (err.code === 'INVITE_CONSUMED') {
      return res.status(410).json({ error: 'This invite has already been used.' });
    }
    if (isUniqueViolation(err)) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    return next(err);
  }

  try {
    await regenerateSession(req);
    if (require2fa) {
      // Land in the existing enrollment-only gate — must set up 2FA first.
      startUserSession(req, newUser, { twoFactorEnrollmentOnly: true });
      await logAudit(req, 'invite_consumed', username, `invite #${invite!.id} · 2FA enrollment required`);
      return res.json({ ...(await serializeUser(newUser)), twoFactorSetupRequired: true });
    }
    startUserSession(req, newUser);
    await logAudit(req, 'invite_consumed', username, `invite #${invite!.id}`);
    return res.json(await serializeUser(newUser));
  } catch (err) {
    return next(err);
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── Current user ─────────────────────────────────────────────────────────────

router.get('/me', async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const [user] = await db.select().from(users).where(eq(users.id, req.session.userId)).limit(1);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    ...(await serializeUser(user)),
    twoFactorSetupRequired: !!req.session.twoFactorEnrollmentOnly,
  });
});

// ─── Self-service account changes ────────────────────────────────────────

router.put('/change-username', requireAuth, requireInteractiveSession, async (req, res) => {
  let username;
  try { username = validateUsername(req.body?.username); }
  catch (err: any) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  const previous = req.session.username;
  try {
    await db.update(users).set({ username }).where(eq(users.id, req.session.userId));
    req.session.username = username;
    // Re-stamp the PVE owner tag on this user's VMs; the old username is
    // gone from the users table, so pass it as retired.
    const vms = await db
      .select({ node: vmAssignments.node, vmid: vmAssignments.vmid })
      .from(vmAssignments)
      .where(eq(vmAssignments.user_id, req.session.userId));
    for (const vm of vms) {
      syncVmTagsSafe(vm.node, vm.vmid, { retired: [previous].filter(Boolean) });
    }
    res.json({ ok: true });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(400).json({ error: 'Username already taken' });
    throw err;
  }
});

router.put('/change-password', requireAuth, requireInteractiveSession, async (req, res) => {
  try { validateObject(req.body, { fields: ['currentPassword', 'newPassword'], required: ['currentPassword', 'newPassword'] }); }
  catch (err: any) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  const { currentPassword } = req.body;
  let newPassword;
  if (!currentPassword || !req.body?.newPassword) return res.status(400).json({ error: 'Current and new password required' });
  try { newPassword = validatePassword(req.body?.newPassword, 'newPassword'); }
  catch (err: any) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }

  const [user] = await db.select({ password: users.password }).from(users).where(eq(users.id, req.session.userId)).limit(1);
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  await db.update(users).set({ password: hash }).where(eq(users.id, req.session.userId));
  req.session.reauthenticatedAt = Date.now();
  res.json({ ok: true });
});

router.post('/reauthenticate', requireAuth, requireInteractiveSession, async (req, res) => {
  try { validateObject(req.body, { fields: ['password', 'code'], required: ['password'] }); }
  catch (err: any) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  const { password, code = '' } = req.body || {};
  const [user] = await db
    .select({ password: users.password, totp_enabled: users.totp_enabled, totp_secret: users.totp_secret })
    .from(users)
    .where(eq(users.id, req.session.userId))
    .limit(1);
  if (!user || !bcrypt.compareSync(String(password || ''), user.password)) {
    return res.status(401).json({ error: 'Password confirmation failed' });
  }
  if (user.totp_enabled) {
    const valid = verifyTotp(code, decryptSecret(user.totp_secret));
    if (!valid) return res.status(401).json({ error: 'Second-factor confirmation failed' });
  }
  req.session.reauthenticatedAt = Date.now();
  await logAudit(req, 'session_reauthenticated', req.session.username, '');
  res.json({ ok: true, validForSeconds: 900 });
});

// ─── 2FA management (requires existing full session) ─────────────────────────

// Generate a new secret and return a QR code (does NOT enable 2FA yet)
router.post('/2fa/setup', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const [user] = await db.select({ username: users.username, totp_enabled: users.totp_enabled }).from(users).where(eq(users.id, req.session.userId)).limit(1);
  // Never let setup clobber an active second factor — otherwise a single call
  // silently disables 2FA (totp_enabled=false) even if enrollment is never finished.
  if (user.totp_enabled) {
    return res.status(400).json({ error: '2FA is already enabled — disable it first to re-enroll' });
  }
  const secret = generateTotpSecret();
  const otpauth = totpKeyUri(user.username, secret);

  // Store secret temporarily — not active until /2fa/enable confirms it
  await db.update(users).set({ totp_secret: encryptSecret(secret), totp_enabled: false }).where(eq(users.id, req.session.userId));
  await logAudit(req, '2fa_setup_started', user.username, '');

  try {
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    res.json({ secret, qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Verify code and activate 2FA
router.post('/2fa/enable', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const [user] = await db.select({ totp_secret: users.totp_secret, totp_enabled: users.totp_enabled }).from(users).where(eq(users.id, req.session.userId)).limit(1);
  if (!user?.totp_secret) return res.status(400).json({ error: 'Run setup first' });
  if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });

  const isValid = verifyTotp(code, decryptSecret(user.totp_secret));
  if (!isValid) return res.status(400).json({ error: 'Invalid code — try again' });

  await db.update(users).set({ totp_enabled: true }).where(eq(users.id, req.session.userId));
  req.session.twoFactorEnrollmentOnly = false;
  await logAudit(req, '2fa_enabled', req.session.username, '');
  res.json({ ok: true });
});

// Disable 2FA (requires current TOTP code to confirm)
router.post('/2fa/disable', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const [user] = await db
    .select({ totp_secret: users.totp_secret, totp_enabled: users.totp_enabled, require_2fa: users.require_2fa })
    .from(users)
    .where(eq(users.id, req.session.userId))
    .limit(1);
  if (!user?.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });
  if (user.require_2fa) return res.status(403).json({ error: 'Your account is required to keep 2FA enabled' });

  const isValid = verifyTotp(code, decryptSecret(user.totp_secret));
  if (!isValid) return res.status(400).json({ error: 'Invalid code' });

  await db.update(users).set({ totp_enabled: false, totp_secret: null }).where(eq(users.id, req.session.userId));
  await logAudit(req, '2fa_disabled', req.session.username, '');
  res.json({ ok: true });
});

// ─── Passkeys, recovery codes, and active sessions ─────────────────────────

function webauthnConfig(req: any) {
  return resolveWebauthnConfig({
    configuredOrigin: process.env.WEBAUTHN_ORIGIN || '',
    allowedOrigin: process.env.ALLOWED_ORIGIN || '',
    protocol: req.protocol,
    host: req.get('host'),
    rpID: process.env.WEBAUTHN_RP_ID || '',
    rpName: process.env.WEBAUTHN_RP_NAME || '',
  });
}

async function credentialsForUser(userId: number) {
  return db
    .select({
      id: webauthnCredentials.id,
      name: webauthnCredentials.name,
      public_key: webauthnCredentials.public_key,
      counter: webauthnCredentials.counter,
      transports: webauthnCredentials.transports,
      device_type: webauthnCredentials.device_type,
      backed_up: webauthnCredentials.backed_up,
      created_at: webauthnCredentials.created_at,
      last_used_at: webauthnCredentials.last_used_at,
    })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.user_id, userId))
    .orderBy(desc(webauthnCredentials.created_at));
}

function publicCredential(row: any) {
  return {
    id: row.id,
    name: row.name,
    // transports is jsonb — already an array (no JSON.parse).
    transports: row.transports || [],
    deviceType: row.device_type,
    backedUp: !!row.backed_up,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

router.get('/passkeys', requireAuth, requireInteractiveSession, async (req, res) => {
  res.json((await credentialsForUser(req.session.userId)).map(publicCredential));
});

router.post('/passkeys/register/options', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const [user] = await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, req.session.userId)).limit(1);
  const { rpID, rpName } = webauthnConfig(req);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: 'none',
    excludeCredentials: (await credentialsForUser(user.id)).map((credential) => ({
      id: credential.id,
      transports: (credential.transports || []) as any,
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  req.session.webauthnRegistrationChallenge = options.challenge;
  res.json(options);
});

router.post('/passkeys/register/verify', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const challenge = req.session.webauthnRegistrationChallenge;
  if (!challenge) return res.status(400).json({ error: 'Passkey registration challenge expired' });
  const { origin, rpID } = webauthnConfig(req);
  const verification = await verifyRegistrationResponse({
    response: req.body?.credential,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
  delete req.session.webauthnRegistrationChallenge;
  if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'Passkey verification failed' });

  const name = String(req.body?.name || 'Passkey').trim().slice(0, 64) || 'Passkey';
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  // public_key is bytea (Buffer in/out); transports is jsonb (array, no stringify).
  await db.insert(webauthnCredentials).values({
    id: credential.id,
    user_id: req.session.userId,
    name,
    public_key: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    device_type: credentialDeviceType || '',
    backed_up: !!credentialBackedUp,
  });
  await logAudit(req, 'passkey_registered', name, credential.id.slice(0, 12));
  res.status(201).json(publicCredential((await credentialsForUser(req.session.userId)).find((row) => row.id === credential.id)));
});

router.delete('/passkeys/:id', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const credential = await removeWebauthnCredential(db, req.session.userId, req.params.id);
  if (!credential) return res.status(404).json({ error: 'Passkey not found' });
  await logAudit(req, 'passkey_removed', credential.name, credential.id.slice(0, 12));
  res.json({ ok: true });
});

router.post('/passkeys/authentication/options', async (req, res) => {
  const userId = req.session.pendingUserId || req.session.userId;
  if (!userId) return res.status(400).json({ error: 'No pending authentication' });
  const credentials = await credentialsForUser(userId);
  if (!credentials.length) return res.status(400).json({ error: 'No passkey is registered for this account' });
  const { rpID } = webauthnConfig(req);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: (credential.transports || []) as any })),
  });
  req.session.webauthnAuthenticationChallenge = options.challenge;
  res.json(options);
});

router.post('/passkeys/authentication/verify', verifyTwoFactorLimiter, async (req, res, next) => {
  const userId = req.session.pendingUserId || req.session.userId;
  const challenge = req.session.webauthnAuthenticationChallenge;
  if (!userId || !challenge) return res.status(400).json({ error: 'Passkey authentication challenge expired' });
  const response = req.body?.credential;
  const [row] = await db
    .select()
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.id, response?.id ?? ''), eq(webauthnCredentials.user_id, userId)))
    .limit(1);
  if (!row) return res.status(400).json({ error: 'Passkey is not registered for this account' });
  const { origin, rpID } = webauthnConfig(req);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: row.id,
      // public_key is bytea (Buffer) — @simplewebauthn wants a Uint8Array.
      publicKey: new Uint8Array(row.public_key),
      counter: row.counter,
      transports: (row.transports || []) as any,
    },
  });
  delete req.session.webauthnAuthenticationChallenge;
  if (!verification.verified) return res.status(401).json({ error: 'Passkey verification failed' });
  await db
    .update(webauthnCredentials)
    .set({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date() })
    .where(eq(webauthnCredentials.id, row.id));

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (req.session.pendingUserId) {
    try {
      await regenerateSession(req);
      startUserSession(req, user);
      await logAudit(req, 'login', user.username, 'passkey verified');
      return res.json(await serializeUser(user));
    } catch (err) { return next(err); }
  }
  req.session.reauthenticatedAt = Date.now();
  res.json({ ok: true });
});

router.get('/recovery-codes', requireAuth, requireInteractiveSession, async (req, res) => {
  const [row] = await db
    .select({ remaining: count(), created_at: max(recoveryCodes.created_at) })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.user_id, req.session.userId), isNull(recoveryCodes.used_at)));
  res.json({ remaining: row.remaining, createdAt: row.created_at });
});

router.post('/recovery-codes', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const codes = Array.from({ length: 10 }, () => {
    const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
  });
  await db.transaction(async (tx) => {
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.user_id, req.session.userId));
    await tx.insert(recoveryCodes).values(codes.map((code) => ({ user_id: req.session.userId, code_hash: hashRecoveryCode(code) })));
  });
  await logAudit(req, 'recovery_codes_regenerated', req.session.username, '10 codes');
  res.status(201).json({ codes });
});

router.delete('/recovery-codes', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  await db.delete(recoveryCodes).where(eq(recoveryCodes.user_id, req.session.userId));
  await logAudit(req, 'recovery_codes_revoked', req.session.username, '');
  res.json({ ok: true });
});

router.post('/verify-recovery-code', verifyTwoFactorLimiter, async (req, res, next) => {
  const userId = req.session.pendingUserId;
  if (!userId) return res.status(400).json({ error: 'No pending authentication' });
  const hash = hashRecoveryCode(req.body?.code);
  if (!(await consumeRecoveryCode(db, userId, hash))) return res.status(401).json({ error: 'Invalid or already-used recovery code' });
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  try {
    await regenerateSession(req);
    startUserSession(req, user);
    await logAudit(req, 'login', user.username, 'recovery code used');
    return res.json(await serializeUser(user));
  } catch (err) { return next(err); }
});

router.get('/sessions', requireAuth, requireInteractiveSession, async (req, res) => {
  const rows = await db.select({ sid: sessions.sid, sess: sessions.sess, expire: sessions.expire }).from(sessions);
  const list = rows
    .map((row) => parseStoredSession(row, req.sessionID))
    .filter((row): row is NonNullable<typeof row> => row?.userId === req.session.userId)
    .map(({ userId, ...row }) => row);
  res.json(list);
});

router.delete('/sessions/:id', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const result = await revokeStoredSession(db, req.session.userId, req.params.id, req.sessionID);
  if (result.current) return res.status(400).json({ error: 'Use logout to end the current session' });
  if (result.missing) return res.status(404).json({ error: 'Session not found' });
  await logAudit(req, 'session_revoked', result.session!.id.slice(0, 12), '');
  res.json({ ok: true });
});

router.delete('/sessions', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const revoked = await revokeOtherStoredSessions(db, req.session.userId, req.sessionID);
  await logAudit(req, 'sessions_revoked_all', req.session.username, `revoked=${revoked}`);
  res.json({ ok: true, revoked });
});

// ─── Personal API tokens ─────────────────────────────────────────────────────
// Token management is interactive-session only — a token can never mint, list,
// or revoke tokens (nor manage passwords / 2FA above).

const TOKEN_NAME_MAX = 64;
const TOKEN_EXPIRY_PRESETS = new Set([7, 30, 90, 365]);

function serializeApiToken(row: any) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    scopes: String(row.scopes || 'read').split(',').filter(Boolean),
    // expires_at is a Date now — compare instants directly.
    expired: !!row.expires_at && row.expires_at.getTime() < Date.now(),
  };
}

// List the caller's own tokens (never exposes the secret or its hash).
router.get('/tokens', requireAuth, requireInteractiveSession, async (req, res) => {
  const rows = await db
    .select({
      id: apiTokens.id, name: apiTokens.name, scopes: apiTokens.scopes,
      created_at: apiTokens.created_at, expires_at: apiTokens.expires_at, last_used_at: apiTokens.last_used_at,
    })
    .from(apiTokens)
    .where(eq(apiTokens.user_id, req.session.userId))
    .orderBy(desc(apiTokens.created_at));
  res.json(rows.map(serializeApiToken));
});

// Create a token. The plaintext secret is returned exactly once, here.
router.post('/tokens', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Token name required' });
  if (name.length > TOKEN_NAME_MAX) return res.status(400).json({ error: `Token name must be ${TOKEN_NAME_MAX} characters or fewer` });

  // Optional expiry expressed as a whole number of days from now.
  let expiresInDays = req.body?.expiresInDays;
  if (expiresInDays === '' || expiresInDays === undefined) expiresInDays = null;
  if (expiresInDays !== null) {
    expiresInDays = Number(expiresInDays);
    if (!Number.isInteger(expiresInDays) || expiresInDays <= 0 || !TOKEN_EXPIRY_PRESETS.has(expiresInDays)) {
      return res.status(400).json({ error: 'Invalid expiry — choose one of the offered durations or no expiry' });
    }
  }

  const [existing] = await db.select({ id: apiTokens.id }).from(apiTokens).where(and(eq(apiTokens.user_id, req.session.userId), eq(apiTokens.name, name))).limit(1);
  if (existing) return res.status(400).json({ error: 'You already have a token with that name' });

  const requestedScopes = Array.isArray(req.body?.scopes) ? [...new Set(req.body.scopes.map(String))] : ['read'];
  if (requestedScopes.length === 0 || requestedScopes.some((scope) => !API_TOKEN_SCOPES.has(scope as string))) {
    return res.status(400).json({ error: 'Invalid API token scope' });
  }
  if (requestedScopes.includes('admin') && !req.session.isAdmin) {
    return res.status(403).json({ error: 'Only administrators can create an admin-scoped API token' });
  }
  const scopes = requestedScopes.join(',');

  const secret = generateApiToken();
  const tokenHash = hashApiToken(secret);
  // Expiry is a computed Date bound as a normal parameter — never string-
  // interpolated into SQL. expiresInDays is whitelisted above.
  const expiresAt = expiresInDays !== null ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null;

  const [created] = await db
    .insert(apiTokens)
    .values({ user_id: req.session.userId, name, token_hash: tokenHash, scopes, expires_at: expiresAt })
    .returning({ id: apiTokens.id });

  const [row] = await db
    .select({
      id: apiTokens.id, name: apiTokens.name, scopes: apiTokens.scopes,
      created_at: apiTokens.created_at, expires_at: apiTokens.expires_at, last_used_at: apiTokens.last_used_at,
    })
    .from(apiTokens)
    .where(eq(apiTokens.id, created.id))
    .limit(1);

  await logAudit(req, 'api_token_created', name, `${expiresInDays ? `expires in ${expiresInDays} days` : 'no expiry'}; scopes=${scopes}`);

  // `token` is the one and only time the plaintext is ever returned.
  res.status(201).json({ ...serializeApiToken(row), token: secret });
});

// Revoke one of the caller's own tokens.
router.delete('/tokens/:id', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const tokenId = Number(req.params.id);
  if (!Number.isInteger(tokenId)) return res.status(404).json({ error: 'Token not found' });
  const [token] = await db.select({ id: apiTokens.id, name: apiTokens.name }).from(apiTokens).where(and(eq(apiTokens.id, tokenId), eq(apiTokens.user_id, req.session.userId))).limit(1);
  if (!token) return res.status(404).json({ error: 'Token not found' });
  await db.delete(apiTokens).where(eq(apiTokens.id, token.id));
  await logAudit(req, 'api_token_revoked', token.name, '');
  res.json({ ok: true });
});

export default router;
