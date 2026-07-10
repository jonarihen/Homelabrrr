import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notify, portalLink } from '../utils/notify.js';
import { decryptSecret, encryptSecret } from '../utils/secrets.js';
import { syncVmTagsSafe } from '../utils/vmTags.js';
import { effectivePermissions } from '../utils/permissions.js';
import { hashInviteToken, inviteStatus, summarizeInvitePreset, INVITE_PERMISSION_COLUMNS } from '../utils/invites.js';

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
    },
  };
}

function startUserSession(req, user, { twoFactorEnrollmentOnly = false } = {}) {
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.isAdmin = user.is_admin === 1;
  req.session.twoFactorEnrollmentOnly = twoFactorEnrollmentOnly;
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
      return res.json({ requiresTwoFactor: true });
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

  const isValid = authenticator.verify({ token: code.replace(/\s/g, ''), secret: decryptSecret(user.totp_secret) });
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

  const { username, password } = req.body;
  // Username policy identical to admin-created users (non-empty + unique);
  // password is policy-checked to a minimum length for self-registration.
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
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

router.put('/change-username', requireAuth, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
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

router.put('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.session.userId);
  res.json({ ok: true });
});

// ─── 2FA management (requires existing full session) ─────────────────────────

// Generate a new secret and return a QR code (does NOT enable 2FA yet)
router.post('/2fa/setup', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT username, totp_enabled FROM users WHERE id = ?').get(req.session.userId);
  // Never let setup clobber an active second factor — otherwise a single call
  // silently disables 2FA (totp_enabled=0) even if enrollment is never finished.
  if (user.totp_enabled) {
    return res.status(400).json({ error: '2FA is already enabled — disable it first to re-enroll' });
  }
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(user.username, 'VM Manager', secret);

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
router.post('/2fa/enable', requireAuth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const user = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.session.userId);
  if (!user?.totp_secret) return res.status(400).json({ error: 'Run setup first' });
  if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });

  const isValid = authenticator.verify({ token: code.replace(/\s/g, ''), secret: decryptSecret(user.totp_secret) });
  if (!isValid) return res.status(400).json({ error: 'Invalid code — try again' });

  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.session.userId);
  req.session.twoFactorEnrollmentOnly = false;
  logAudit(req, '2fa_enabled', req.session.username, '');
  res.json({ ok: true });
});

// Disable 2FA (requires current TOTP code to confirm)
router.post('/2fa/disable', requireAuth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const user = db.prepare('SELECT totp_secret, totp_enabled, require_2fa FROM users WHERE id = ?').get(req.session.userId);
  if (!user?.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });
  if (user.require_2fa) return res.status(403).json({ error: 'Your account is required to keep 2FA enabled' });

  const isValid = authenticator.verify({ token: code.replace(/\s/g, ''), secret: decryptSecret(user.totp_secret) });
  if (!isValid) return res.status(400).json({ error: 'Invalid code' });

  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.session.userId);
  logAudit(req, '2fa_disabled', req.session.username, '');
  res.json({ ok: true });
});

export default router;
