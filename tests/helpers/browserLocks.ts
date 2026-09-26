import type { TestContext } from 'node:test';

export function createBrowserLockManager(): LockManager {
  const pending = new Map<string, Promise<void>>();
  return {
    request<T>(name: string, options: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>): Promise<T> {
      const run = typeof options === 'function' ? options : callback!;
      const signal = typeof options === 'function' ? undefined : options.signal;
      const previous = pending.get(name) ?? Promise.resolve();
      const result = previous.then(() => { signal?.throwIfAborted(); return run({ name, mode: 'exclusive' } as Lock); });
      const settled = result.then(() => undefined, () => undefined);
      pending.set(name, settled);
      void settled.then(() => { if (pending.get(name) === settled) pending.delete(name); });
      if (!signal) return result;
      return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
        void result.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => {
          signal.removeEventListener('abort', aborted); reject(error);
        });
      });
    },
  } as LockManager;
}

export function installBrowserLocks(context: Pick<TestContext, 'after'>, locks = createBrowserLockManager()): LockManager {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const target = typeof navigator === 'undefined' ? {} : navigator;
  const originalLocks = Object.getOwnPropertyDescriptor(target, 'locks');
  Object.defineProperty(target, 'locks', { configurable: true, value: locks });
  if (!originalNavigator) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: target });
  context.after(() => {
    if (originalLocks) Object.defineProperty(target, 'locks', originalLocks);
    else Reflect.deleteProperty(target, 'locks');
    if (!originalNavigator) Reflect.deleteProperty(globalThis, 'navigator');
  });
  return locks;
}
