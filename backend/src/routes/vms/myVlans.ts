import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { vlans, userVlans } from '../../db/schema/index.ts';

const router = Router();

// ─── User's allowed VLANs ────────────────────────────────────────────────────

router.get('/my-vlans', async (req, res) => {
  if (req.session.isAdmin) {
    return res.json(await db.select().from(vlans).orderBy(vlans.tag));
  }
  const rows = await db
    .select({
      id: vlans.id,
      name: vlans.name,
      tag: vlans.tag,
      mode: vlans.mode,
      subnet_cidr: vlans.subnet_cidr,
      description: vlans.description,
      created_at: vlans.created_at,
    })
    .from(vlans)
    .innerJoin(userVlans, eq(userVlans.vlan_id, vlans.id))
    .where(eq(userVlans.user_id, req.session.userId))
    .orderBy(vlans.tag);
  res.json(rows);
});

export default router;
