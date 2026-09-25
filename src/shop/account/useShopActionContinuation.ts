import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

type WalletGateOptions = { signal?: AbortSignal; expectedWallet?: string };

type ShopActionContinuationOptions = {
  connectedWallet: string | undefined;
  scopeKey: string;
  cancellationSignal?: AbortSignal;
  ensureSignedIn: (options?: WalletGateOptions) => Promise<boolean>;
  ensureWalletConnected: (options?: WalletGateOptions) => Promise<string | null>;
  showToast: (message: string) => void;
};

type ShopActionRequest<T> = {
  key: string;
  requirement: 'wallet' | 'sign-in';
  expectedWallet?: string;
  isCurrent?: () => boolean;
  prepare?: () => boolean | void;
  ready?: () => boolean;
  readinessTimeoutMs?: number;
  readinessError?: string;
  execute: () => Promise<T> | T;
  cancelled: T;
};

type PendingAction = { key: string; phase: 'authenticating' | 'running' };
type ActionOperation = {
  controller: AbortController;
  scopeKey: string;
  wallet: string | undefined;
  gateWallet: string | undefined;
  expectedWallet: string | undefined;
  stage: 'authenticating' | 'preparing' | 'ready' | 'running';
  timeout: ReturnType<typeof setTimeout> | null;
  isCurrent: () => boolean;
  prepare: (() => boolean | void) | undefined;
  readinessError: string | undefined;
  ready: () => boolean;
  execute: () => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cancel: () => void;
  removeCancellationListener: () => void;
};

export function useShopActionContinuation(options: ShopActionContinuationOptions) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const active = useRef<ActionOperation | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [, setRevision] = useState(0);

  const clearTimeoutFor = (operation: ActionOperation) => {
    if (operation.timeout !== null) clearTimeout(operation.timeout);
    operation.timeout = null;
  };

  const release = useCallback((operation: ActionOperation) => {
    clearTimeoutFor(operation);
    operation.removeCancellationListener();
    if (active.current !== operation) return;
    active.current = null;
    if (mounted.current) setPendingAction(null);
  }, []);

  const cancel = useCallback(() => {
    const operation = active.current;
    if (!operation) return;
    operation.controller.abort();
    operation.cancel();
    clearTimeoutFor(operation);
    operation.removeCancellationListener();
    if (operation.stage !== 'running') release(operation);
  }, [release]);

  useEffect(() => {
    mounted.current = true;
    const cancelWaitingAction = () => {
      if (active.current?.stage !== 'running') cancel();
    };
    window.addEventListener('pagehide', cancelWaitingAction);
    return () => {
      window.removeEventListener('pagehide', cancelWaitingAction);
      mounted.current = false;
      cancel();
    };
  }, [cancel]);

  useLayoutEffect(() => {
    const operation = active.current;
    if (!operation || operation.controller.signal.aborted) return;
    if (
      operation.scopeKey !== options.scopeKey ||
      (operation.wallet && operation.wallet !== options.connectedWallet)
    ) {
      cancel();
      return;
    }
    if (!operation.wallet && options.connectedWallet) operation.wallet = options.connectedWallet;
  });

  useEffect(() => {
    const operation = active.current;
    if (!operation || operation.controller.signal.aborted) return;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed || !mounted.current || active.current !== operation || operation.controller.signal.aborted) return;
      try {
        const current = latest.current;
        if (operation.scopeKey !== current.scopeKey || !operation.isCurrent()) {
          cancel();
          return;
        }
        if (operation.wallet && operation.wallet !== current.connectedWallet) {
          cancel();
          return;
        }
        if (!operation.wallet && current.connectedWallet) operation.wallet = current.connectedWallet;
        if (operation.stage === 'authenticating' || operation.stage === 'running') return;
        if (!current.connectedWallet) return;
        if (
          (operation.expectedWallet && operation.expectedWallet !== current.connectedWallet) ||
          (operation.gateWallet && operation.gateWallet !== current.connectedWallet)
        ) {
          cancel();
          return;
        }
        if (operation.stage === 'preparing') {
          const prepared = operation.prepare?.();
          if (active.current !== operation || operation.controller.signal.aborted) return;
          if (prepared === false) return;
          operation.stage = 'ready';
          setRevision((value) => value + 1);
          return;
        }
        if (!operation.ready()) return;
        if (!operation.isCurrent() || operation.controller.signal.aborted) {
          cancel();
          return;
        }
        operation.stage = 'running';
        clearTimeoutFor(operation);
        setPendingAction((pending) => pending ? { ...pending, phase: 'running' } : pending);
        Promise.resolve(operation.execute()).then(operation.resolve, operation.reject).finally(() => release(operation));
      } catch (error) {
        if (operation.stage === 'running') {
          operation.reject(error);
          release(operation);
        } else {
          latest.current.showToast(operation.readinessError ?? (error instanceof Error ? error.message : 'Couldn’t continue this action. Please try again.'));
          cancel();
        }
      }
    });
    return () => { disposed = true; };
  });

  const run = useCallback(<T,>(request: ShopActionRequest<T>): Promise<T> => {
    const cancellationSignal = latest.current.cancellationSignal;
    if (!mounted.current || active.current || cancellationSignal?.aborted) return Promise.resolve(request.cancelled);
    const controller = new AbortController();
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    let settled = false;
    const result = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    const operation: ActionOperation = {
      controller,
      scopeKey: latest.current.scopeKey,
      wallet: latest.current.connectedWallet,
      gateWallet: undefined,
      expectedWallet: request.expectedWallet,
      stage: 'authenticating',
      timeout: null,
      isCurrent: request.isCurrent ?? (() => true),
      prepare: request.prepare,
      readinessError: request.readinessError,
      ready: request.ready ?? (() => true),
      execute: request.execute,
      resolve: (value) => {
        if (settled) return;
        settled = true;
        resolve(value as T);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        resolve(request.cancelled);
      },
      removeCancellationListener: () => {},
    };
    active.current = operation;
    const cancelOnSessionChange = () => {
      if (active.current === operation) cancel();
    };
    cancellationSignal?.addEventListener('abort', cancelOnSessionChange, { once: true });
    operation.removeCancellationListener = () => cancellationSignal?.removeEventListener('abort', cancelOnSessionChange);
    setPendingAction({ key: request.key, phase: 'authenticating' });
    const gateOptions = { signal: controller.signal, expectedWallet: request.expectedWallet };
    const authenticate = async () => {
      try {
        const authenticated = request.requirement === 'sign-in'
          ? await latest.current.ensureSignedIn(gateOptions)
          : await latest.current.ensureWalletConnected(gateOptions);
        if (active.current !== operation || controller.signal.aborted || !mounted.current) return;
        if (!authenticated) {
          cancel();
          return;
        }
        if (typeof authenticated === 'string') {
          if (operation.wallet && operation.wallet !== authenticated) {
            cancel();
            return;
          }
          operation.gateWallet = authenticated;
        }
        operation.stage = 'preparing';
        operation.timeout = setTimeout(() => {
          if (active.current !== operation || controller.signal.aborted) return;
          latest.current.showToast(request.readinessError ?? 'Couldn’t continue this action. Please try again.');
          cancel();
        }, request.readinessTimeoutMs ?? 20_000);
        setRevision((value) => value + 1);
      } catch (error) {
        if (active.current !== operation || controller.signal.aborted) return;
        operation.reject(error);
        release(operation);
      }
    };
    void authenticate();
    return result;
  }, [cancel, release]);

  return { pendingAction, run, cancel };
}
