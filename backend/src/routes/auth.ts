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
import db from '../db.ts';
import { requireAuth, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import { warnIfProxyMismatch } from '../middleware/trustProxyCheck.ts';
import { logAudit } from '../utils/audit.ts';
import { notify, portalLink } from '../utils/notify.ts';
import { decryptSecret, encryptSecret } from '../utils/secrets.ts';
import { syncVmTagsSafe } from '../utils/vmTags.ts';
import { generateApiToken, hashApiToken } from '../utils/apiTokens.ts';
import { effectivePermissions } from '../utils/permissions.ts';
import { hashInviteToken, inviteStatus, summarizeInvitePreset, INVITE_PERMISSION_COLUMNS } from '../utils/invites.ts';
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

function serializeUser(user) {
  // Effective permissions: legacy per-user column OR role grant
  const perms = effectivePermissions(user);
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
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

function startUserSession(req, user, { twoFactorEnrollmentOnly = false } = {}) {
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin === 1;
  req.session.twoFactorEnrollmentOnly = twoFactorEnrollmentOnly;
  req.session.reauthenticatedAt = Date.now();
  req.session.createdAt ||= Date.now();
  req.session.lastSeenAt = Date.now();
  req.session.clientIp = String(req.ip || '').slice(0, 128);
  req.session.userAgent = String(req.headers['user-agent'] || '').slice(0, 256);
}

function clearPendingAuth(req) {
  delete req.session.pendingUserId;
  delete req.session.pendingUsername;
  delete req.session.pendingIsAdmin;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function clearExpiredTwoFactorAttempts() {
  const windowStart = Date.now() - TWO_FACTOR_WINDOW_MS;
  db.prepare('DELETE FROM two_factor_attempts WHERE attempted_at < ?').run(windowStart);
  return windowStart;
}

function countTwoFactorAttempts(username, windowStart) {
  return db.prepare(
    'SELECT COUNT(*) as count FROM two_factor_attempts WHERE username = ? AND attempted_at > ?'
  ).get(username, windowStart).count;
}

function recordTwoFactorFailure(username) {
  const now = Date.now();
  const windowStart = now - TWO_FACTOR_WINDOW_MS;
  db.prepare('DELETE FROM two_factor_attempts WHERE attempted_at < ?').run(windowStart);
  db.prepare('INSERT INTO two_factor_attempts (username, attempted_at) VALUES (?, ?)').run(username, now);
  return countTwoFactorAttempts(username, windowStart);
}

function clearTwoFactorAttempts(username) {
  db.prepare('DELETE FROM two_factor_attempts WHERE username = ?').run(username);
}

// ─── Login ────────────────────────────────────────────────────────────────────

// Dummy hash compared against when the username doesn't exist, so unknown and
// known usernames take the same time (blocks user enumeration via timing).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('homelabrrr-timing-equalizer', 10);

router.post('/login', loginLimiter, async (req, res, next) => {
  try { validateObject(req.body, { fields: ['username', 'password'], required: ['username', 'password'] }); }
  catch (err) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
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

  db.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').run(windowStart);

  const { count } = db.prepare(
    'SELECT COUNT(*) as count FROM login_attempts WHERE username = ? AND ip = ? AND attempted_at > ?'
  ).get(username, clientIp, windowStart);

  if (count >= LOCKOUT_MAX) {
    return res.status(423).json({ error: 'Too many failed attempts for this account from your address. Try again in 10 minutes or contact an admin.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const passwordOk = bcrypt.compareSync(password, user ? user.password : DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) {
    db.prepare('INSERT INTO login_attempts (username, ip, attempted_at) VALUES (?, ?, ?)').run(username, clientIp, now);
    logAudit({ session: { username: username }, headers: req.headers, ip: req.ip }, 'login_failed', username, '');
    const remaining = LOCKOUT_MAX - (count + 1);
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
  db.prepare('DELETE FROM login_attempts WHERE username = ? AND ip = ?').run(username, clientIp);

  try {
    await regenerateSession(req);

    // If 2FA is enabled, set a pending state and ask for the code
    if (user.totp_enabled) {
      req.session.pendingUserId = user.id;
      req.session.pendingUsername = user.username;
      req.session.pendingIsAdmin = user.is_admin === 1;
      const hasPasskey = !!db.prepare('SELECT 1 FROM webauthn_credentials WHERE user_id = ? LIMIT 1').get(user.id);
      return res.json({ requiresTwoFactor: true, methods: ['totp', ...(hasPasskey ? ['passkey'] : []), 'recovery'] });
    }

    if (user.require_2fa) {
      startUserSession(req, user, { twoFactorEnrollmentOnly: true });
      logAudit(req, 'login', user.username, '2FA setup required');
      return res.json({
        ...serializeUser(user),
        twoFactorSetupRequired: true,
      });
    }

    startUserSession(req, user);
    logAudit(req, 'login', user.username, '');
    return res.json(serializeUser(user));
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
  const windowStart = clearExpiredTwoFactorAttempts();
  const currentAttempts = countTwoFactorAttempts(pendingUsername, windowStart);
  if (currentAttempts >= TWO_FACTOR_MAX) {
    clearPendingAuth(req);
    return res.status(423).json({ error: 'Two-factor verification locked — too many invalid codes. Sign in again in 10 minutes.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.pendingUserId);
  if (!user?.totp_enabled || !user.totp_secret) {
    clearPendingAuth(req);
    return res.status(400).json({ error: 'Invalid state' });
  }

  const isValid = verifyTotp(code, decryptSecret(user.totp_secret));
  if (!isValid) {
    const attempts = recordTwoFactorFailure(pendingUsername);
    const remaining = TWO_FACTOR_MAX - attempts;
    if (remaining <= 0) {
      clearPendingAuth(req);
      return res.status(423).json({ error: 'Two-factor verification locked — too many invalid codes. Sign in again in 10 minutes.' });
    }
    return res.status(401).json({ error: `Invalid code (${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout)` });
  }

  clearTwoFactorAttempts(pendingUsername);

  try {
    await regenerateSession(req);
    startUserSession(req, user);
    logAudit(req, 'login', user.username, '2FA verified');
    return res.json(serializeUser(user));
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

function loadInviteByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(hashInviteToken(token));
}

function inviteErrorResponse(status) {
  switch (status) {
    case 'used':    return { code: 410, error: 'This invite has already been used.' };
    case 'expired': return { code: 410, error: 'This invite has expired.' };
    case 'revoked': return { code: 410, error: 'This invite has been revoked.' };
    default:        return { code: 404, error: 'Invite not found.' };
  }
}

function parsePreset(invite) {
  try { return JSON.parse(invite.preset || '{}'); } catch { return {}; }
}

// Validate an invite and return a safe preset summary (no secrets, no token)
router.get('/invite/:token', inviteLimiter, (req, res) => {
  const invite = loadInviteByToken(req.params.token);
  const status = inviteStatus(invite);
  if (status !== 'open') {
    const r = inviteErrorResponse(status);
    return res.status(r.code).json({ error: r.error });
  }
  res.json({
    valid: true,
    requires2fa: !!invite.require_2fa,
    expiresAt: invite.expires_at,
    invitedBy: invite.created_by_username || null,
    preset: summarizeInvitePreset(parsePreset(invite)),
  });
});

// Redeem an invite: create the account with EXACTLY the preset's grants inside
// a single transaction, then mark the invite used and log the user straight in.
router.post('/invite/:token', inviteLimiter, async (req, res, next) => {
  const invite = loadInviteByToken(req.params.token);
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
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code, field: err.field });
  }

  const preset = parsePreset(invite);
  const hash = bcrypt.hashSync(password, 10);
  const require2fa = invite.require_2fa ? 1 : 0;

  let newUser;
  try {
    const redeem = db.transaction(() => {
      // Re-check inside the transaction to close the double-redeem race.
      const fresh = db.prepare('SELECT * FROM invites WHERE id = ?').get(invite.id);
      if (inviteStatus(fresh) !== 'open') {
        const err = new Error('INVITE_CONSUMED');
        err.code = 'INVITE_CONSUMED';
        throw err;
      }
      const perms = preset.permissions || {};
      const cols = [
        'username', 'password', 'is_admin', 'role_id', 'require_2fa',
        'max_cores', 'max_memory_gb', 'max_storage_gb',
        ...INVITE_PERMISSION_COLUMNS,
      ];
      const vals = [
        username,
        hash,
        preset.isAdmin ? 1 : 0,
        preset.roleId ?? null,
        require2fa,
        preset.maxCores ?? null,
        preset.maxMemoryGb ?? null,
        preset.maxStorageGb ?? null,
        ...INVITE_PERMISSION_COLUMNS.map((k) => (perms[k] ? 1 : 0)),
      ];
      const placeholders = cols.map(() => '?').join(', ');
      const result = db.prepare(`INSERT INTO users (${cols.join(', ')}) VALUES (${placeholders})`).run(...vals);
      const userId = result.lastInsertRowid;

      const insVlan = db.prepare('INSERT OR IGNORE INTO user_vlans (user_id, vlan_id) VALUES (?, ?)');
      for (const vlanId of (preset.vlanIds || [])) insVlan.run(userId, vlanId);

      db.prepare('UPDATE invites SET used_at = ?, used_by = ?, used_by_username = ? WHERE id = ?')
        .run(new Date().toISOString(), userId, username, invite.id);

      return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    });
    newUser = redeem();
  } catch (err) {
    if (err.code === 'INVITE_CONSUMED') {
      return res.status(410).json({ error: 'This invite has already been used.' });
    }
    if (err.message?.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    return next(err);
  }

  try {
    await regenerateSession(req);
    if (require2fa) {
      // Land in the existing enrollment-only gate — must set up 2FA first.
      startUserSession(req, newUser, { twoFactorEnrollmentOnly: true });
      logAudit(req, 'invite_consumed', username, `invite #${invite.id} · 2FA enrollment required`);
      return res.json({ ...serializeUser(newUser), twoFactorSetupRequired: true });
    }
    startUserSession(req, newUser);
    logAudit(req, 'invite_consumed', username, `invite #${invite.id}`);
    return res.json(serializeUser(newUser));
  } catch (err) {
    return next(err);
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── Current user ─────────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    ...serializeUser(user),
    twoFactorSetupRequired: !!req.session.twoFactorEnrollmentOnly,
  });
});

// ─── Self-service account changes ────────────────────────────────────────

router.put('/change-username', requireAuth, requireInteractiveSession, (req, res) => {
  let username;
  try { username = validateUsername(req.body?.username); }
  catch (err) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  const previous = req.session.username;
  try {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.session.userId);
    req.session.username = username;
    // Re-stamp the PVE owner tag on this user's VMs; the old username is
    // gone from the users table, so pass it as retired.
    const vms = db.prepare('SELECT node, vmid FROM vm_assignments WHERE user_id = ?').all(req.session.userId);
    for (const vm of vms) {
      syncVmTagsSafe(vm.node, vm.vmid, { retired: [previous].filter(Boolean) });
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already taken' });
    throw err;
  }
});

router.put('/change-password', requireAuth, requireInteractiveSession, (req, res) => {
  try { validateObject(req.body, { fields: ['currentPassword', 'newPassword'], required: ['currentPassword', 'newPassword'] }); }
  catch (err) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  const { currentPassword } = req.body;
  let newPassword;
  if (!currentPassword || !req.body?.newPassword) return res.status(400).json({ error: 'Current and new password required' });
  try { newPassword = validatePassword(req.body?.newPassword, 'newPassword'); }
  catch (err) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }

  const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.session.userId);
  req.session.reauthenticatedAt = Date.now();
  res.json({ ok: true });
});

router.post('/reauthenticate', requireAuth, requireInteractiveSession, (req, res) => {
  try { validateObject(req.body, { fields: ['password', 'code'], required: ['password'] }); }
  catch (err) { return res.status(400).json({ error: err.message, code: err.code, field: err.field }); }
  const { password, code = '' } = req.body || {};
  const user = db.prepare('SELECT password, totp_enabled, totp_secret FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !bcrypt.compareSync(String(password || ''), user.password)) {
    return res.status(401).json({ error: 'Password confirmation failed' });
  }
  if (user.totp_enabled) {
    const valid = verifyTotp(code, decryptSecret(user.totp_secret));
    if (!valid) return res.status(401).json({ error: 'Second-factor confirmation failed' });
  }
  req.session.reauthenticatedAt = Date.now();
  logAudit(req, 'session_reauthenticated', req.session.username, '');
  res.json({ ok: true, validForSeconds: 900 });
});

// ─── 2FA management (requires existing full session) ─────────────────────────

// Generate a new secret and return a QR code (does NOT enable 2FA yet)
router.post('/2fa/setup', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const user = db.prepare('SELECT username, totp_enabled FROM users WHERE id = ?').get(req.session.userId);
  // Never let setup clobber an active second factor — otherwise a single call
  // silently disables 2FA (totp_enabled=0) even if enrollment is never finished.
  if (user.totp_enabled) {
    return res.status(400).json({ error: '2FA is already enabled — disable it first to re-enroll' });
  }
  const secret = generateTotpSecret();
  const otpauth = totpKeyUri(user.username, secret);

  // Store secret temporarily — not active until /2fa/enable confirms it
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(encryptSecret(secret), req.session.userId);
  logAudit(req, '2fa_setup_started', user.username, '');

  try {
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    res.json({ secret, qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Verify code and activate 2FA
router.post('/2fa/enable', requireAuth, requireInteractiveSession, requireRecentReauthentication, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const user = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.session.userId);
  if (!user?.totp_secret) return res.status(400).json({ error: 'Run setup first' });
  if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });

  const isValid = verifyTotp(code, decryptSecret(user.totp_secret));
  if (!isValid) return res.status(400).json({ error: 'Invalid code — try again' });

  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.session.userId);
  req.session.twoFactorEnrollmentOnly = false;
  logAudit(req, '2fa_enabled', req.session.username, '');
  res.json({ ok: true });
});

// Disable 2FA (requires current TOTP code to confirm)
router.post('/2fa/disable', requireAuth, requireInteractiveSession, requireRecentReauthentication, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const user = db.prepare('SELECT totp_secret, totp_enabled, require_2fa FROM users WHERE id = ?').get(req.session.userId);
  if (!user?.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });
  if (user.require_2fa) return res.status(403).json({ error: 'Your account is required to keep 2FA enabled' });

  const isValid = verifyTotp(code, decryptSecret(user.totp_secret));
  if (!isValid) return res.status(400).json({ error: 'Invalid code' });

  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.session.userId);
  logAudit(req, '2fa_disabled', req.session.username, '');
  res.json({ ok: true });
});

// ─── Passkeys, recovery codes, and active sessions ─────────────────────────

function webauthnConfig(req) {
  return resolveWebauthnConfig({
    configuredOrigin: process.env.WEBAUTHN_ORIGIN || '',
    allowedOrigin: process.env.ALLOWED_ORIGIN || '',
    protocol: req.protocol,
    host: req.get('host'),
    rpID: process.env.WEBAUTHN_RP_ID || '',
    rpName: process.env.WEBAUTHN_RP_NAME || '',
  });
}

function credentialsForUser(userId) {
  return db.prepare(`
    SELECT id, name, public_key, counter, transports, device_type, backed_up, created_at, last_used_at
    FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId);
}

function publicCredential(row) {
  return {
    id: row.id,
    name: row.name,
    transports: JSON.parse(row.transports || '[]'),
    deviceType: row.device_type,
    backedUp: !!row.backed_up,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

router.get('/passkeys', requireAuth, requireInteractiveSession, (req, res) => {
  res.json(credentialsForUser(req.session.userId).map(publicCredential));
});

router.post('/passkeys/register/options', requireAuth, requireInteractiveSession, requireRecentReauthentication, async (req, res) => {
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.session.userId);
  const { rpID, rpName } = webauthnConfig(req);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: 'none',
    excludeCredentials: credentialsForUser(user.id).map((credential) => ({
      id: credential.id,
      transports: JSON.parse(credential.transports || '[]'),
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
  db.prepare(`
    INSERT INTO webauthn_credentials (id, user_id, name, public_key, counter, transports, device_type, backed_up)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    credential.id,
    req.session.userId,
    name,
    Buffer.from(credential.publicKey),
    credential.counter,
    JSON.stringify(credential.transports || []),
    credentialDeviceType || '',
    credentialBackedUp ? 1 : 0,
  );
  logAudit(req, 'passkey_registered', name, credential.id.slice(0, 12));
  res.status(201).json(publicCredential(credentialsForUser(req.session.userId).find((row) => row.id === credential.id)));
});

router.delete('/passkeys/:id', requireAuth, requireInteractiveSession, requireRecentReauthentication, (req, res) => {
  const credential = removeWebauthnCredential(db, req.session.userId, req.params.id);
  if (!credential) return res.status(404).json({ error: 'Passkey not found' });
  logAudit(req, 'passkey_removed', credential.name, credential.id.slice(0, 12));
  res.json({ ok: true });
});

router.post('/passkeys/authentication/options', async (req, res) => {
  const userId = req.session.pendingUserId || req.session.userId;
  if (!userId) return res.status(400).json({ error: 'No pending authentication' });
  const credentials = credentialsForUser(userId);
  if (!credentials.length) return res.status(400).json({ error: 'No passkey is registered for this account' });
  const { rpID } = webauthnConfig(req);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: credentials.map((credential) => ({ id: credential.id, transports: JSON.parse(credential.transports || '[]') })),
  });
  req.session.webauthnAuthenticationChallenge = options.challenge;
  res.json(options);
});

