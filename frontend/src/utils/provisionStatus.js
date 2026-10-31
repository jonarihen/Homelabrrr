// Statuses after which the provisioning job stops changing on its own.
// needs_review is a failure that an operator has to resolve.
export const PROVISION_TERMINAL = ['ready', 'warning', 'error', 'timeout', 'needs_review'];
export const PROVISION_FAILED = ['error', 'timeout', 'needs_review'];
