export function operationNeedsReview(operation) {
  return operation.status === 'needs_review' || (operation.type === 'provision' && operation.status === 'timeout');
}

export function readyResolution(operation, evidence) {
  const body = { status: operation.type === 'migration' ? 'ok' : 'ready' };
  if (operation.type === 'provision' && !operation.upid) {
    if (typeof evidence !== 'string' || evidence.trim().length < 10 || evidence.length > 1000) return null;
    body.verified = true;
    body.evidence = evidence.trim();
  }
  return body;
}
