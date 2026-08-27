export const POST_ACTION_INVENTORY_POLL_INTERVAL_MS = 3_000;

export type PostActionInventoryRefetch = (
  options: { cancelRefetch: false },
) => unknown;

export type PostActionPollingScheduler = {
  setInterval: (run: () => void, delayMs: number) => unknown;
  clearInterval: (timer: unknown) => void;
};

export function startPostActionInventoryPolling(
  refetch: PostActionInventoryRefetch,
  scheduler: PostActionPollingScheduler,
): () => void {
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    void refetch({ cancelRefetch: false });
  };
  tick();
  const interval = scheduler.setInterval(tick, POST_ACTION_INVENTORY_POLL_INTERVAL_MS);
  return () => {
    cancelled = true;
    scheduler.clearInterval(interval);
  };
}
