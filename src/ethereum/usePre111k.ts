import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Pre111kNetwork } from '../../shared/ethereum/pre111k';
import { useMiNoteEthereumWallet } from '../hooks/useMiNoteEthereumWallet';
import { checkedPre111kReservation, pre111kApi } from './pre111kApi';
import { ethereumOperation, ethereumWalletError } from './wallet';
import { EthereumApiError } from './api';

type Attempt = {
  scope: string;
  nonce: number | null;
  controller: AbortController;
  operation?: ReturnType<typeof ethereumOperation>;
};
const STORAGE_PREFIX = 'mons.shop.pre111k.last-transaction:';
const LEGACY_STORAGE_PREFIX = 'mons.shop.pre111k.pending:';
const STORAGE_EVENT = 'mons:pre111k-transaction';
const memory = new WeakMap<Window, Map<string, string>>();

function transactionHash(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function readTransaction(scope: string | null): string | null {
  if (!scope) return null;
  const cached = memory.get(window)?.get(scope);
  if (cached) return cached;
  try { return transactionHash(window.localStorage.getItem(`${STORAGE_PREFIX}${scope}`)); }
  catch { return null; }
}

function writeTransaction(scope: string, hash: string): boolean {
  let saved = memory.get(window);
  if (!saved) { saved = new Map(); memory.set(window, saved); }
  let persisted = false;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${scope}`, hash);
    saved.delete(scope);
    persisted = true;
  } catch { saved.set(scope, hash); }
  window.dispatchEvent(new window.Event(STORAGE_EVENT));
  return persisted;
}

function migrateTransaction(scope: string) {
  try {
    const legacy = window.localStorage.getItem(`${LEGACY_STORAGE_PREFIX}${scope}`);
    if (legacy === null) return;
    let hash: string | null = null;
    try {
      const value: unknown = JSON.parse(legacy);
      if (value && typeof value === 'object' && 'hash' in value) hash = transactionHash(value.hash);
    } catch {}
    const reference = readTransaction(scope) ?? hash;
    if (reference && transactionHash(window.localStorage.getItem(`${STORAGE_PREFIX}${scope}`)) !== reference &&
      !writeTransaction(scope, reference)) return;
    window.localStorage.removeItem(`${LEGACY_STORAGE_PREFIX}${scope}`);
  } catch {}
}

function subscribeTransaction(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null) memory.get(window)?.clear();
    else if (event.key.startsWith(STORAGE_PREFIX)) memory.get(window)?.delete(event.key.slice(STORAGE_PREFIX.length));
    listener();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(STORAGE_EVENT, listener);
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(STORAGE_EVENT, listener); };
}

export function usePre111k(network: Pre111kNetwork, accessCode: string | null, onAccessRejected: (code: string) => void) {
  const wallet = useMiNoteEthereumWallet(true);
  const latestWallet = useRef(wallet);
  latestWallet.current = wallet;
  const latestAccess = useRef({ code: accessCode, reject: onAccessRejected });
  latestAccess.current = { code: accessCode, reject: onAccessRejected };
  const mounted = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const latestAttempt = useRef<Attempt | null>(null);
  const queryClient = useQueryClient();
  const queryKey = ['pre111k', network, wallet.address] as const;
  const approved = Boolean(accessCode);
  const previouslyApproved = useRef(approved);
  const statusQuery = useQuery({ queryKey, queryFn: ({ signal }) => pre111kApi.status(network, wallet.address, signal),
    refetchInterval: approved ? wallet.address ? 3_000 : 10_000 : false,
    refetchOnWindowFocus: approved, refetchOnReconnect: approved,
    staleTime: 5_000, retry: approved ? 1 : false });
  const status = statusQuery.data;
  const config = status?.config;
  const scope = config?.contractAddress && wallet.address ? `${config.chainId}:${config.contractAddress}:${wallet.address}` : null;
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const hash = useSyncExternalStore(subscribeTransaction, useCallback(() => readTransaction(scope), [scope]), () => null);
  const [inFlight, setInFlight] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);

  const finish = useCallback((current: Attempt) => {
    if (attempt.current !== current) return;
    attempt.current = null;
    current.controller.abort();
    current.operation?.dispose();
    if (mounted.current) { setInFlight(false); setStage(null); }
  }, []);

  useEffect(() => { if (scope) migrateTransaction(scope); }, [scope]);

  useEffect(() => {
    const opened = approved && !previouslyApproved.current;
    previouslyApproved.current = approved;
    if (opened && statusQuery.isStale) void statusQuery.refetch();
  }, [approved, statusQuery.isStale, statusQuery.refetch]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      latestAttempt.current = null;
      if (attempt.current) finish(attempt.current);
    };
  }, [finish]);

  useEffect(() => {
    setError(null);
    return () => {
      latestAttempt.current = null;
      if (attempt.current) finish(attempt.current);
    };
  }, [network, scope, wallet.address, wallet.provider, accessCode, finish]);

  useEffect(() => {
    const current = attempt.current;
    if (!current || current.scope !== scope || current.nonce === null || !statusQuery.isSuccess || statusQuery.isStale ||
      status?.wallet !== wallet.address || status.reservedRelics === null || status.reservedRelics <= current.nonce) return;
    finish(current);
  }, [scope, status, statusQuery.isSuccess, statusQuery.isStale, wallet.address, stage, finish]);

  const reserve = async () => {
    if (!mounted.current || !accessCode || attempt.current || !scope || !config?.enabled || !wallet.address || !wallet.provider ||
      !wallet.ready || wallet.status !== 'connected') return;
    const savedWallet = wallet.address;
    const savedProvider = wallet.provider;
    const current: Attempt = { scope, nonce: null, controller: new AbortController() };
    attempt.current = current;
    latestAttempt.current = current;
    setInFlight(true);
    setError(null);
    setStage('Preparing reservation…');
    const isLatest = () => mounted.current && latestAttempt.current === current &&
      latestScope.current === current.scope && latestWallet.current.address === savedWallet &&
      latestWallet.current.provider === savedProvider && latestAccess.current.code === accessCode;
    const isCurrent = () => isLatest() && attempt.current === current && !current.controller.signal.aborted;
    try {
      const operation = ethereumOperation(() => isCurrent() ? latestWallet.current : { address: null, provider: null }, config);
      current.operation = operation;
      operation.signal.addEventListener('abort', () => finish(current), { once: true, signal: current.controller.signal });
      const assertCurrent = () => {
        current.controller.signal.throwIfAborted();
        operation.assertCurrent();
        if (!isCurrent()) throw new Error('Your reservation request changed. Please try again.');
      };
      const signal = AbortSignal.any([current.controller.signal, operation.signal]);
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
      const transactionHash = await operation.send(transaction, () => {
        assertCurrent();
        checkedPre111kReservation(prepared, fresh.config, savedWallet, fresh.reservedRelics!);
        current.nonce = prepared.nonce;
        setStage('Confirm in your wallet…');
      });
      if (!isLatest()) return;
      writeTransaction(current.scope, transactionHash);
      void queryClient.invalidateQueries({ queryKey: ['pre111k', network] });
    } catch (cause) {
      if (!isCurrent()) return;
      if (cause instanceof EthereumApiError && cause.code === 'unauthenticated') latestAccess.current.reject(accessCode);
      else setError({ scope: current.scope, message: ethereumWalletError(cause) });
    } finally {
      finish(current);
    }
  };

  return { wallet, status, statusQuery, inFlight, stage, reserve, transactionHash: hash,
    error: wallet.error || (error?.scope === scope ? error.message : null) };
}
