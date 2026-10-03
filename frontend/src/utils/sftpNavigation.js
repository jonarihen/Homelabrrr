export function createSftpNavigation() {
  let sequence = 0;
  let loading = false;
  let confirmedPath = null;

  return {
    async load(path, request, { onStart, onSuccess, onError, onFinish }) {
      const requestSequence = ++sequence;
      const isCurrent = () => requestSequence === sequence;
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
      const requestSequence = sequence;
      return {
        path: confirmedPath,
        isCurrent: () => requestSequence === sequence,
      };
    },
    invalidate() {
      sequence += 1;
      loading = false;
      confirmedPath = null;
    },
  };
}
