import type { LoadingManager } from 'three';
import type { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export type ClearCardModelLoadResources = {
  loadingManager: LoadingManager | null;
  dracoLoader: DRACOLoader | null;
  abortRequested: boolean;
};

type DracoWorker = {
  _callbacks?: Record<string, DracoTaskCallback>;
};

type DracoTaskCallback = { reject?: (error: Error) => void };

type DracoLoaderInternals = DRACOLoader & {
  workerPool?: DracoWorker[];
};

function reportCleanupError(action: 'abort' | 'dispose', error: unknown) {
  console.error(`[mons] failed to ${action} clear-card model loading`, error);
}

function dracoWorkers(dracoLoader: DRACOLoader): DracoWorker[] {
  const workers = (dracoLoader as DracoLoaderInternals).workerPool;
  return Array.isArray(workers) ? workers.slice() : [];
}

function rejectDracoTasks(
  workers: DracoWorker[],
  rejectedCallbacks: Set<DracoTaskCallback>,
) {
  const error = new Error('Clear-card model loading was aborted.');
  error.name = 'AbortError';
  workers.forEach((worker) => {
    const callbacks = worker._callbacks;
    if (!callbacks) return;
    Object.values(callbacks).forEach((callback) => {
      if (rejectedCallbacks.has(callback)) return;
      rejectedCallbacks.add(callback);
      try {
        callback.reject?.(error);
      } catch (callbackError) {
        reportCleanupError('abort', callbackError);
      }
    });
  });
}

export function releaseClearCardModelLoadResources(
  load: ClearCardModelLoadResources,
  abort = false,
) {
  if (abort) load.abortRequested = true;
  if (load.abortRequested && load.loadingManager) {
    try {
      load.loadingManager.abort();
      load.loadingManager = null;
    } catch (error) {
      reportCleanupError('abort', error);
    }
  } else if (!abort) {
    load.loadingManager = null;
  }

  const dracoLoader = load.dracoLoader;
  if (!dracoLoader) return;
  if (load.abortRequested) {
    const workers = dracoWorkers(dracoLoader);
    const rejectedCallbacks = new Set<DracoTaskCallback>();
    try {
      dracoLoader.setWorkerLimit(0);
    } catch (error) {
      reportCleanupError('dispose', error);
    }
    rejectDracoTasks(workers, rejectedCallbacks);
    setTimeout(() => {
      if (load.dracoLoader === dracoLoader) rejectDracoTasks(workers, rejectedCallbacks);
    }, 0);
  }
  try {
    dracoLoader.dispose();
    if (!abort) load.dracoLoader = null;
  } catch (error) {
    reportCleanupError('dispose', error);
  }
}
