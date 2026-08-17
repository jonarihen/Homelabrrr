const activeWork = new Map();
let acceptingWork = true;
let sequence = 0;

export function startBackgroundWork(work, metadata = {}) {
  if (!acceptingWork) {
    const error = new Error('Background work is not accepting new jobs during shutdown');
    error.code = 'BACKGROUND_WORK_STOPPING';
    error.status = 503;
    return Promise.reject(error);
  }

  const id = ++sequence;
  const promise = Promise.resolve()
    .then(work)
    .finally(() => activeWork.delete(id));

  activeWork.set(id, { promise, metadata: { ...metadata } });
  return promise;
}

export function stopAcceptingBackgroundWork() {
  acceptingWork = false;
}

export async function waitForBackgroundWork() {
  await Promise.allSettled([...activeWork.values()].map(({ promise }) => promise));
}

export function backgroundWorkStatus() {
  return {
    accepting: acceptingWork,
    active: [...activeWork.values()].map(({ metadata }) => ({ ...metadata })),
  };
}