router.post('/passkeys/authentication/verify', verifyTwoFactorLimiter, async (req, res, next) => {
  const userId = req.session.pendingUserId || req.session.userId;
  const challenge = req.session.webauthnAuthenticationChallenge;
  if (!userId || !challenge) return res.status(400).json({ error: 'Passkey authentication challenge expired' });
  const response = req.body?.credential;
  const row = db.prepare('SELECT * FROM webauthn_credentials WHERE id = ? AND user_id = ?').get(response?.id, userId);
  if (!row) return res.status(400).json({ error: 'Passkey is not registered for this account' });
  const { origin, rpID } = webauthnConfig(req);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: row.id,
      publicKey: new Uint8Array(row.public_key),
      counter: row.counter,
      transports: JSON.parse(row.transports || '[]'),
    },
  });
  delete req.session.webauthnAuthenticationChallenge;
  if (!verification.verified) return res.status(401).json({ error: 'Passkey verification failed' });
  db.prepare("UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?")
    .run(verification.authenticationInfo.newCounter, row.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (req.session.pendingUserId) {
    try {
      await regenerateSession(req);
      startUserSession(req, user);
      logAudit(req, 'login', user.username, 'passkey verified');
      return res.json(serializeUser(user));
    } catch (err) { return next(err); }
  }
  req.session.reauthenticatedAt = Date.now();
  res.json({ ok: true });
});

