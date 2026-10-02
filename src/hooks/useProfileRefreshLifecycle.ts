import { useEffect } from 'react';
import { isRetryableApiError } from '../lib/apiErrors';

type ProfileRefreshLifecycleRuntime = {
  subscribeRefreshEvents: (listener: () => void) => () => void;
  isPageVisible: () => boolean;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (timer: unknown) => void;
};

type ProfileRefreshLifecycleOptions = {
  runtime: ProfileRefreshLifecycleRuntime;
  connectedWallet: string | null;
  authUserRevision: number;
  sessionWallet: string | null;
  beginCycle: () => boolean;
  refreshProfileState: () => Promise<boolean>;
  reconcileProfile: () => Promise<unknown>;
};

const PERSISTENT_RETRY_DELAYS_MS = [400, 800, 1_600, 5_000] as const;
const PROFILE_REFRESH_RETRY_DELAYS_MS = [400, 800, 1_600, 5_000, 30_000, 60_000] as const;
const PROFILE_REFRESH_INTERVAL_MS = 60_000;

function retryDelay(delays: readonly [number, ...number[]], retryCount: number): number {
  return delays[Math.min(retryCount, delays.length - 1)];
}

export function useProfileRefreshLifecycle({
  runtime,
  connectedWallet,
  authUserRevision,
  sessionWallet,
  beginCycle,
  refreshProfileState,
  reconcileProfile,
}: ProfileRefreshLifecycleOptions): void {
  useEffect(() => {
    if (!beginCycle()) return;
    let cancelled = false;
    let timer: unknown = null;
    let retryCount = 0;
    const clearTimer = () => {
      if (timer === null) return;
      runtime.clearTimer(timer);
      timer = null;
    };
    const schedule = (delay: number) => {
      clearTimer();
      if (cancelled || !runtime.isPageVisible()) return;
      timer = runtime.setTimer(() => {
        timer = null;
        if (!runtime.isPageVisible()) return;
        run();
      }, delay);
    };
    const run = () => {
      if (cancelled) return;
      clearTimer();
      void refreshProfileState().then(
        (complete) => {
          if (cancelled) return;
          if (complete) {
            retryCount = 0;
            schedule(PROFILE_REFRESH_INTERVAL_MS);
          } else {
            const delay = retryDelay(PROFILE_REFRESH_RETRY_DELAYS_MS, retryCount);
            retryCount += 1;
            schedule(delay);
          }
        },
        (refreshError) => {
          if (cancelled) return;
          if (isRetryableApiError(refreshError)) {
            const delay = retryDelay(PROFILE_REFRESH_RETRY_DELAYS_MS, retryCount);
            retryCount += 1;
            schedule(delay);
          } else {
            retryCount = 0;
            schedule(PROFILE_REFRESH_INTERVAL_MS);
          }
        },
      );
    };
    const unsubscribeRefreshEvents = runtime.subscribeRefreshEvents(run);
    run();
    return () => {
      cancelled = true;
      clearTimer();
      unsubscribeRefreshEvents();
    };
  }, [authUserRevision, connectedWallet, beginCycle, refreshProfileState, runtime]);

  useEffect(() => {
    if (!sessionWallet) return;
    let cancelled = false;
    let retryTimer: unknown = null;
    let retryCount = 0;
    const clearRetryTimer = () => {
      if (retryTimer === null) return;
      runtime.clearTimer(retryTimer);
      retryTimer = null;
    };
    const run = () => {
      if (cancelled) return;
      clearRetryTimer();
      void reconcileProfile()
        .then(() => {
          retryCount = 0;
        })
        .catch((reconcileError) => {
          if (cancelled) return;
          if (!isRetryableApiError(reconcileError)) {
            console.warn('[mons] failed to reconcile profile state', reconcileError);
            return;
          }
          const delay = retryDelay(PERSISTENT_RETRY_DELAYS_MS, retryCount);
          retryCount += 1;
          retryTimer = runtime.setTimer(run, delay);
        });
    };
    run();
    return () => {
      cancelled = true;
      clearRetryTimer();
    };
  }, [connectedWallet, reconcileProfile, runtime, sessionWallet]);
}
