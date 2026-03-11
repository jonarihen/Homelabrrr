export function sanitizeError(msg) {
  if (!msg) return 'Internal server error';
  return msg
    .replace(/https?:\/\/[\d.:]+\/api2\/json\S*/g, '[proxmox-api]')
    .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g, '[internal-host]');
}
