import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreorderConfig, PreorderOrder } from '../../shared/preorders.ts';
import { createPreorderApi } from '../lib/preorderApi';
import { listPreorderRecoveries, upsertPreorderRecovery } from '../lib/preorderRecovery';
import { runPreorderStatus } from '../lib/preorderStatusQueue';
import { subscribeBrowserRefreshEvents } from '../lib/browserRefreshEvents';
import { usePreorderRecoveryRecords } from './usePreorderRecoveryRecords';
import { usePreorderReconciliation, type PreorderRecoveryApi } from './usePreorderReconciliation';
import { parsePendingPreorder, type PendingPreorder } from '../lib/preorderPending';

const preorderApi = createPreorderApi();
const RECOVERY_ERROR_MESSAGE = 'Couldn’t check your preorder. We’ll keep checking.';
const RECOVERY_CONFLICT_MESSAGE = 'Another preorder is being checked.';

type RecoveryOptions = {
  config: PreorderConfig;
  buyer: string | undefined;
  signedIn: boolean;
  authenticatedBuyer: string | undefined;
  onSettled?: (order: PreorderOrder) => void;
};

function activeOrder(order: PreorderOrder | null): boolean {
  return order?.status === 'prepared' || order?.status === 'submitted' && order.confirmedSlot == null;
}

