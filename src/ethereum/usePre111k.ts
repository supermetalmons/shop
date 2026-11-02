import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Pre111kNetwork } from '../../shared/ethereum/pre111k';
import { useMiNoteEthereumWallet } from '../hooks/useMiNoteEthereumWallet';
import { checkedPre111kReservation, pre111kApi } from './pre111kApi';
import { ethereumOperation, ethereumWalletError } from './wallet';
import { EthereumApiError } from './api';

type Pending = { hash: string | null; nonce: number; submittedAt: number };
const STORAGE_PREFIX = 'mons.shop.pre111k.pending:';
const STORAGE_EVENT = 'mons:pre111k-pending';
const memory = new WeakMap<Window, Map<string, string | null>>();
const flightListeners = new Set<() => void>();
let submissionInFlight = false;

function setInFlight(value: boolean) {
  submissionInFlight = value;
  for (const listener of flightListeners) listener();
}

function subscribeFlight(listener: () => void) {
  flightListeners.add(listener);
  return () => { flightListeners.delete(listener); };
}

function readPending(scope: string | null): string | null {
  if (!scope) return null;
  const fallback = memory.get(window);
  if (fallback?.has(scope)) return fallback.get(scope) ?? null;
  try { return window.localStorage.getItem(`${STORAGE_PREFIX}${scope}`); }
  catch { return null; }
}

function writePending(scope: string, pending: Pending | null) {
  const value = pending ? JSON.stringify(pending) : null;
  let saved = memory.get(window);
  if (!saved) { saved = new Map(); memory.set(window, saved); }
  try {
    if (value) window.localStorage.setItem(`${STORAGE_PREFIX}${scope}`, value);
    else window.localStorage.removeItem(`${STORAGE_PREFIX}${scope}`);
    saved.delete(scope);
  } catch { saved.set(scope, value); }
  window.dispatchEvent(new window.Event(STORAGE_EVENT));
}

function subscribePending(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener(STORAGE_EVENT, listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener(STORAGE_EVENT, listener); };
}

function parsePending(value: string | null): Pending | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Pending;
    if (parsed && (parsed.hash === null || /^0x[0-9a-f]{64}$/.test(parsed.hash)) && Number.isSafeInteger(parsed.nonce) &&
      parsed.nonce >= 0 && parsed.nonce < 18 && Number.isSafeInteger(parsed.submittedAt) && parsed.submittedAt > 0) return parsed;
  } catch {}
  return null;
}

