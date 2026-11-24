import { Router } from 'express';
import { requireAuth, requireInteractiveSession, requireRecentReauthentication } from '../middleware/auth.ts';
import readinessRouter from './admin/readiness.ts';
import usersRouter from './admin/users.ts';
import rolesRouter from './admin/roles.ts';
import invitesRouter from './admin/invites.ts';
import assignmentsRouter from './admin/assignments.ts';
import vlansRouter from './admin/vlans.ts';
import settingsRouter from './admin/settings.ts';
import pveHostsRouter from './admin/pveHosts.ts';
import firewallsRouter from './admin/firewalls.ts';
import vlanSyncRouter from './admin/vlanSync.ts';
import policiesRouter from './admin/policies.ts';
import portForwardsRouter from './admin/portForwards.ts';
import auditLogRouter from './admin/auditLog.ts';

const router = Router();
// All admin routes require at least authentication
router.use(requireAuth);

// User, role, invite, and credential administration is intentionally browser
// session only. A broadly scoped automation token must not become an identity
// provider if it is leaked.
router.use(['/users', '/roles', '/invites', '/tokens'], requireInteractiveSession);
router.use(['/users', '/roles', '/invites', '/tokens'], (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return requireRecentReauthentication(req, res, next);
});


router.use(readinessRouter);
router.use(usersRouter);
router.use(rolesRouter);
router.use(invitesRouter);
router.use(assignmentsRouter);
router.use(vlansRouter);
router.use(settingsRouter);
router.use(pveHostsRouter);
router.use(firewallsRouter);
router.use(vlanSyncRouter);
router.use(policiesRouter);
router.use(portForwardsRouter);
router.use(auditLogRouter);

export default router;
