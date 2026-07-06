import db from '../db.js';
import {
  getAllVMs, getVMConfig, updateVMConfig, getLXCConfig, updateLXCConfig,
} from '../proxmox.js';

// Mirrors PVE's tag rules: first char [a-z0-9_], then [a-z0-9_\-\+\.]*
// (PVE lowercases tags by default, so we lowercase up front).
export function sanitizePveTag(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_+.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9_]+/, '')
    .replace(/-+$/, '')
    .slice(0, 40);
}

// Every `netX: ...,tag=<n>` on the VM becomes a `vlan-<name>` tag (falling
// back to `vlan-<n>` when the portal doesn't know the VLAN). Untagged NICs
// get no tag.
function vlanTagsFromConfig(config) {
  const tags = new Set();
  for (const [key, value] of Object.entries(config)) {
    if (!/^net\d+$/.test(key) || typeof value !== 'string') continue;
    const m = value.match(/(?:^|,)tag=(\d+)/);
    if (!m) continue;
    const vlanNumber = Number(m[1]);
    const vlan = db.prepare('SELECT name FROM vlans WHERE tag = ?').get(vlanNumber);
    const name = vlan?.name ? sanitizePveTag(vlan.name) : '';
    tags.add(name ? `vlan-${name}` : `vlan-${vlanNumber}`);
  }
  return [...tags];
}

// Rewrites the PVE tags of one VM to <owner-username> + vlan-<...> based on
// the portal's assignment table and the VM's own net config. The portal owns
// two tag namespaces — tags equal to a portal username and tags starting with
// `vlan-` — and leaves every other (manually set) tag untouched.
// `retired` lists usernames that no longer exist in the users table (renamed
// or deleted) whose tags must still be stripped.
export async function syncVmTags(node, vmid, { retired = [] } = {}) {
  const numericVmid = Number(vmid);

  // VMIDs are globally unique across connected clusters, so the resource list
  // is enough to learn the guest type and canonical node ref.
  const vms = await getAllVMs();
  const vm = vms.find((v) => Number(v.vmid) === numericVmid);
  const isLxc = vm?.type === 'lxc';
  const ref = vm?.nodeRef || node;

  const config = isLxc ? await getLXCConfig(ref, numericVmid) : await getVMConfig(ref, numericVmid);

  const owner = db.prepare(`
    SELECT u.username FROM vm_assignments va
    JOIN users u ON u.id = va.user_id
    WHERE va.vmid = ?
  `).get(numericVmid);
  const ownerTag = owner ? sanitizePveTag(owner.username) : '';

  const usernameTags = new Set(
    db.prepare('SELECT username FROM users').all().map((u) => sanitizePveTag(u.username)),
  );
  for (const name of retired) usernameTags.add(sanitizePveTag(name));

  const existing = String(config.tags || '')
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const foreign = existing.filter((t) => !usernameTags.has(t) && !t.startsWith('vlan-'));

  const next = [...new Set([
    ...(ownerTag ? [ownerTag] : []),
    ...vlanTagsFromConfig(config),
    ...foreign,
  ])];

  if (next.join(';') === existing.join(';')) return { changed: false, tags: next };

  const update = isLxc ? updateLXCConfig : updateVMConfig;
  await update(ref, numericVmid, { tags: next.join(';') });
  return { changed: true, tags: next };
}

// Tagging is bookkeeping — it must never fail the assignment or provisioning
// operation that triggered it.
export async function syncVmTagsSafe(node, vmid, opts) {
  try {
    return await syncVmTags(node, vmid, opts);
  } catch (err) {
    console.warn(`[tags] failed to sync PVE tags for VM ${vmid}: ${err.message}`);
    return { changed: false, error: err.message };
  }
}
