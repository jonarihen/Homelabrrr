import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import listRouter from './vms/list.ts';
import leaseRouter from './vms/lease.ts';
import powerRouter from './vms/power.ts';
import deleteRouter from './vms/delete.ts';
import metricsRouter from './vms/metrics.ts';
import consoleRouter from './vms/console.ts';
import ipManagementRouter from './vms/ipManagement.ts';
import configRouter from './vms/config.ts';
import hardwareRouter from './vms/hardware.ts';
import backupsRouter from './vms/backups.ts';
import snapshotsRouter from './vms/snapshots.ts';
import scheduleRouter from './vms/schedule.ts';
import myVlansRouter from './vms/myVlans.ts';

export { vncSessions } from './vms/console.ts';

const router = Router();
router.use(requireAuth);

router.use(listRouter);
router.use(leaseRouter);
router.use(powerRouter);
router.use(deleteRouter);
router.use(metricsRouter);
router.use(consoleRouter);
router.use(ipManagementRouter);
router.use(configRouter);
router.use(hardwareRouter);
router.use(backupsRouter);
router.use(snapshotsRouter);
router.use(scheduleRouter);
router.use(myVlansRouter);

export default router;
