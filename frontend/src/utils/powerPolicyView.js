// Pure helpers for the Hardware → Power policy panel. Kept out of the JSX so
// the request shape and status wording are unit-tested.

export const POWER_MODES = [['low', 'Static Low Power'], ['dynamic', 'Dynamic / Balanced'], ['high', 'Static High Performance']];

export function modeLabel(mode) {
  return POWER_MODES.find(([value]) => value === mode)?.[1] || 'No automatic change';
}

// Only allowlisted fields go to the server, and an unset price-only default
// is omitted rather than silently defaulted. Thresholds stay as typed
// (Danish commas allowed); the server normalizes and validates them.
export function policyRequest(draft) {
  const price = draft.pricePolicy;
  const request = {
    version: draft.version,
    automationEnabled: draft.automationEnabled === true,
    schedule: {
      enabled: draft.schedule.enabled === true,
      timezone: draft.schedule.timezone,
      defaultMode: draft.schedule.defaultMode,
      windows: draft.schedule.windows.map(({ days, start, end, mode }) => ({ days, start, end, mode })),
    },
    pricePolicy: {
      enabled: price.enabled === true,
      basis: price.basis,
      contractRef: price.contractRef,
      area: price.area,
      minAutomaticUpshiftMinutes: price.minAutomaticUpshiftMinutes,
      expensive: { enabled: price.expensive.enabled === true, threshold: price.expensive.threshold,
        hysteresis: price.expensive.hysteresis, capMode: price.expensive.capMode },
      cheap: { enabled: price.cheap.enabled === true, threshold: price.cheap.threshold, hysteresis: price.cheap.hysteresis },
    },
  };
  if (price.priceOnlyDefault) request.pricePolicy.priceOnlyDefault = price.priceOnlyDefault;
  return request;
}

const OUTCOME_TEXT = {
  verified: 'Verified', already_set: 'Already in mode', unknown: 'Unverified (will be re-read before any retry)',
  failed: 'Failed', stale: 'Cancelled (policy changed before dispatch)', unavailable: 'Host not running',
  read_failed: 'iLO unreadable', host_not_running: 'Host off or booting', policy_invalid: 'Stored policy invalid',
  not_applied: 'Not applied', reachable: 'Reachable', drift_resumed: 'Resumed after external change',
  drift_hold_released: 'Hold released at weekly boundary', requested: 'Requested (in flight)',
};

export function outcomeLabel(outcome) {
  if (!outcome) return 'None yet';
  if (outcome.startsWith('external_drift:')) return `External change to ${modeLabel(outcome.slice(15))}`;
  return OUTCOME_TEXT[outcome] || outcome.replaceAll('_', ' ');
}

// Status lines for operator visibility: hold, backoff, pending verification
// and in-flight state are distinct and never merged into one "error".
export function controlStatusLines(policy, nowMs = Date.now()) {
  const lines = [];
  if (!policy) return lines;
  if (policy.driftHold) {
    lines.push({ tone: 'warning', text: policy.driftHoldUntil
      ? `External iLO change: automatic writes held until the next weekly boundary (${new Date(policy.driftHoldUntil).toISOString()}).`
      : 'External iLO change: automatic writes held until you resume.' });
  }
  if (policy.pendingTarget) lines.push({ tone: 'warning', text: `A ${modeLabel(policy.pendingTarget)} request is unverified; the next check reads the mode before any retry.` });
  if (policy.nextAttemptAt && Date.parse(policy.nextAttemptAt) > nowMs) {
    lines.push({ tone: 'warning', text: `${policy.failureCount || 0} consecutive problem(s); next automatic attempt after ${new Date(policy.nextAttemptAt).toISOString()}.` });
  }
  if (policy.lastError) lines.push({ tone: 'error', text: `Last problem: ${String(policy.lastError).replaceAll('_', ' ')}` });
  if (policy.actionInFlight) lines.push({ tone: 'info', text: 'A hardware action is in flight; edits wait until it finishes.' });
  return lines;
}