router.get('/recovery-codes', requireAuth, requireInteractiveSession, (req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS remaining, MAX(created_at) AS created_at FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .get(req.session.userId);
  res.json({ remaining: row.remaining, createdAt: row.created_at });
});

router.post('/recovery-codes', requireAuth, requireInteractiveSession, requireRecentReauthentication, (req, res) => {
  const codes = Array.from({ length: 10 }, () => {
    const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
  });
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.session.userId);
    const insert = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (const code of codes) insert.run(req.session.userId, hashRecoveryCode(code));
  });
  replace();
  logAudit(req, 'recovery_codes_regenerated', req.session.username, '10 codes');
  res.status(201).json({ codes });
});

router.delete('/recovery-codes', requireAuth, requireInteractiveSession, requireRecentReauthentication, (req, res) => {
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.session.userId);
  logAudit(req, 'recovery_codes_revoked', req.session.username, '');
  res.json({ ok: true });
});

router.post('/verify-recovery-code', verifyTwoFactorLimiter, async (req, res, next) => {
  const userId = req.session.pendingUserId;
  if (!userId) return res.status(400).json({ error: 'No pending authentication' });
  const hash = hashRecoveryCode(req.body?.code);
  if (!consumeRecoveryCode(db, userId, hash)) return res.status(401).json({ error: 'Invalid or already-used recovery code' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  try {
    await regenerateSession(req);
    startUserSession(req, user);
    logAudit(req, 'login', user.username, 'recovery code used');
    return res.json(serializeUser(user));
  } catch (err) { return next(err); }
});

router.get('/sessions', requireAuth, requireInteractiveSession, (req, res) => {
  const sessions = db.prepare('SELECT sid, sess, expire FROM sessions').all()
    .map((row) => parseStoredSession(row, req.sessionID))
    .filter((row) => row?.userId === req.session.userId)
    .map(({ userId, ...row }) => row);
  res.json(sessions);
});

router.delete('/sessions/:id', requireAuth, requireInteractiveSession, requireRecentReauthentication, (req, res) => {
  const result = revokeStoredSession(db, req.session.userId, req.params.id, req.sessionID);
  if (result.current) return res.status(400).json({ error: 'Use logout to end the current session' });
  if (result.missing) return res.status(404).json({ error: 'Session not found' });
  logAudit(req, 'session_revoked', result.session.id.slice(0, 12), '');
  res.json({ ok: true });
});

router.delete('/sessions', requireAuth, requireInteractiveSession, requireRecentReauthentication, (req, res) => {
  const revoked = revokeOtherStoredSessions(db, req.session.userId, req.sessionID);
  logAudit(req, 'sessions_revoked_all', req.session.username, `revoked=${revoked}`);
  res.json({ ok: true, revoked });
});

// ─── Personal API tokens ─────────────────────────────────────────────────────
// Token management is interactive-session only — a token can never mint, list,
// or revoke tokens (nor manage passwords / 2FA above).

const TOKEN_NAME_MAX = 64;
const TOKEN_EXPIRY_PRESETS = new Set([7, 30, 90, 365]);

function serializeApiToken(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    scopes: String(row.scopes || 'read').split(',').filter(Boolean),
    expired: !!row.expires_at && new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now(),
  };
}

// List the caller's own tokens (never exposes the secret or its hash).
router.get('/tokens', requireAuth, requireInteractiveSession, (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, scopes, created_at, expires_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.session.userId);
  res.json(rows.map(serializeApiToken));
});

