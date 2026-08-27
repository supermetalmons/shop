export type BrowserLockManager = {
  request: <T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T>,
  ) => Promise<T>;
};

function browserLockManager(): BrowserLockManager | null {
  if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') return null;
  return navigator.locks as unknown as BrowserLockManager;
}
export async function withBrowserLock<T>(
  name: string,
  run: () => Promise<T>,
  lockManager: BrowserLockManager | null = browserLockManager(),
): Promise<T> {
  if (!lockManager) {
    throw new Error('This browser cannot safely coordinate wallet transactions. Update your browser and try again.');
  }
  return lockManager.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('Another wallet transaction is already in progress. Wait for it to finish and try again.');
    return run();
  });
}

export function persistPreparedReservationOrThrow<T>(
  reservation: T,
  persist: (reservation: T) => boolean,
  message: string,
): void {
  if (!persist(reservation)) throw new Error(message);
}
