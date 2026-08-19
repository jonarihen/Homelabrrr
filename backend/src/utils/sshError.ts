export function sshClientError(err) {
  const message = String(err?.message || err || '');
  if (/host key|fingerprint|verification|SHA256:/i.test(message)) return { code: 'SSH_HOST_KEY_MISMATCH', error: 'SSH host identity did not match the saved fingerprint' };
  if (/authentication|permission denied|all configured authentication methods failed/i.test(message)) return { code: 'SSH_AUTHENTICATION_FAILED', error: 'SSH authentication failed' };
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return { code: 'SSH_TIMEOUT', error: 'SSH connection timed out' };
  if (/refused|ECONNREFUSED/i.test(message)) return { code: 'SSH_CONNECTION_REFUSED', error: 'SSH connection was refused' };
  if (/not found|ENOTFOUND|EAI_AGAIN/i.test(message)) return { code: 'SSH_HOST_UNAVAILABLE', error: 'SSH host could not be reached' };
  return { code: 'SSH_CONNECTION_FAILED', error: 'SSH connection failed' };
}
