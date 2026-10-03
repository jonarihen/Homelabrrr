export function createSftpNavigation() {
  let sequence = 0;
  let directoryVersion = 0;
  let sessionVersion = 0;
  let loading = false;
  let confirmedPath = null;
  let activeToken;
  let hasToken = false;
  let controller = null;

  const invalidate = () => {
    sequence += 1;
    directoryVersion += 1;
    sessionVersion += 1;
    controller?.abort();
    controller = null;
    loading = false;
    confirmedPath = null;
    hasToken = false;
  };

  const setToken = (token) => {
    if (hasToken && token === activeToken) return false;
    invalidate();
    activeToken = token;
    hasToken = true;
    return true;
  };

  return {
    setToken,
    async load(path, request, { onStart, onSuccess, onError, onFinish }, token) {
      setToken(token);
      const requestSequence = ++sequence;
      const isCurrent = () => requestSequence === sequence;
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      if (path !== confirmedPath) directoryVersion += 1;
      loading = true;
      onStart();
      try {
        const data = await request(signal);
        if (!isCurrent()) return;
        confirmedPath = data.path || path;
        onSuccess(data, confirmedPath);
      } catch (error) {
        if (isCurrent()) onError(error);
      } finally {
        if (isCurrent()) {
          controller = null;
          loading = false;
          onFinish();
        }
      }
    },
    getMutationTarget(path, token) {
      if (!hasToken || token !== activeToken || loading || confirmedPath === null || path !== confirmedPath) return null;
      const targetVersion = directoryVersion;
      const targetSession = sessionVersion;
      const targetPath = confirmedPath;
      return {
        path: targetPath,
        isCurrent: () => targetVersion === directoryVersion && targetPath === confirmedPath,
        isSessionCurrent: () => targetSession === sessionVersion,
      };
    },
    invalidate,
  };
}
