export function retentionModifier(days) {
  const parsed = typeof days === 'number' ? days : Number(String(days).trim());
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('Retention days must be a positive integer');
  return `-${parsed} days`;
}
