import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { decryptSecret, encryptSecret } from '../utils/secrets.js';

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
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin === 1,
    twoFactorEnabled: !!user.totp_enabled,
    require2fa: !!user.require_2fa,
    canProvision: !!user.can_provision,
    canCreateVms: !!user.can_create_vms,
    permissions: {
      canManageHosts: !!user.can_manage_hosts,
      canManageFirewalls: !!user.can_manage_firewalls,
      canManageVlans: !!user.can_manage_vlans,
      canManagePolicies: !!user.can_manage_policies,
      canManageTemplates: !!user.can_manage_templates,
      canManageUsers: !!user.can_manage_users,
      canManageAssignments: !!user.can_manage_assignments,
      canViewAuditLog: !!user.can_view_audit_log,
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

router.post('/login', loginLimiter, async (req, res, next) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const now = Date.now();
  const windowStart = now - LOCKOUT_WINDOW_MS;

  db.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').run(windowStart);

  const { count } = db.prepare(
    'SELECT COUNT(*) as count FROM login_attempts WHERE username = ? AND attempted_at > ?'
  ).get(username, windowStart);

  if (count >= LOCKOUT_MAX) {
    return res.status(423).json({ error: 'Account locked — too many failed attempts. Try again in 10 minutes or contact an admin.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    db.prepare('INSERT INTO login_attempts (username, attempted_at) VALUES (?, ?)').run(username, now);
    logAudit({ session: { username: username }, headers: req.headers, ip: req.ip }, 'login_failed', username, '');
    const remaining = LOCKOUT_MAX - (count + 1);
    if (remaining <= 0) {
      return res.status(423).json({ error: 'Account locked — too many failed attempts. Try again in 10 minutes or contact an admin.' });
    }
    return res.status(401).json({ error: `Invalid credentials (${remaining} attempt${remaining !== 1 ? 's' : ''} remaining before lockout)` });
  }

  db.prepare('DELETE FROM login_attempts WHERE username = ?').run(username);

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

// ─── Logout ───────────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── Current user ─────────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = db.prepare(`
    SELECT id, username, is_admin, totp_enabled, require_2fa, can_provision, can_create_vms,
      can_manage_hosts, can_manage_firewalls, can_manage_vlans, can_manage_policies,
      can_manage_templates, can_manage_users, can_manage_assignments, can_view_audit_log
    FROM users
    WHERE id = ?
  `).get(req.session.userId);
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
  try {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.session.userId);
    req.session.username = username;
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
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId);
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(user.username, 'VM Manager', secret);

  // Store secret temporarily — not active until /2fa/enable confirms it
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(encryptSecret(secret), req.session.userId);

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
  res.json({ ok: true });
});

export default router;
