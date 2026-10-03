export interface ProvisionAllocation {
  version: 1;
  userId: number | null;
  createdBy: string;
  cores: number;
  memoryMb: number;
  diskGb: number;
  state: 'pending' | 'owned' | 'released';
  ownedAt?: number;
}

export function provisionAllocation(steps: unknown): ProvisionAllocation | null {
  if (!Array.isArray(steps)) return null;
  const allocation = steps.find(step => step?.key === 'reserve')?.allocation;
  if (allocation?.version !== 1 || !['pending', 'owned', 'released'].includes(allocation.state)) return null;
  if (allocation.userId !== null && (!Number.isInteger(allocation.userId) || allocation.userId <= 0)) return null;
  if (typeof allocation.createdBy !== 'string') return null;
  if (![allocation.cores, allocation.memoryMb, allocation.diskGb].every(value => Number.isFinite(value) && value >= 0)) return null;
  return allocation;
}
