export function sshClientError(err) {
  const message = String(err?.message || err || '');
  if (/host key|fingerprint|verification|SHA256:/i.test(message)) return { code: 'SSH_HOST_KEY_MISMATCH', error: 'The VM’s SSH host key does not match the saved fingerprint. If the VM was rebuilt, scan the fingerprint again; otherwise do not connect.' };
  if (/authentication|permission denied|all configured authentication methods failed/i.test(message)) return { code: 'SSH_AUTHENTICATION_FAILED', error: 'The VM rejected the login. Check the username (VMs deployed here use the cloud-init user chosen at deploy, which is often not root), that this SSH key was added to the VM, and the key passphrase.' };
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return { code: 'SSH_TIMEOUT', error: 'The VM did not answer on the SSH port in time. Check that it is running and the IP is right; a new VM may still be booting.' };
  if (/refused|ECONNREFUSED/i.test(message)) return { code: 'SSH_CONNECTION_REFUSED', error: 'The VM refused the SSH connection. SSH may not be running yet, or it listens on another port.' };
  if (/not found|ENOTFOUND|EAI_AGAIN/i.test(message)) return { code: 'SSH_HOST_UNAVAILABLE', error: 'The SSH host could not be found. Check the host or IP.' };
  return { code: 'SSH_CONNECTION_FAILED', error: 'SSH connection failed' };
}