// Create a token. The plaintext secret is returned exactly once, here.
router.post('/tokens', requireAuth, requireInteractiveSession, requireRecentReauthentication, (req, res) => {
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

  const existing = db.prepare('SELECT 1 FROM api_tokens WHERE user_id = ? AND name = ?').get(req.session.userId, name);
  if (existing) return res.status(400).json({ error: 'You already have a token with that name' });

  const requestedScopes = Array.isArray(req.body?.scopes) ? [...new Set(req.body.scopes.map(String))] : ['read'];
  if (requestedScopes.length === 0 || requestedScopes.some((scope) => !API_TOKEN_SCOPES.has(scope))) {
    return res.status(400).json({ error: 'Invalid API token scope' });
  }
  if (requestedScopes.includes('admin') && !req.session.isAdmin) {
    return res.status(403).json({ error: 'Only administrators can create an admin-scoped API token' });
  }
  const scopes = requestedScopes.join(',');

  const secret = generateApiToken();
  const tokenHash = hashApiToken(secret);
  const expiresClause = expiresInDays !== null ? `datetime('now', '+${expiresInDays} days')` : 'NULL';

  const result = db.prepare(
    `INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ${expiresClause})`
  ).run(req.session.userId, name, tokenHash, scopes);

  const row = db.prepare(
    'SELECT id, name, scopes, created_at, expires_at, last_used_at FROM api_tokens WHERE id = ?'
  ).get(result.lastInsertRowid);

  logAudit(req, 'api_token_created', name, `${expiresInDays ? `expires in ${expiresInDays} days` : 'no expiry'}; scopes=${scopes}`);

  // `token` is the one and only time the plaintext is ever returned.
  res.status(201).json({ ...serializeApiToken(row), token: secret });
});

// Revoke one of the caller's own tokens.
router.delete('/tokens/:id', requireAuth, requireInteractiveSession, requireRecentReauthentication, (req, res) => {
  const token = db.prepare('SELECT id, name FROM api_tokens WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!token) return res.status(404).json({ error: 'Token not found' });
  db.prepare('DELETE FROM api_tokens WHERE id = ?').run(token.id);
  logAudit(req, 'api_token_revoked', token.name, '');
  res.json({ ok: true });
});

export default router;
