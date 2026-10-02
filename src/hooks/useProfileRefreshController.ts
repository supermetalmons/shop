import { useCallback, useMemo, useRef } from 'react';
import type { GetProfileStateResponse } from '../types';

type ProfileRefreshRun = {
  contextGeneration: number;
  sessionRevision: number;
  promise: Promise<boolean>;
  attempt: Promise<boolean>;
};

type ProfileRefreshOperation = {
  contextGeneration: number;
  sessionRevision: number;
  isCurrent: () => boolean;
  ensureAuthSubject: () => Promise<string>;
  applyProfileState: (response: GetProfileStateResponse, subject: string) => boolean;
  onError: (error: unknown) => void | Promise<void>;
};

type ProfileRefreshRuntime = {
  currentAuthSubject: () => string | null;
  loadProfileState: () => Promise<GetProfileStateResponse>;
};

type ProfileRefreshController = {
  refresh: (operation: ProfileRefreshOperation, runtime: ProfileRefreshRuntime) => Promise<boolean>;
  getCurrentRun: () => Readonly<ProfileRefreshRun> | null;
  invalidate: () => void;
};

type ActiveProfileRefreshRun = ProfileRefreshRun & { queued: boolean };

export function useProfileRefreshController(): ProfileRefreshController {
  const activeRunRef = useRef<ActiveProfileRefreshRun | null>(null);

  const refresh = useCallback((
    operation: ProfileRefreshOperation,
    runtime: ProfileRefreshRuntime,
  ): Promise<boolean> => {
    const existing = activeRunRef.current;
    if (existing && existing.contextGeneration === operation.contextGeneration &&
      existing.sessionRevision === operation.sessionRevision) {
      existing.queued = true;
      return existing.promise;
    }
    const run: ActiveProfileRefreshRun = {
      contextGeneration: operation.contextGeneration,
      sessionRevision: operation.sessionRevision,
      queued: false,
      promise: Promise.resolve(true),
      attempt: Promise.resolve(true),
    };
    const execute = async (): Promise<boolean> => {
      try {
        const subject = await operation.ensureAuthSubject();
        if (!operation.isCurrent() || runtime.currentAuthSubject() !== subject) return true;
        const response = await runtime.loadProfileState();
        if (!operation.isCurrent() || runtime.currentAuthSubject() !== subject) return true;
        return operation.applyProfileState(response, subject);
      } catch (error) {
        if (!operation.isCurrent()) return true;
        const handled = operation.onError(error);
        if (handled) await handled;
        throw error;
      }
    };
    run.promise = (async () => {
      let complete = true;
      do {
        run.queued = false;
        run.attempt = execute();
        complete = await run.attempt;
      } while (run.queued && operation.isCurrent());
      return complete;
    })().finally(() => {
      if (activeRunRef.current === run) activeRunRef.current = null;
    });
    activeRunRef.current = run;
    return run.promise;
  }, []);

  const getCurrentRun = useCallback(() => activeRunRef.current, []);
  const invalidate = useCallback(() => {
    activeRunRef.current = null;
  }, []);

  return useMemo(() => ({ refresh, getCurrentRun, invalidate }), [refresh, getCurrentRun, invalidate]);
}