export function usePre111k(network: Pre111kNetwork, accessCode: string | null, onAccessRejected: (code: string) => void) {
  const wallet = useMiNoteEthereumWallet(true);
  const latestWallet = useRef(wallet);
  latestWallet.current = wallet;
  const latestAccess = useRef({ code: accessCode, reject: onAccessRejected });
  latestAccess.current = { code: accessCode, reject: onAccessRejected };
  const mounted = useRef(false);
  const attempt = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();
  const queryKey = ['pre111k', network, wallet.address] as const;
  const statusQuery = useQuery({ queryKey, queryFn: ({ signal }) => pre111kApi.status(network, wallet.address, signal),
    refetchInterval: 10_000, staleTime: 5_000, retry: 1 });
  const status = statusQuery.data;
  const config = status?.config;
  const scope = config?.contractAddress && wallet.address ? `${config.chainId}:${config.contractAddress}:${wallet.address}` : null;
  const pendingRaw = useSyncExternalStore(subscribePending, useCallback(() => readPending(scope), [scope]), () => null);
  const pending = useMemo(() => parsePending(pendingRaw), [pendingRaw]);
  const inFlight = useSyncExternalStore(subscribeFlight, () => submissionInFlight, () => false);
  const [stage, setStage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ scope: string | null; error: boolean; message: string } | null>(null);
  const feedbackForScope = feedback?.scope === scope ? feedback : null;
  const [confirmationRetry, setConfirmationRetry] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; attempt.current?.abort(); };
  }, []);

  useEffect(() => {
    attempt.current?.abort();
    setStage(null);
  }, [network, wallet.address, wallet.provider, accessCode]);

  useEffect(() => {
    if (!pending?.hash || !scope || !wallet.address) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await pre111kApi.confirm(network, wallet.address!, pending.hash!, controller.signal);
        if (controller.signal.aborted) return;
        if (result.status === 'confirmed') {
          if (result.reservationNonce !== pending.nonce) throw new Error('This transaction does not match your saved reservation. Check the transaction hash.');
          await queryClient.invalidateQueries({ queryKey: ['pre111k', network] });
          if (controller.signal.aborted) return;
          writePending(scope, null);
          setFeedback({ scope, error: false, message: 'Relic reserved.' });
          return;
        }
        if (result.status === 'failed') {
          if (result.reservationNonce !== pending.nonce) throw new Error('This transaction does not match your saved reservation. Check the transaction hash.');
          writePending(scope, null);
          setFeedback({ scope, error: true, message: 'The reservation did not complete. No relic was reserved by this transaction.' });
          void queryClient.invalidateQueries({ queryKey: ['pre111k', network] });
          return;
        }
        setFeedback(current => current?.scope === scope && current.error ? null : current);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFeedback({ scope, error: true, message: ethereumWalletError(error) });
      }
      timer = setTimeout(() => { void refresh(); }, 3_000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [network, pending, queryClient, scope, wallet.address, confirmationRetry]);

  const reserve = async () => {
    if (!mounted.current || !accessCode || submissionInFlight || pending || !scope || !config?.enabled || !wallet.address || !wallet.provider ||
      !wallet.ready || wallet.status !== 'connected') return;
    const savedScope = scope;
    const savedWallet = wallet.address;
    const controller = new AbortController();
    attempt.current = controller;
    setInFlight(true);
    setFeedback(null);
    setStage('Preparing reservation…');
    let operation: ReturnType<typeof ethereumOperation> | undefined;
    let submitted = false;
    try {
      operation = ethereumOperation(() => mounted.current ? latestWallet.current : { address: null, provider: null }, config);
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        operation!.assertCurrent();
        if (latestAccess.current.code !== accessCode) throw new Error('Enter your secret code to continue.');
      };
      const signal = AbortSignal.any([controller.signal, operation.signal]);
      const fresh = await pre111kApi.status(network, savedWallet, signal);
      assertCurrent();
      if (!fresh.config.enabled || fresh.config.contractAddress !== config.contractAddress || fresh.config.chainId !== config.chainId ||
        fresh.config.priceWei !== config.priceWei || fresh.reservedRelics === null || fresh.remainingRelics === null) {
        throw new Error('Reservations are unavailable. Please refresh and try again.');
      }
      queryClient.setQueryData(queryKey, fresh);
      if (fresh.remainingRelics === 0) throw new Error('All 18 relics have been reserved.');
      const prepared = await pre111kApi.prepare(network, savedWallet, accessCode, signal);
      assertCurrent();
      const transaction = checkedPre111kReservation(prepared, fresh.config, savedWallet, fresh.reservedRelics);
      setStage('Confirm in your wallet…');
      const hash = await operation.send(transaction, () => {
        assertCurrent();
        checkedPre111kReservation(prepared, fresh.config, savedWallet, fresh.reservedRelics!);
        submitted = true;
        writePending(savedScope, { hash: null, nonce: prepared.nonce, submittedAt: Date.now() });
      });
      writePending(savedScope, { hash, nonce: prepared.nonce, submittedAt: Date.now() });
    } catch (error) {
      if (!submitted && error instanceof EthereumApiError && error.code === 'unauthenticated') {
        latestAccess.current.reject(accessCode);
      }
      const rejected = error && typeof error === 'object' && 'code' in error && error.code === 4001;
      if (submitted && rejected) writePending(savedScope, null);
      if (mounted.current && latestWallet.current.address === savedWallet) {
        setFeedback({ scope: savedScope, error: true, message: submitted && !rejected
          ? 'Check your wallet for the reservation transaction, then enter its hash below to track it.' : ethereumWalletError(error) });
      }
    } finally {
      operation?.dispose();
      if (attempt.current === controller) attempt.current = null;
      if (mounted.current) setStage(null);
      setInFlight(false);
    }
  };

  const track = (hash: string) => {
    if (!scope || !pending || inFlight) return;
    const normalized = hash.trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
      setFeedback({ scope, error: true, message: 'Enter the transaction hash from your wallet.' });
      return;
    }
    writePending(scope, { ...pending, hash: normalized });
    setFeedback(null);
    setConfirmationRetry(value => value + 1);
  };

  const stopTracking = () => {
    if (!scope || inFlight) return;
    writePending(scope, null);
    setFeedback(null);
    void statusQuery.refetch();
  };

  return { wallet, status, statusQuery, pending, inFlight, stage, reserve, track, stopTracking,
    error: wallet.error || (feedbackForScope?.error ? feedbackForScope.message : null),
    message: feedbackForScope && !feedbackForScope.error ? feedbackForScope.message : null };
}
