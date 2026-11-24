// Backend routes guarded by requireRecentReauthentication answer 403 with
// REAUTHENTICATION_REQUIRED. Pages listed here have no dialog of their own, so
// the api client asks through the app-wide ReauthPrompt and replays the request.
// Other guarded pages park their work and show RecentReauthDialog themselves;
// they must stay out of this list or the user would be prompted twice.
const PROMPTED_PATHS = /^\/?admin\/(users|roles|invites|tokens|power-control)(\/|\?|$)/;

let handler = null;
let pending = null;

export function setReauthHandler(next) {
  handler = next;
  return () => { if (handler === next) handler = null; };
}

export function shouldPromptReauth(err) {
  const config = err?.config;
  return err?.response?.data?.code === 'REAUTHENTICATION_REQUIRED'
    && !!config
    && !config._reauthRetried
    && PROMPTED_PATHS.test(config.url || '');
}

// Resolves true once the user has confirmed. Requests that fail together share
// one dialog.
export function requestReauth() {
  if (!handler) return Promise.resolve(false);
  pending ??= Promise.resolve(handler()).finally(() => { pending = null; });
  return pending;
}
