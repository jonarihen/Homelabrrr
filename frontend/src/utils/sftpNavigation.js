export function createSftpNavigation() {
  let sequence = 0;
  let directoryVersion = 0;
  let loading = false;
  let confirmedPath = null;

  return {
    async load(path, request, { onStart, onSuccess, onError, onFinish }) {
      const requestSequence = ++sequence;
      const isCurrent = () => requestSequence === sequence;
      if (path !== confirmedPath) directoryVersion += 1;
      loading = true;
      onStart();
      try {
        const data = await request();
        if (!isCurrent()) return;
        confirmedPath = data.path || path;
        onSuccess(data, confirmedPath);
      } catch (error) {
        if (isCurrent()) onError(error);
      } finally {
        if (isCurrent()) {
          loading = false;
          onFinish();
        }
      }
    },
    getMutationTarget(path) {
      if (loading || confirmedPath === null || path !== confirmedPath) return null;
      const targetVersion = directoryVersion;
      const targetPath = confirmedPath;
      return {
        path: targetPath,
        isCurrent: () => targetVersion === directoryVersion && targetPath === confirmedPath,
      };
    },
    invalidate() {
      sequence += 1;
      directoryVersion += 1;
      loading = false;
      confirmedPath = null;
    },
  };
}
