import { VersionedTransaction } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreorderAvailabilityResponse, PreorderConfig, PreorderOrder } from '../../shared/preorders.ts';
import { createPreorderApi } from '../lib/preorderApi';
import { ProfileApiError } from '../api/transport';
import { isUserRejectedError } from '../shop/commerce/transactionSupport';

const preorderApi = createPreorderApi();
const RECOVERY_ERROR_MESSAGE = 'Couldn’t check your preorder. We’ll keep checking.';
const RECOVERY_CONFLICT_MESSAGE = 'Another preorder is active. Continue to resolve it.';

type PendingPreorder = { requestId: string | null; cardIds: number[]; orderId?: string; submittedAttempt?: boolean };
type CheckoutPhase = 'idle' | 'authenticating' | 'preparing' | 'signing' | 'submitting' | 'cancelling';
type CheckoutOptions = {
  config: PreorderConfig;
  active: boolean;
  buyer: string | undefined;
  signedIn: boolean;
  signTransaction: ((transaction: VersionedTransaction) => Promise<VersionedTransaction>) | undefined;
  ensureSignedIn: () => Promise<boolean>;
  onSucceeded: (order: PreorderOrder) => void;
};

function activeOrder(order: PreorderOrder | null): boolean {
  return order?.status === 'prepared' || order?.status === 'submitted';
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
    left.orderId === right.orderId && Boolean(left.submittedAttempt) === Boolean(right.submittedAttempt) &&
    left.cardIds.length === right.cardIds.length && left.cardIds.every((id, index) => id === right.cardIds[index]));
}

