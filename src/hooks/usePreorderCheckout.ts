import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PreorderConfig, PreorderOrder } from '../../shared/preorders.ts';
import { createPreorderApi } from '../lib/preorderApi';
import { ProfileApiError } from '../api/transport';
import { isUserRejectedError } from '../shop/commerce/transactionSupport';
import { usePreorderAvailability } from './usePreorderAvailability';
import type { MiNoteEthereumSession } from '../../shared/miNoteAuth';
import { listPreorderRecoveries, upsertPreorderRecovery } from '../lib/preorderRecovery';
import { runPreorderStatus } from '../lib/preorderStatusQueue';
import { usePreorderRecoveryRecords } from './usePreorderRecoveryRecords';
import { usePreorderReconciliation, type PreorderCheckoutApi } from './usePreorderReconciliation';

const preorderApi = createPreorderApi();
const RECOVERY_ERROR_MESSAGE = 'Couldn’t check your preorder. We’ll keep checking.';
const RECOVERY_CONFLICT_MESSAGE = 'Another preorder is active. Continue to resolve it.';

type PendingPreorder = { requestId: string | null; cardIds: number[]; orderId?: string; submittedAttempt?: boolean; ethereumAddress?: string | null };
type CheckoutPhase = 'idle' | 'authenticating' | 'preparing' | 'signing' | 'submitting' | 'cancelling';
type CheckoutOptions = {
  config: PreorderConfig;
  active: boolean;
  buyer: string | undefined;
  signedIn: boolean;
  authenticatedBuyer: string | undefined;
  ethereumSession: MiNoteEthereumSession | null;
  onEthereumSessionInvalid?: () => void;
  signTransaction: ((transaction: VersionedTransaction) => Promise<VersionedTransaction>) | undefined;
  ensureSignedIn: () => Promise<boolean>;
  onSucceeded: (order: PreorderOrder) => void;
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
    const value = JSON.parse(window.localStorage.getItem(key) || 'null') as PendingPreorder | null;
    if (!value || (value.requestId !== null && typeof value.requestId !== 'string') ||
      !Array.isArray(value.cardIds) || value.cardIds.length < 1 || value.cardIds.length > 3 ||
      !value.cardIds.every((id) => Number.isSafeInteger(id) && id >= 1 && id <= 1395) ||
      (value.orderId !== undefined && typeof value.orderId !== 'string')) return null;
    return value;
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

export function usePreorderCheckout(options: CheckoutOptions, api: PreorderCheckoutApi = preorderApi) {
  const { config, active, buyer, signedIn } = options;
  const scope = buyer ? storageKey(config, buyer) : '';
  const scopeId = `${config.preorderId}:${scope}`;
  const [checkoutScope, setCheckoutScope] = useState(scopeId);
  const latest = useRef(options);
  latest.current = options;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const { availability, availabilityError, refreshAvailability, invalidatePreorderedAvailability } = usePreorderAvailability(config, active, api,
    options.ethereumSession, options.authenticatedBuyer, options.onEthereumSessionInvalid);
  const [order, setOrder] = useState<PreorderOrder | null>(null);
  const [pending, setPending] = useState<PendingPreorder | null>(null);
  const pendingRef = useRef<PendingPreorder | null>(null);
  const [phase, setPhase] = useState<CheckoutPhase>('idle');
  const phaseRef = useRef<CheckoutPhase>('idle');
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const recoveryGeneration = useRef(0);
  const activeOperation = useRef<number | null>(null);
  const activeCompletion = useRef<{ generation: number; scope: string; submittedOrder?: PreorderOrder; complete: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completed = useRef(new Set<string>());
  const liveOrders = useRef(new Map<string, PreorderOrder>());
  const recoveryRecords = usePreorderRecoveryRecords(buyer);
  const invalidatedRollbacks = useRef(new Set<string>());
  const ethereumAddress = options.ethereumSession?.address;
  useEffect(() => {
    if (!buyer || !ethereumAddress) return;
    const cardIds: number[] = [];
    for (const { order: recovered } of recoveryRecords) {
      if (recovered.buyer !== buyer || recovered.preorderId !== config.preorderId || recovered.ethereumAddress !== ethereumAddress ||
        recovered.status !== 'failed' && recovered.status !== 'expired') continue;
      const key = `${scopeId}:${ethereumAddress}:${recovered.orderId}`;
      if (invalidatedRollbacks.current.has(key)) continue;
      invalidatedRollbacks.current.add(key);
      cardIds.push(...recovered.cardIds);
    }
    if (!cardIds.length) return;
    invalidatePreorderedAvailability(cardIds);
    void refreshAvailability();
  }, [buyer, config.preorderId, ethereumAddress, invalidatePreorderedAvailability, recoveryRecords, refreshAvailability, scopeId]);
  usePreorderReconciliation({ buyer: buyer ?? options.authenticatedBuyer,
    signedIn: buyer ? signedIn : Boolean(options.authenticatedBuyer), preorderId: config.preorderId, enabled: config.enabled, api,
    onTerminal: (next) => {
      if (next.status === 'succeeded') void refreshAvailability();
      latest.current.onSettled?.(next);
    },
  });

  useEffect(() => {
    if (active) return;
    recoveryGeneration.current += 1;
    activeOperation.current = null;
    phaseRef.current = 'idle';
    setPhase('idle');
  }, [active]);

  const keepPending = useCallback((value: PendingPreorder | null, key: string) => {
    writePending(key, value);
    if (currentScope.current !== key) return;
    pendingRef.current = value;
    setPending(value);
  }, []);

  const adoptPending = useCallback((value: PendingPreorder) => {
    recoveryGeneration.current += 1;
    pendingRef.current = value;
    setPending(value);
    setOrder(null);
    setError(null);
    setRecoveryReady(false);
  }, []);

  const announceSuccess = useCallback((next: PreorderOrder) => {
    if ((next.status === 'succeeded' || next.status === 'submitted' && next.confirmedSlot != null) && !completed.current.has(next.orderId)) {
      completed.current.add(next.orderId);
      if (next.confirmedSlot == null || liveOrders.current.has(next.orderId)) latest.current.onSucceeded(next);
    }
  }, []);

  const acceptOrder = useCallback((next: PreorderOrder, key: string): PreorderOrder | false => {
    if (currentScope.current !== key || next.buyer !== latest.current.buyer || next.preorderId !== config.preorderId) return false;
    const recorded = listPreorderRecoveries(next.buyer).find(record => record.order.orderId === next.orderId && record.order.preorderId === next.preorderId)?.order;
    if (recorded && (next.status === 'prepared' || next.status === 'submitted' && (next.confirmedSlot == null || recorded.status !== 'submitted'))) next = recorded;
    const matches = (value: PendingPreorder | null) => value &&
      (value.orderId === next.orderId || value.orderId === undefined &&
        value.cardIds.length === next.cardIds.length && value.cardIds.every((id, index) => id === next.cardIds[index]));
    const stored = readPending(key);
    const legacyRequest = stored && !stored.ethereumAddress && !stored.orderId && !stored.submittedAttempt &&
      samePending(stored, pendingRef.current) && activeOrder(next);
    if (stored && !legacyRequest && !(stored.orderId === next.orderId || stored.orderId === undefined &&
      stored.requestId && stored.requestId === pendingRef.current?.requestId && matches(stored) && matches(pendingRef.current))) {
      if (samePending(stored, pendingRef.current)) {
        setRecoveryReady(true);
        setError(RECOVERY_CONFLICT_MESSAGE);
      } else {
        adoptPending(stored);
        setRecoveryRevision((value) => value + 1);
      }
      return false;
    }
    setOrder(next);
    if (activeOrder(next)) {
      const saved = matches(stored) ? stored : null;
      const previous = matches(pendingRef.current) ? pendingRef.current : null;
      keepPending({ requestId: saved?.requestId ?? previous?.requestId ?? null, cardIds: next.cardIds, orderId: next.orderId, ethereumAddress: next.ethereumAddress,
        ...(saved?.submittedAttempt || previous?.submittedAttempt ? { submittedAttempt: true } : {}),
      }, key);
    } else {
      keepPending(null, key);
      const rollback = next.confirmedSlot != null && (next.status === 'failed' || next.status === 'expired');
      setError(rollback ? null : next.status === 'failed' ? 'The preorder transaction failed. Select cards to try again.'
        : next.status === 'expired' ? 'Your preorder expired. Select cards to try again.' : null);
      if (!rollback) void refreshAvailability();
      announceSuccess(next);
    }
    return next;
  }, [adoptPending, announceSuccess, config.preorderId, keepPending, refreshAvailability]);

  const acceptPersistedOrder = useCallback(async (next: PreorderOrder, key: string, isCurrent: () => boolean) => {
    if (next.confirmedSlot != null) await upsertPreorderRecovery(next);
    return isCurrent() && acceptOrder(next, key);
  }, [acceptOrder]);

  useEffect(() => {
    if (checkoutScope !== scopeId || phaseRef.current !== 'idle' && phaseRef.current !== 'submitting') return;
    const currentPending = pendingRef.current;
    const waiting = activeCompletion.current?.scope === scope ? activeCompletion.current : null;
    const activeSubmission = waiting?.submittedOrder;
    const orderId = activeSubmission?.orderId ?? currentPending?.orderId;
    if (!orderId) return;
    const currentOrder = order?.orderId === orderId ? order : null;
    if (!activeSubmission && !currentPending?.submittedAttempt && currentOrder?.status !== 'submitted') return;
    const expectedOrder = activeSubmission ?? liveOrders.current.get(orderId) ?? currentOrder;
    const expectedEthereumAddress = activeSubmission ? activeSubmission.ethereumAddress
      : currentPending?.ethereumAddress !== undefined ? currentPending.ethereumAddress : expectedOrder?.ethereumAddress;
    const expectedCardIds = activeSubmission?.cardIds ?? currentPending?.cardIds;
    if (expectedEthereumAddress === undefined) return;
    const recovered = recoveryRecords.find(({ order: value }) => value.orderId === orderId &&
      value.buyer === buyer && value.preorderId === config.preorderId && value.ethereumAddress === expectedEthereumAddress &&
      expectedCardIds && value.cardIds.length === expectedCardIds.length && value.cardIds.every(id => expectedCardIds.includes(id)) &&
      (!expectedOrder || value.assets.length === expectedOrder.assets.length && value.assets.every(asset =>
        expectedOrder.assets.some(expected => expected.id === asset.id && expected.address === asset.address)) &&
        (!expectedOrder.signature || value.signature === expectedOrder.signature)))?.order;
    if (!recovered) return;
    const stored = readPending(scope);
    const replacement = stored && stored.orderId !== orderId ? stored
      : currentPending && currentPending.orderId !== orderId ? currentPending : null;
    if (replacement) {
      if (!activeSubmission) return;
      adoptPending(replacement);
      setRecoveryRevision(value => value + 1);
      announceSuccess(recovered);
    } else if (!acceptOrder(recovered, scope)) return;
    recoveryGeneration.current += 1;
    activeOperation.current = null;
    phaseRef.current = 'idle';
    setPhase('idle');
    if (!replacement) setRecoveryReady(true);
    if (waiting?.submittedOrder?.orderId === recovered.orderId) {
      waiting.complete();
      activeCompletion.current = null;
    }
  }, [acceptOrder, adoptPending, announceSuccess, buyer, checkoutScope, config.preorderId, order, pending, phase, recoveryRecords, scope, scopeId]);

  useEffect(() => {
    recoveryGeneration.current += 1;
    activeOperation.current = null;
    setOrder(null);
    setError(null);
    setPhase('idle');
    phaseRef.current = 'idle';
    setRecoveryReady(false);
    const saved = config.enabled && scope ? readPending(scope) : null;
    pendingRef.current = saved;
    setPending(saved);
    setCheckoutScope(scopeId);
    return () => { activeOperation.current = null; };
  }, [scope, scopeId, config.enabled]);

  useEffect(() => {
    if (!buyer || !signedIn || !config.enabled || (!active && !readPending(scope))) return;
    let stopped = false;
    let checking = false;
    let lookedUp = false;
    let nextCheckAt = 0;
    let consecutiveFailures = 0;
    const recover = async (force = false) => {
      if (checking || phaseRef.current !== 'idle' || document.visibilityState === 'hidden' || !force && Date.now() < nextCheckAt) return;
      const saved = readPending(scope);
      if (saved && !samePending(saved, pendingRef.current)) {
        adoptPending(saved);
        lookedUp = false;
      }
      if (lookedUp && !pendingRef.current) return;
      checking = true;
      const generation = recoveryGeneration.current;
      const recoveringPending = pendingRef.current;
      const isCurrent = () => !stopped && currentScope.current === scope && phaseRef.current === 'idle' &&
        recoveryGeneration.current === generation && pendingRef.current === recoveringPending;
      try {
        const result = await runPreorderStatus(() => !recoveringPending?.orderId && api.recoveries
          ? api.recoveries(config.preorderId) : api.status(config.preorderId, recoveringPending?.orderId));
        if (!isCurrent()) return;
        for (const recovered of (result as { recoveries?: PreorderOrder[] }).recoveries ?? []) {
          if (recovered.buyer !== buyer || recovered.preorderId !== config.preorderId) throw new Error('Preorder wallet does not match.');
          await upsertPreorderRecovery(recovered);
          if (!isCurrent()) return;
        }
        if (result.order && result.order.buyer !== buyer) throw new Error('Preorder wallet does not match.');
        if (result.order && !await acceptPersistedOrder(result.order, scope, isCurrent)) return;
        if (!result.order && recoveringPending && !recoveringPending.ethereumAddress &&
          !recoveringPending.orderId && !recoveringPending.submittedAttempt) {
          const stored = readPending(scope);
          if (stored && !samePending(stored, recoveringPending)) {
            adoptPending(stored);
            setRecoveryRevision(value => value + 1);
            return;
          }
          keepPending(null, scope);
        }
        setError((current) => current === RECOVERY_ERROR_MESSAGE || current === RECOVERY_CONFLICT_MESSAGE ? null : current);
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
      const next = saved ?? (pendingRef.current?.orderId ? pendingRef.current : null);
      pendingRef.current = next;
      setPending(next);
      lookedUp = false;
      void recover(true);
    };
    window.addEventListener('focus', focus);
    window.addEventListener('storage', storage);
    document.addEventListener('visibilitychange', focus);
    return () => {
      stopped = true;
      clearInterval(interval);
      window.removeEventListener('focus', focus);
      window.removeEventListener('storage', storage);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [acceptPersistedOrder, active, adoptPending, api, buyer, config.enabled, config.preorderId, keepPending, recoveryRevision, scope, signedIn]);

  const beginOperation = (key: string, initialPhase: CheckoutPhase) => {
    const generation = ++recoveryGeneration.current;
    activeOperation.current = generation;
    const completion = new Promise<{ order: null }>((resolve) => {
      activeCompletion.current = { generation, scope: key, complete: () => resolve({ order: null }) };
    });
    const isCurrent = () => latest.current.config.preorderId === config.preorderId && currentScope.current === key && activeOperation.current === generation &&
      recoveryGeneration.current === generation;
    const setCurrentPhase = (value: CheckoutPhase) => {
      if (!isCurrent()) return;
      phaseRef.current = value;
      setPhase(value);
    };
    setCurrentPhase(initialPhase);
    return { isCurrent, setCurrentPhase, completion, finish: () => {
      if (activeCompletion.current?.generation === generation) activeCompletion.current = null;
      if (currentScope.current !== key || activeOperation.current !== generation) return;
      activeOperation.current = null;
      phaseRef.current = 'idle';
      setPhase('idle');
    } };
  };

  const purchase = async (selectedIds: number[]) => {
    if (!latest.current.active || !config.enabled || checkoutScope !== scopeId || latest.current.config.preorderId !== config.preorderId || phaseRef.current !== 'idle' || order?.status === 'submitted' && order.confirmedSlot == null || pendingRef.current?.submittedAttempt) return;
    const startScope = scope;
    const ethereumSession = latest.current.ethereumSession;
    if (!ethereumSession || ethereumSession.preorderId !== config.preorderId || ethereumSession.expiresAtMs <= Date.now()) {
      setError('Verify your Ethereum wallet before preordering.');
      return;
    }
    if ((activeOrder(order) && order!.ethereumAddress !== ethereumSession.address) ||
      (pendingRef.current?.ethereumAddress && pendingRef.current.ethereumAddress !== ethereumSession.address)) {
      setError('Switch back to the Ethereum wallet for this preorder, or cancel it.');
      return;
    }
    const operation = beginOperation(startScope, 'authenticating');
    const originalIsCurrent = operation.isCurrent;
    operation.isCurrent = () => originalIsCurrent() && latest.current.ethereumSession?.token === ethereumSession.token && ethereumSession.expiresAtMs > Date.now();
    setError(null);
    let preparedOrder: PreorderOrder | null = null;
    let attemptedSubmit = false;
    try {
      if (!await latest.current.ensureSignedIn()) return;
      if (!buyer || !operation.isCurrent() || !latest.current.active) return;
      const signer = latest.current.signTransaction;
      if (!signer) throw new Error('Use a wallet that supports transaction signing to preorder.');
      const previous = pendingRef.current;
      if (previous && !previous.requestId) throw new Error('Cancel your existing preorder before starting another.');
      const cardIds = previous?.cardIds ?? [...selectedIds].sort((left, right) => left - right);
      if (!cardIds.length || cardIds.length > config.maxItems || new Set(cardIds).size !== cardIds.length ||
        !cardIds.every((id) => Number.isSafeInteger(id) && id >= 1 && id <= 1395)) return;
      const requestId = previous?.requestId ?? crypto.randomUUID();
      keepPending({ requestId, cardIds, ethereumAddress: ethereumSession.address, ...(previous?.orderId ? { orderId: previous.orderId } : {}) }, startScope);
      operation.setCurrentPhase('preparing');
      const prepared = await api.prepare({ preorderId: config.preorderId, buyer, cardIds, requestId }, ethereumSession);
      if (!operation.isCurrent() || !latest.current.active) return;
      preparedOrder = prepared.order;
      const accepted = await acceptPersistedOrder(prepared.order, startScope, operation.isCurrent);
      if (!accepted) return;
      preparedOrder = accepted;
      void refreshAvailability();
      if (preparedOrder.status !== 'prepared') return;
      if (!prepared.transactionBase64) throw new Error('Your preorder is being checked. Try again shortly.');
      if (Date.now() >= preparedOrder.expiresAtMs) throw new Error('This preorder expired. Waiting for availability to refresh.');
      operation.setCurrentPhase('signing');
      const transaction = VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.transactionBase64), (character) => character.charCodeAt(0)));
      const originalMessage = transaction.message.serialize();
      const signed = await signer(transaction);
      if (!operation.isCurrent() || !latest.current.active) return;
      const acceptedAfterSigning = acceptOrder(preparedOrder, startScope);
      if (!acceptedAfterSigning || acceptedAfterSigning.status !== 'prepared') return;
      preparedOrder = acceptedAfterSigning;
      if (!signed.message.serialize().every((value, index) => value === originalMessage[index]) || signed.message.serialize().length !== originalMessage.length) {
        throw new Error('The wallet changed the preorder transaction.');
      }
      if (Date.now() >= preparedOrder.expiresAtMs) throw new Error('This preorder expired before signing finished.');
      operation.setCurrentPhase('submitting');
      attemptedSubmit = true;
      const submittedOrder = { ...preparedOrder, status: 'submitted' as const, signature: bs58.encode(signed.signatures[0]) };
      liveOrders.current.set(preparedOrder.orderId, submittedOrder);
      if (activeCompletion.current) activeCompletion.current.submittedOrder = submittedOrder;
      keepPending({ requestId, cardIds, orderId: preparedOrder.orderId, ethereumAddress: ethereumSession.address, submittedAttempt: true }, startScope);
      const result = await Promise.race([api.submit({
        preorderId: config.preorderId,
        orderId: preparedOrder.orderId,
        transactionBase64: btoa(String.fromCharCode(...signed.serialize())),
      }, ethereumSession), operation.completion]);
      if (!operation.isCurrent()) return;
      if (result.order) await acceptPersistedOrder(result.order, startScope, operation.isCurrent);
    } catch (cause) {
      if (!originalIsCurrent()) return;
      if (attemptedSubmit && preparedOrder && cause instanceof ProfileApiError && cause.status && cause.status >= 400 && cause.status < 500 && !cause.retrySameOperation) {
        try {
          const recovered = await Promise.race([
            runPreorderStatus(() => api.status(config.preorderId, preparedOrder!.orderId)), operation.completion,
          ]);
          if (!originalIsCurrent()) return;
          const stored = readPending(startScope);
          if (stored && !samePending(stored, pendingRef.current)) {
            adoptPending(stored);
            setRecoveryRevision(value => value + 1);
            return;
          }
          if (recovered.order?.status === 'prepared') {
            keepPending({ requestId: pendingRef.current?.requestId ?? null, cardIds: recovered.order.cardIds,
              orderId: recovered.order.orderId, ethereumAddress: recovered.order.ethereumAddress }, startScope);
            const accepted = await acceptPersistedOrder(recovered.order, startScope, originalIsCurrent);
            if (!accepted || accepted.status !== 'prepared' || !originalIsCurrent()) return;
            if (latest.current.ethereumSession?.token === ethereumSession.token) {
              if (cause.status === 401) latest.current.onEthereumSessionInvalid?.();
              setError(cause.message);
            }
            return;
          }
          if (recovered.order) { await acceptPersistedOrder(recovered.order, startScope, originalIsCurrent); return; }
        } catch {}
      }
      const saved = readPending(startScope);
      if (saved && !samePending(saved, pendingRef.current)) {
        adoptPending(saved);
        setRecoveryRevision((value) => value + 1);
        return;
      }
      if (!preparedOrder && !attemptedSubmit && cause instanceof ProfileApiError && cause.status && cause.status >= 400 && cause.status < 500 && !cause.retrySameOperation) {
        keepPending(null, startScope);
        void refreshAvailability();
        if (cause.status === 409) {
          setRecoveryReady(false);
          setRecoveryRevision((value) => value + 1);
        }
      }
      if (!operation.isCurrent()) return;
      let cancelled = false;
      if (preparedOrder && !attemptedSubmit) {
        try {
          const result = await api.cancel({ preorderId: config.preorderId, orderId: preparedOrder.orderId });
          if (!operation.isCurrent()) return;
          if (result.order && !await acceptPersistedOrder(result.order, startScope, operation.isCurrent)) return;
          cancelled = result.order?.status === 'cancelled';
        } catch {}
      }
      if (!operation.isCurrent()) return;
      setError(cancelled && isUserRejectedError(cause) ? null
        : attemptedSubmit ? 'Your preorder may have been submitted. We’re checking its status; don’t pay again.'
        : cause instanceof Error ? cause.message : 'Couldn’t prepare your preorder. Try again.');
    } finally {
      operation.finish();
    }
  };

  const cancel = async () => {
    const unresolved = pendingRef.current && !pendingRef.current.orderId && !pendingRef.current.submittedAttempt && !activeOrder(order)
      ? pendingRef.current : null;
    if (!config.enabled || checkoutScope !== scopeId || !scope || phaseRef.current !== 'idle' ||
      (!unresolved && order?.status !== 'prepared')) return;
    const startScope = scope;
    const operation = beginOperation(startScope, 'cancelling');
    setError(null);
    try {
      const result = unresolved ? await runPreorderStatus(() => api.recoveries ? api.recoveries(config.preorderId) : api.status(config.preorderId))
        : await api.cancel({ preorderId: config.preorderId, orderId: order!.orderId });
      if (!operation.isCurrent()) return;
      for (const recovered of (result as { recoveries?: PreorderOrder[] }).recoveries ?? []) {
        if (recovered.buyer !== buyer || recovered.preorderId !== config.preorderId) throw new Error('Preorder wallet does not match.');
        await upsertPreorderRecovery(recovered);
        if (!operation.isCurrent()) return;
      }
      if (unresolved) {
        const stored = readPending(startScope);
        if (stored && !samePending(stored, unresolved)) {
          adoptPending(stored);
          setRecoveryRevision(value => value + 1);
          return;
        }
        if (result.order && (result.order.buyer !== buyer || result.order.preorderId !== config.preorderId)) {
          throw new Error('Preorder does not match this wallet or collection.');
        }
        keepPending(null, startScope);
        setOrder(null);
        setRecoveryReady(true);
        void refreshAvailability();
      }
      if (result.order) await acceptPersistedOrder(result.order, startScope, operation.isCurrent);
    } catch {
      if (operation.isCurrent()) setError('Couldn’t cancel yet. We’ll keep checking your preorder.');
    } finally {
      operation.finish();
    }
  };

  const currentCheckout = config.enabled && checkoutScope === scopeId;
  const displayedAvailability = useMemo(() => {
    if (!availability) return null;
    const confirmedIds = new Set(recoveryRecords.flatMap(({ order: recovered }) =>
      recovered.preorderId === config.preorderId && recovered.ethereumAddress === availability.ethereumAddress &&
      (recovered.status === 'submitted' || recovered.status === 'succeeded') ? recovered.cardIds : []));
    if (!availability.items.some(item => confirmedIds.has(item.id) && item.status !== 'preordered')) return availability;
    return { ...availability, items: availability.items.map(item => confirmedIds.has(item.id) ? { ...item, status: 'preordered' as const } : item) };
  }, [availability, config.preorderId, recoveryRecords]);
  return {
    config, buyer, authenticatedBuyer: options.authenticatedBuyer,
    ethereumAddress: options.ethereumSession?.address ?? null, availability: displayedAvailability, availabilityError, refreshAvailability,
    order: currentCheckout ? order : null,
    pending: currentCheckout ? pending : null,
    phase: currentCheckout ? phase : 'idle' as const,
    error: currentCheckout ? error : null,
    purchase, cancel,
    busy: currentCheckout && phase !== 'idle',
    pendingOrder: currentCheckout && activeOrder(order),
    recoveryReady: !config.enabled || !buyer || !signedIn || (currentCheckout && recoveryReady),
  };
}

export type PreorderCheckout = ReturnType<typeof usePreorderCheckout>;
