// Which support/payment methods the owner has switched on, read from the
// GET /payments/status answer. Pure: shared by the sidebar, the Energy page
// and the Support page so they cannot disagree about what a member may see.

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

// A status answer from before bank transfer had a switch carries no
// `bankTransfer` block; there it was always on, so missing means enabled.
export function supportMethods(status) {
  if (!isRecord(status)) return { paypal: false, kofi: false, bankTransfer: false };
  return {
    paypal: status.checkoutEnabled === true,
    kofi: status.kofi?.enabled === true,
    bankTransfer: status.bankTransfer?.enabled !== false,
  };
}

// Whether the "Support the lab" entry is shown at all. The server's own answer
// wins (it also covers a member who still has a subscription to manage); an
// older answer without it falls back to "any method on". Anything that is not
// a status object — not loaded yet, a failed request — hides the entry.
export function supportVisible(status) {
  if (!isRecord(status)) return false;
  if (typeof status.showSupport === 'boolean') return status.showSupport;
  const methods = supportMethods(status);
  return methods.paypal || methods.kofi || methods.bankTransfer;
}
