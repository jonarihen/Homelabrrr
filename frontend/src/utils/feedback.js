// Pure state helpers behind useToast() and useConfirm() (contexts/FeedbackContext.jsx).

export const TOAST_TIMEOUT_MS = 5000;

// Errors stay until dismissed so they cannot vanish before they are read.
export function toastTimeout(kind) {
  return kind === 'error' ? null : TOAST_TIMEOUT_MS;
}

export function toastReducer(toasts, action) {
  switch (action.type) {
    case 'add': return [...toasts, action.toast];
    case 'dismiss': return toasts.filter((t) => t.id !== action.id);
    case 'clear': return [];
    default: return toasts;
  }
}

// confirm('text') or confirm({ title, message, confirmLabel, cancelLabel, danger }).
export function confirmOptions(arg) {
  const opts = typeof arg === 'string' ? { message: arg } : { ...arg };
  return {
    title: opts.title || (opts.danger ? 'Are you sure?' : 'Confirm'),
    message: opts.message || '',
    confirmLabel: opts.confirmLabel || 'Confirm',
    cancelLabel: opts.cancelLabel || 'Cancel',
    danger: !!opts.danger,
  };
}
