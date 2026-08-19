export function classifyUpstreamTask(task) {
  if (!task || task.status !== 'stopped') {
    return { status: 'running', detail: 'The upstream Proxmox task is still running; check again later.' };
  }
  if (task.exitstatus === 'OK') {
    return { status: 'needs_review', detail: 'The upstream task succeeded. Verify the resource in Proxmox, then acknowledge the final state.' };
  }
  return {
    status: 'error',
    detail: `The upstream task failed (${String(task.exitstatus || 'unknown result').slice(0, 120)}).`,
  };
}
