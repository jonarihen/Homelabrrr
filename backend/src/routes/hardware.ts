import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { hardwareConnections, pveHosts } from '../db/schema/index.ts';
import { requireAuth, requirePermission, requireInteractiveSession } from '../middleware/auth.ts';
import { encryptSecret, decryptSecret } from '../utils/secrets.ts';
import { decodeNodeRef, isValidNodeName } from '../utils/nodeRef.ts';
import { logAudit } from '../utils/audit.ts';
import { isUniqueViolation } from '../db/errors.ts';
import { discoverHardware, IloError } from '../services/iloAdapter.ts';
import { sanitizeError } from '../utils/sanitize.ts';

const router = Router();
router.use(requireAuth, requirePermission('can_manage_hosts'), requireInteractiveSession);

function safeDto(row: any) {
  const { secret: _secret, ca_certificate: _ca, ...safe } = row;
  return { ...safe, has_secret: Boolean(row.secret), has_ca_certificate: Boolean(row.ca_certificate) };
}
function target(body: any) {
  const host = String(body?.host || '').trim();
  const port = Number(body?.port ?? 443);
  const username = String(body?.username || '').trim();
  if (!host || host.length > 253 || /[\/:?#@\s]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !username || username.length > 128) throw new Error('Invalid iLO connection fields');
  return { host, port, username };
}
function validOptionalSecrets(body: any): boolean {
  return (body?.password == null || (typeof body.password === 'string' && body.password.length <= 4096))
    && (body?.caCertificate == null || (typeof body.caCertificate === 'string' && body.caCertificate.length <= 65536));
}
function parsedId(raw: string): number {
  const n = Number(raw); if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid connection id'); return n;
}
router.get('/', async (_req, res) => {
  const rows = await db.select().from(hardwareConnections).where(eq(hardwareConnections.lifecycle_state, 'active'));
  res.json(rows.map(safeDto));
});
router.post('/', async (req, res) => {
  try {
    if (!validOptionalSecrets(req.body)) return res.status(400).json({ error: 'Invalid credential or CA certificate' });
    const node = decodeNodeRef(req.body?.nodeRef);
    if (!node.hostId || !isValidNodeName(node.nodeName) || node.nodeRef !== `${node.hostId}~${node.nodeName}`) return res.status(400).json({ error: 'Canonical node reference required' });
    const [hostRow] = await db.select({ id: pveHosts.id }).from(pveHosts).where(eq(pveHosts.id, node.hostId)).limit(1);
    if (!hostRow) return res.status(404).json({ error: 'PVE host not found' });
    const input = target(req.body);
    if (!req.body?.password) return res.status(400).json({ error: 'Password required' });
    const verifyTls = req.body?.verifyTls !== false;
    if (!verifyTls && process.env.ALLOW_INSECURE_UPSTREAM_TLS !== 'true') return res.status(400).json({ error: 'Unverified TLS is disabled' });
    const [row] = await db.insert(hardwareConnections).values({ pve_host_id: node.hostId, node_ref: node.nodeRef, target_host: input.host, target_port: input.port, username: input.username, secret: encryptSecret(String(req.body.password)), verify_tls: verifyTls, ca_certificate: req.body?.caCertificate || null }).returning();
    await logAudit(req, 'hardware_connection_created', String(row.id), `node=${row.node_ref}`);
    res.status(201).json(safeDto(row));
  } catch (err) { if (isUniqueViolation(err)) return res.status(409).json({ error: 'Node or physical system already has an active hardware connection' }); if (err instanceof Error && err.message === 'Invalid iLO connection fields') return res.status(400).json({ error: err.message }); res.status(500).json({ error: sanitizeError(err) }); }
});
router.put('/:id', async (req, res) => {
  try {
    if (!validOptionalSecrets(req.body)) return res.status(400).json({ error: 'Invalid credential or CA certificate' });
    const id = parsedId(req.params.id);
    const [existing] = await db.select().from(hardwareConnections).where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'))).limit(1);
    if (!existing) return res.status(404).json({ error: 'Connection not found' });
    const input = target(req.body);
    const verifyTls = req.body?.verifyTls !== false;
    if (!verifyTls && process.env.ALLOW_INSECURE_UPSTREAM_TLS !== 'true') return res.status(400).json({ error: 'Unverified TLS is disabled' });
    const [row] = await db.update(hardwareConnections).set({ target_host: input.host, target_port: input.port, username: input.username, secret: req.body.password ? encryptSecret(String(req.body.password)) : existing.secret, ca_certificate: req.body.clearCaCertificate ? null : (req.body.caCertificate || existing.ca_certificate), verify_tls: verifyTls, collection_enabled: false, control_enabled: false, config_version: existing.config_version + 1, system_uuid: null, model: null, generation: null, firmware: null, capabilities: null, last_status: 'not_tested', updated_at: new Date() }).where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.config_version, Number(req.body?.configVersion)))).returning();
    if (!row) return res.status(409).json({ error: 'Connection was changed concurrently' });
    await logAudit(req, 'hardware_connection_updated', String(id), `node=${row.node_ref}`);
    res.json(safeDto(row));
  } catch (err) { if (err instanceof Error && (err.message === 'Invalid iLO connection fields' || err.message === 'Invalid connection id')) return res.status(400).json({ error: err.message }); res.status(500).json({ error: sanitizeError(err) }); }
});
router.post('/:id/test', async (req, res) => {
  try {
    const id = parsedId(req.params.id);
    const [row] = await db.select().from(hardwareConnections).where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'))).limit(1);
    if (!row) return res.status(404).json({ error: 'Connection not found' });
    const discovery = await discoverHardware({ host: row.target_host, port: row.target_port, username: row.username, password: decryptSecret(row.secret), verifyTls: row.verify_tls, caCertificate: row.ca_certificate });
    const systemUuid = discovery.identity.uuid || (discovery.identity.serial ? `serial:${discovery.identity.serial}` : null);
    if (systemUuid) {
      const [duplicate] = await db.select({ id: hardwareConnections.id }).from(hardwareConnections).where(and(eq(hardwareConnections.system_uuid, systemUuid), eq(hardwareConnections.lifecycle_state, 'active'))).limit(1);
      if (duplicate && duplicate.id !== id) return res.status(409).json({ error: 'This physical system is already bound to another node' });
    }
    const [saved] = await db.update(hardwareConnections).set({ system_uuid: systemUuid, model: discovery.model, generation: discovery.generation, firmware: discovery.firmware, capabilities: discovery.capabilities, last_status: 'online', last_test_at: new Date(), updated_at: new Date() }).where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.config_version, row.config_version), eq(hardwareConnections.lifecycle_state, 'active'))).returning();
    if (!saved) return res.status(409).json({ error: 'Connection changed while test was running' });
    await logAudit(req, 'hardware_connection_tested', String(id), `node=${row.node_ref}; status=online`);
    res.json({ connection: safeDto(saved), discovery });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'This physical system is already bound to another node' });
    if (err instanceof IloError) return res.status(err.code === 'authentication_failed' ? 403 : 502).json({ status: err.code, error: err.message });
    res.status(500).json({ error: sanitizeError(err) });
  }
});
router.delete('/:id', async (req, res) => {
  try {
    const id = parsedId(req.params.id);
    const [row] = await db.update(hardwareConnections).set({ lifecycle_state: 'decommissioned', collection_enabled: false, control_enabled: false, secret: '', ca_certificate: null, updated_at: new Date() }).where(and(eq(hardwareConnections.id, id), eq(hardwareConnections.lifecycle_state, 'active'))).returning();
    if (!row) return res.status(404).json({ error: 'Connection not found' });
    await logAudit(req, 'hardware_connection_decommissioned', String(id), `node=${row.node_ref}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: sanitizeError(err) }); }
});
export default router;