function storageKey(config: PreorderConfig, buyer: string): string {
  return `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
}

function readPending(key: string): PendingPreorder | null {
  try {
    return parsePendingPreorder(JSON.parse(window.localStorage.getItem(key) || 'null'));
  } catch {
    return null;
  }
}

function writePending(key: string, pending: PendingPreorder | null): void {
  try {
    if (pending) window.localStorage.setItem(key, JSON.stringify(pending));
    else window.localStorage.removeItem(key);
  } catch {}
}

function samePending(left: PendingPreorder | null, right: PendingPreorder | null): boolean {
  return left === right || Boolean(left && right && left.requestId === right.requestId &&
    left.ethereumAddress === right.ethereumAddress &&
    left.orderId === right.orderId && Boolean(left.submittedAttempt) === Boolean(right.submittedAttempt) &&
    left.cardIds.length === right.cardIds.length && left.cardIds.every((id, index) => id === right.cardIds[index]));
}

export function usePreorderRecovery(options: RecoveryOptions, api: PreorderRecoveryApi = preorderApi) {
  const { config } = options;
  const buyer = options.buyer ?? options.authenticatedBuyer;
  const signedIn = options.buyer ? options.signedIn : Boolean(options.authenticatedBuyer);
  const scope = buyer ? storageKey(config, buyer) : '';
  const scopeId = `${config.preorderId}:${scope}`;
  const [recoveryScope, setRecoveryScope] = useState(scopeId);
  const latest = useRef({ ...options, buyer, signedIn });
  latest.current = { ...options, buyer, signedIn };
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [order, setOrder] = useState<PreorderOrder | null>(null);
  const [pending, setPending] = useState<PendingPreorder | null>(null);
  const pendingRef = useRef<PendingPreorder | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cancellingRef = useRef(false);
  const cancellationOperation = useRef<symbol | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const recoveryGeneration = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const recoveryRecords = usePreorderRecoveryRecords(buyer);
  const settled = useRef(new Set<string>());
  const commitPending = useCallback((value: PendingPreorder | null) => {
    pendingRef.current = value;
    setPending(value);
  }, []);
  const commitCancelling = useCallback((value: boolean) => {
    cancellingRef.current = value;
    setCancelling(value);
  }, []);
  const notifySettled = useCallback((next: PreorderOrder) => {
    if (activeOrder(next)) return;
    const key = `${next.buyer}:${next.preorderId}:${next.orderId}:${next.status}:${next.confirmedSlot ?? ''}`;
    if (settled.current.has(key)) return;
    settled.current.add(key);
    latest.current.onSettled?.(next);
  }, []);

  usePreorderReconciliation({ buyer, signedIn, preorderId: config.preorderId, enabled: config.enabled, api,
    onTerminal: notifySettled,
  });

  const keepPending = useCallback((value: PendingPreorder | null, key: string) => {
    writePending(key, value);
    if (currentScope.current !== key) return;
    commitPending(value);
  }, [commitPending]);

  const adoptPending = useCallback((value: PendingPreorder) => {
    recoveryGeneration.current += 1;
    commitPending(value);
    setOrder(null);
    setError(null);
    setRecoveryReady(false);
  }, [commitPending]);

  const acceptOrder = useCallback((next: PreorderOrder, key: string): PreorderOrder | false => {
    if (currentScope.current !== key || next.buyer !== latest.current.buyer || next.preorderId !== config.preorderId) return false;
    const recorded = listPreorderRecoveries(next.buyer).find(record => record.order.orderId === next.orderId && record.order.preorderId === next.preorderId)?.order;
    if (recorded && (next.status === 'prepared' || next.status === 'submitted' && (next.confirmedSlot == null || recorded.status !== 'submitted'))) next = recorded;
    const matches = (value: PendingPreorder | null) => value &&
      (value.orderId === next.orderId || value.orderId === undefined &&
        value.cardIds.length === next.cardIds.length && value.cardIds.every((id, index) => id === next.cardIds[index]));
    const stored = readPending(key);
    if (stored && !(stored.orderId === next.orderId || stored.orderId === undefined &&
      stored.requestId && stored.requestId === pendingRef.current?.requestId && matches(stored) && matches(pendingRef.current))) {
      if (samePending(stored, pendingRef.current)) {
        setRecoveryReady(true);
        setError(RECOVERY_CONFLICT_MESSAGE);
      } else {
        adoptPending(stored);
        setRecoveryRevision(value => value + 1);
      }
      return false;
    }
    setOrder(next);
    if (activeOrder(next)) {
      const saved = matches(stored) ? stored : null;
      const previous = matches(pendingRef.current) ? pendingRef.current : null;
      keepPending({ requestId: saved?.requestId ?? previous?.requestId ?? null, cardIds: next.cardIds, orderId: next.orderId, ethereumAddress: next.ethereumAddress,
        ...(next.status === 'submitted' || saved?.submittedAttempt || previous?.submittedAttempt ? { submittedAttempt: true } : {}),
      }, key);
    } else {
      keepPending(null, key);
      const rollback = next.confirmedSlot != null && (next.status === 'failed' || next.status === 'expired');
      setError(rollback ? null : next.status === 'failed' ? 'The preorder transaction failed.'
        : next.status === 'expired' ? 'Your preorder expired.' : null);
      notifySettled(next);
    }
    return next;
  }, [adoptPending, config.preorderId, keepPending, notifySettled]);

  const acceptPersistedOrder = useCallback(async (next: PreorderOrder, key: string, isCurrent: () => boolean) => {
    if (next.confirmedSlot != null) await upsertPreorderRecovery(next);
    return isCurrent() && acceptOrder(next, key);
  }, [acceptOrder]);

  useEffect(() => {
    if (recoveryScope !== scopeId || cancellingRef.current) return;
    const currentPending = pendingRef.current;
    const orderId = currentPending?.orderId;
    if (!orderId) return;
    const currentOrder = order?.orderId === orderId ? order : null;
    if (!currentPending?.submittedAttempt && currentOrder?.status !== 'submitted') return;
    const expectedEthereumAddress = currentPending?.ethereumAddress !== undefined ? currentPending.ethereumAddress : currentOrder?.ethereumAddress;
    const expectedCardIds = currentPending.cardIds;
    if (expectedEthereumAddress === undefined) return;
    const recovered = recoveryRecords.find(({ order: value }) => value.orderId === orderId &&
      value.buyer === buyer && value.preorderId === config.preorderId && value.ethereumAddress === expectedEthereumAddress &&
      value.cardIds.length === expectedCardIds.length && value.cardIds.every(id => expectedCardIds.includes(id)) &&
      (!currentOrder || value.assets.length === currentOrder.assets.length && value.assets.every(asset =>
        currentOrder.assets.some(expected => expected.id === asset.id && expected.address === asset.address)) &&
        (!currentOrder.signature || value.signature === currentOrder.signature)))?.order;
    if (!recovered) return;
    const stored = readPending(scope);
    if (stored && stored.orderId !== orderId || !acceptOrder(recovered, scope)) return;
    recoveryGeneration.current += 1;
    setRecoveryReady(true);
  }, [acceptOrder, buyer, config.preorderId, order, pending, cancelling, recoveryRecords, recoveryScope, scope, scopeId]);

  useEffect(() => {
    recoveryGeneration.current += 1;
    cancellationOperation.current = null;
    commitCancelling(false);
    setOrder(null);
    setError(null);
    setRecoveryReady(false);
    commitPending(config.enabled && scope ? readPending(scope) : null);
    setRecoveryScope(scopeId);
    return () => { recoveryGeneration.current += 1; };
  }, [scope, scopeId, config.enabled, commitPending, commitCancelling]);

  useEffect(() => {
    if (!buyer || !signedIn || !config.enabled) return;
    let stopped = false;
    let checking = false;
    let lookedUp = false;
    let nextCheckAt = 0;
    let consecutiveFailures = 0;
    const recover = async (force = false) => {
      if (checking || cancellingRef.current || document.visibilityState === 'hidden' || !force && Date.now() < nextCheckAt) return;
      const saved = readPending(scope);
      if (saved && !samePending(saved, pendingRef.current)) {
        adoptPending(saved);
        lookedUp = false;
      }
      if (lookedUp && !pendingRef.current) return;
      checking = true;
      const generation = recoveryGeneration.current;
      let recoveringPending = pendingRef.current;
      const isCurrent = () => !stopped && currentScope.current === scope && !cancellingRef.current &&
        recoveryGeneration.current === generation && pendingRef.current === recoveringPending;
      try {
        const result = await runPreorderStatus(() => recoveringPending?.orderId
          ? api.status(config.preorderId, recoveringPending.orderId).then(status => ({ ...status, recoveries: [] as PreorderOrder[] }))
          : api.recoveries(config.preorderId));
        if (!isCurrent()) return;
        for (const recovered of result.recoveries) {
          if (recovered.buyer !== buyer || recovered.preorderId !== config.preorderId) throw new Error('Preorder wallet does not match.');
          await upsertPreorderRecovery(recovered);
          if (!isCurrent()) return;
        }
        if (result.order && (result.order.buyer !== buyer || result.order.preorderId !== config.preorderId)) {
          throw new Error('Preorder wallet or collection does not match.');
        }
        const stored = readPending(scope);
        if (stored && !samePending(stored, recoveringPending)) {
          adoptPending(stored);
          setRecoveryRevision(value => value + 1);
          return;
        }
        const retirePreparation = !recoveringPending?.submittedAttempt;
        if (retirePreparation) {
          keepPending(null, scope);
          setOrder(null);
          recoveringPending = null;
        }
        if (result.order && !(retirePreparation && result.order.status === 'prepared') &&
          !await acceptPersistedOrder(result.order, scope, isCurrent)) return;
        setError(current => current === RECOVERY_ERROR_MESSAGE || current === RECOVERY_CONFLICT_MESSAGE ? null : current);
        lookedUp = true;
        setRecoveryReady(true);
        consecutiveFailures = 0;
        nextCheckAt = Date.now() + 1_000;
      } catch {
        if (isCurrent()) {
          setError(RECOVERY_ERROR_MESSAGE);
          nextCheckAt = Date.now() + Math.min(15_000, 1_000 * 2 ** consecutiveFailures++);
        }
      } finally {
        checking = false;
      }
    };
    void recover();
    const interval = setInterval(() => { void recover(); }, 1_000);
    const focus = () => { void recover(true); };
    const storage = (event: StorageEvent) => {
      if (event.key !== scope || currentScope.current !== scope) return;
      const saved = readPending(scope);
      recoveryGeneration.current += 1;
      commitPending(saved ?? (pendingRef.current?.orderId ? pendingRef.current : null));
      lookedUp = false;
      void recover(true);
    };
    const unsubscribeRefreshEvents = subscribeBrowserRefreshEvents(focus);
    window.addEventListener('storage', storage);
    return () => {
      stopped = true;
      clearInterval(interval);
      unsubscribeRefreshEvents();
      window.removeEventListener('storage', storage);
    };
  }, [acceptPersistedOrder, adoptPending, api, buyer, commitPending, config.enabled, config.preorderId, keepPending, recoveryRevision, scope, signedIn]);

  const cancel = async () => {
    const unresolved = pendingRef.current && !pendingRef.current.orderId && !pendingRef.current.submittedAttempt && !activeOrder(order)
      ? pendingRef.current : null;
    if (!config.enabled || !signedIn || recoveryScope !== scopeId || !scope || cancellingRef.current ||
      (!unresolved && order?.status !== 'prepared')) return;
    const startScope = scope;
    const generation = ++recoveryGeneration.current;
    const operation = Symbol();
    cancellationOperation.current = operation;
    const isCurrent = () => latest.current.config.preorderId === config.preorderId && latest.current.signedIn &&
      currentScope.current === startScope && recoveryGeneration.current === generation && cancellationOperation.current === operation;
    commitCancelling(true);
    setError(null);
    try {
      const result = unresolved ? await runPreorderStatus(() => api.recoveries(config.preorderId))
        : { ...await api.cancel({ preorderId: config.preorderId, orderId: order!.orderId }), recoveries: [] as PreorderOrder[] };
      if (!isCurrent()) return;
      for (const recovered of result.recoveries) {
        if (recovered.buyer !== buyer || recovered.preorderId !== config.preorderId) throw new Error('Preorder wallet does not match.');
        await upsertPreorderRecovery(recovered);
        if (!isCurrent()) return;
      }
      if (result.order && (result.order.buyer !== buyer || result.order.preorderId !== config.preorderId)) {
        throw new Error('Preorder does not match this wallet or collection.');
      }
      if (unresolved) {
        const stored = readPending(startScope);
        if (stored && !samePending(stored, unresolved)) {
          adoptPending(stored);
          setRecoveryRevision(value => value + 1);
          return;
        }
        keepPending(null, startScope);
        setOrder(null);
        setRecoveryReady(true);
      }
      if (result.order) await acceptPersistedOrder(result.order, startScope, isCurrent);
    } catch {
      if (isCurrent()) setError('Couldn’t cancel yet. We’ll keep checking your preorder.');
    } finally {
      if (cancellationOperation.current === operation) {
        cancellationOperation.current = null;
        commitCancelling(false);
      }
    }
  };

  const currentRecovery = config.enabled && recoveryScope === scopeId;
  return {
    order: currentRecovery ? order : null,
    pending: currentRecovery ? pending : null,
    error: currentRecovery ? error : null,
    cancel,
    busy: currentRecovery && cancelling,
    recoveryReady: !config.enabled || !buyer || !signedIn || (currentRecovery && recoveryReady),
  };
}