export function usePreorderCheckout(options: CheckoutOptions, api = preorderApi) {
  const { config, active, buyer, signedIn } = options;
  const scope = buyer ? storageKey(config, buyer) : '';
  const latest = useRef(options);
  latest.current = options;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [availability, setAvailability] = useState<PreorderAvailabilityResponse | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [order, setOrder] = useState<PreorderOrder | null>(null);
  const [pending, setPending] = useState<PendingPreorder | null>(null);
  const pendingRef = useRef<PendingPreorder | null>(null);
  const [phase, setPhase] = useState<CheckoutPhase>('idle');
  const phaseRef = useRef<CheckoutPhase>('idle');
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const recoveryGeneration = useRef(0);
  const activeOperation = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completed = useRef(new Set<string>());
  const [now, setNow] = useState(Date.now);
  const availabilityRequest = useRef(0);
  const availabilityInFlight = useRef<string | null>(null);

  const refreshAvailability = useCallback(async () => {
    if (!config.enabled || availabilityInFlight.current === config.preorderId) return;
    availabilityInFlight.current = config.preorderId;
    const request = ++availabilityRequest.current;
    try {
      const result = await api.availability(config.preorderId);
      if (request !== availabilityRequest.current || latest.current.config.preorderId !== config.preorderId) return;
      setAvailability(result);
      setAvailabilityError(null);
    } catch {
      if (request !== availabilityRequest.current || latest.current.config.preorderId !== config.preorderId) return;
      setAvailabilityError('Couldn’t check card availability. Try again.');
    } finally {
      if (availabilityInFlight.current === config.preorderId) availabilityInFlight.current = null;
    }
  }, [api, config]);

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

  const acceptOrder = useCallback((next: PreorderOrder, key: string) => {
    if (currentScope.current !== key || next.buyer !== latest.current.buyer || next.preorderId !== config.preorderId) return false;
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
        setRecoveryRevision((value) => value + 1);
      }
      return false;
    }
    setOrder(next);
    if (activeOrder(next)) {
      const saved = matches(stored) ? stored : null;
      const previous = matches(pendingRef.current) ? pendingRef.current : null;
      keepPending({ requestId: saved?.requestId ?? previous?.requestId ?? null, cardIds: next.cardIds, orderId: next.orderId,
        ...(saved?.submittedAttempt || previous?.submittedAttempt ? { submittedAttempt: true } : {}),
      }, key);
    } else {
      keepPending(null, key);
      setError(next.status === 'failed' ? 'The preorder transaction failed. Select cards to try again.'
        : next.status === 'expired' ? 'Your preorder expired. Select cards to try again.' : null);
      void refreshAvailability();
      if (next.status === 'succeeded' && !completed.current.has(next.orderId)) {
        completed.current.add(next.orderId);
        latest.current.onSucceeded(next);
      }
    }
    return true;
  }, [adoptPending, config.preorderId, keepPending, refreshAvailability]);

  useEffect(() => {
    if (!active || !config.enabled) return;
    const focus = () => { if (document.visibilityState !== 'hidden') void refreshAvailability(); };
    focus();
    const interval = setInterval(focus, 10_000);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      availabilityRequest.current += 1;
      clearInterval(interval);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [active, config.enabled, refreshAvailability]);

  useEffect(() => {
    recoveryGeneration.current += 1;
    activeOperation.current = null;
    setOrder(null);
    setError(null);
    setPhase('idle');
    phaseRef.current = 'idle';
    setRecoveryReady(false);
    const saved = scope ? readPending(scope) : null;
    pendingRef.current = saved;
    setPending(saved);
    return () => { activeOperation.current = null; };
  }, [scope]);

  useEffect(() => {
    if (!buyer || !signedIn || !config.enabled || (!active && !readPending(scope))) return;
    let stopped = false;
    let checking = false;
    let lookedUp = false;
    const recover = async () => {
      if (checking || phaseRef.current !== 'idle' || document.visibilityState === 'hidden') return;
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
        const result = await api.status(config.preorderId, recoveringPending?.orderId);
        if (!isCurrent()) return;
        if (result.order && result.order.buyer !== buyer) throw new Error('Preorder wallet does not match.');
        if (result.order && !acceptOrder(result.order, scope)) return;
        setError((current) => current === RECOVERY_ERROR_MESSAGE || current === RECOVERY_CONFLICT_MESSAGE ? null : current);
        lookedUp = true;
        setRecoveryReady(true);
      } catch {
        if (isCurrent()) setError(RECOVERY_ERROR_MESSAGE);
      } finally {
        checking = false;
      }
    };
    void recover();
    const interval = setInterval(() => { void recover(); }, 3_000);
    const focus = () => { void recover(); };
    const storage = (event: StorageEvent) => {
      if (event.key !== scope || currentScope.current !== scope) return;
      const saved = readPending(scope);
      recoveryGeneration.current += 1;
      const next = saved ?? (pendingRef.current?.orderId ? pendingRef.current : null);
      pendingRef.current = next;
      setPending(next);
      lookedUp = false;
      void recover();
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
  }, [acceptOrder, active, adoptPending, api, buyer, config.enabled, config.preorderId, recoveryRevision, scope, signedIn]);

  useEffect(() => {
    if (!activeOrder(order)) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [order]);

  const beginOperation = (key: string, initialPhase: CheckoutPhase) => {
    const generation = ++recoveryGeneration.current;
    activeOperation.current = generation;
    const isCurrent = () => currentScope.current === key && activeOperation.current === generation &&
      recoveryGeneration.current === generation;
    const setCurrentPhase = (value: CheckoutPhase) => {
      if (!isCurrent()) return;
      phaseRef.current = value;
      setPhase(value);
    };
    setCurrentPhase(initialPhase);
    return { isCurrent, setCurrentPhase, finish: () => {
      if (currentScope.current !== key || activeOperation.current !== generation) return;
      activeOperation.current = null;
      phaseRef.current = 'idle';
      setPhase('idle');
    } };
  };

  const purchase = async (selectedIds: number[]) => {
    if (!latest.current.active || !config.enabled || phaseRef.current !== 'idle' || order?.status === 'submitted' || pendingRef.current?.submittedAttempt) return;
    const startScope = scope;
    const operation = beginOperation(startScope, 'authenticating');
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
      keepPending({ requestId, cardIds, ...(previous?.orderId ? { orderId: previous.orderId } : {}) }, startScope);
      operation.setCurrentPhase('preparing');
      const prepared = await api.prepare({ preorderId: config.preorderId, buyer, cardIds, requestId });
      if (!operation.isCurrent() || !latest.current.active) return;
      preparedOrder = prepared.order;
      if (!acceptOrder(prepared.order, startScope)) return;
      void refreshAvailability();
      if (prepared.order.status !== 'prepared') return;
      if (!prepared.transactionBase64) throw new Error('Your preorder is being checked. Try again shortly.');
      if (Date.now() >= prepared.order.expiresAtMs) throw new Error('This preorder expired. Waiting for availability to refresh.');
      operation.setCurrentPhase('signing');
      const transaction = VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.transactionBase64), (character) => character.charCodeAt(0)));
      const originalMessage = transaction.message.serialize();
      const signed = await signer(transaction);
      if (!operation.isCurrent() || !latest.current.active) return;
      if (!signed.message.serialize().every((value, index) => value === originalMessage[index]) || signed.message.serialize().length !== originalMessage.length) {
        throw new Error('The wallet changed the preorder transaction.');
      }
      if (Date.now() >= prepared.order.expiresAtMs) throw new Error('This preorder expired before signing finished.');
      operation.setCurrentPhase('submitting');
      attemptedSubmit = true;
      keepPending({ requestId, cardIds, orderId: prepared.order.orderId, submittedAttempt: true }, startScope);
      const result = await api.submit({
        preorderId: config.preorderId,
        orderId: prepared.order.orderId,
        transactionBase64: btoa(String.fromCharCode(...signed.serialize())),
      });
      if (!operation.isCurrent()) return;
      if (result.order) acceptOrder(result.order, startScope);
    } catch (cause) {
      if (!operation.isCurrent()) return;
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
      let cancelled = false;
      if (preparedOrder && !attemptedSubmit) {
        try {
          const result = await api.cancel({ preorderId: config.preorderId, orderId: preparedOrder.orderId });
          if (!operation.isCurrent()) return;
          if (result.order && !acceptOrder(result.order, startScope)) return;
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
    if (!scope || !order || order.status !== 'prepared' || phaseRef.current !== 'idle') return;
    const startScope = scope;
    const operation = beginOperation(startScope, 'cancelling');
    setError(null);
    try {
      const result = await api.cancel({ preorderId: config.preorderId, orderId: order.orderId });
      if (!operation.isCurrent()) return;
      if (result.order) acceptOrder(result.order, startScope);
    } catch {
      if (operation.isCurrent()) setError('Couldn’t cancel yet. We’ll keep checking your preorder.');
    } finally {
      operation.finish();
    }
  };

  return {
    config, buyer, availability, availabilityError, refreshAvailability, order, pending, phase, error,
    purchase, cancel,
    busy: phase !== 'idle',
    pendingOrder: activeOrder(order),
    recoveryReady: !buyer || !signedIn || recoveryReady,
    remainingSeconds: order ? Math.max(0, Math.ceil((order.expiresAtMs - now) / 1000)) : 0,
  };
}

export type PreorderCheckout = ReturnType<typeof usePreorderCheckout>;
