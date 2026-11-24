import { userCanPerformVmOp } from '../../utils/vmAccess.ts';
import { decodeNodeRef } from '../../utils/nodeRef.ts';

// Every VM route runs through here. `op` is a key of VM_OP_TIERS
// (utils/vmOps.js) — that table, not the call site, decides whether the caller
// needs an assignment, `see_all_vms`, or `can_operate_all_vms`.
export function allowOp(req, node, vmid, op) {
  return userCanPerformVmOp(req.session.userId, node, vmid, req.session.isAdmin, op);
}

export function serializeNodeIdentity(nodeValue) {
  const { nodeName, nodeRef } = decodeNodeRef(nodeValue);
  return {
    node: nodeName || String(nodeValue || ''),
    nodeRef: nodeRef || String(nodeValue || ''),
  };
}

