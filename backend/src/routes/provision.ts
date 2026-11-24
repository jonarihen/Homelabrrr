import { Router } from 'express';
import { requireAuth } from '../middleware/auth.ts';
import lookupsRouter from './provision/lookups.ts';
import cloneRouter from './provision/clone.ts';
import fromImageRouter from './provision/fromImage.ts';
import createRouter from './provision/create.ts';
import statusRouter from './provision/status.ts';
import adminTemplatesRouter from './provision/adminTemplates.ts';

const router = Router();
router.use(requireAuth);

router.use(lookupsRouter);
router.use(cloneRouter);
router.use(fromImageRouter);
router.use(createRouter);
router.use(statusRouter);
router.use(adminTemplatesRouter);

export default router;
