import { useMemo, useSyncExternalStore } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ETHEREUM_CHECKOUT_ID, normalizeCheckoutTokenIds, type EthereumCheckoutStatusResponse } from '../../shared/ethereum/checkout';
import { normalizeEthereumAddress, type EthereumInventoryItem } from '../../shared/ethereum/protocol';
import { checkoutApi } from '../checkout/api';

const STORAGE_PREFIX = 'mons.shop.ethereum-checkout-reservation:';
const CHANGED_EVENT = 'mons:ethereum-checkout-reservations';
const MAX_RESERVATIONS = 128;
const fallbacks = new WeakMap<Window, Map<string, string | null>>();

type CheckoutReservation = {
  checkoutId: string; chainId: number; contractAddress: string; wallet: string; tokenIds: string[]; attemptId: string | null;
  revision: string | null;
};
type StoredCheckoutReservation = CheckoutReservation & { key: string };
type ReservationSnapshot = { rows: StoredCheckoutReservation[]; stable: boolean };
const EMPTY_SNAPSHOT = '{"values":[],"stable":true}';

function reservationIdentity(row: Pick<CheckoutReservation, 'checkoutId' | 'attemptId'>): string {
  return `${row.checkoutId}:${row.attemptId ?? 'unknown'}`;
}

function snapshot(): string {
  if (typeof window === 'undefined') return EMPTY_SNAPSHOT;
  const values = new Map<string, string>();
  let stable = true;
  try {
    const storage = window.localStorage;
    const keys = () => Reflect.ownKeys(storage).filter((key): key is string =>
      typeof key === 'string' && key.startsWith(STORAGE_PREFIX)).sort();
    for (let attempt = 0; attempt < 3; attempt++) {
      stable = false;
      const before = keys();
      values.clear();
      for (const key of before) {
        const value = storage.getItem(key);
        if (value !== null) values.set(key, value);
      }
      const after = keys();
      stable = values.size === before.length && before.length === after.length &&
        before.every((key, index) => key === after[index]);
      if (stable) break;
    }
  } catch {}
  for (const [key, value] of fallbacks.get(window) ?? []) {
    if (value === null) values.delete(key);
    else values.set(key, value);
  }
  return JSON.stringify({ values: [...values].sort(([left], [right]) => left.localeCompare(right)), stable });
}

function parseReservations(value: string): ReservationSnapshot {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed.values)) return { rows: [], stable: false };
    const rows: StoredCheckoutReservation[] = parsed.values.flatMap((entry: unknown) => {
      try {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') return [];
        const [key, value] = entry;
        const row = JSON.parse(value);
        if (!row || typeof row !== 'object' || !ETHEREUM_CHECKOUT_ID.test(row.checkoutId) ||
          !Number.isSafeInteger(row.chainId) || row.chainId < 1 || typeof row.contractAddress !== 'string' ||
          normalizeEthereumAddress(row.contractAddress) !== row.contractAddress || typeof row.wallet !== 'string' ||
          normalizeEthereumAddress(row.wallet) !== row.wallet || row.attemptId !== null && !ETHEREUM_CHECKOUT_ID.test(row.attemptId)) return [];
        const tokenIds = normalizeCheckoutTokenIds(row.tokenIds);
        const revision = typeof row.revision === 'string' && ETHEREUM_CHECKOUT_ID.test(row.revision) ? row.revision : null;
        const legacyKey = `${STORAGE_PREFIX}${reservationIdentity(row)}`;
        if (key !== legacyKey && (!revision || key !== `${legacyKey}:${revision}`)) return [];
        return [{ checkoutId: row.checkoutId, chainId: row.chainId, contractAddress: row.contractAddress,
          wallet: row.wallet, tokenIds, attemptId: row.attemptId, revision, key }];
      } catch { return []; }
    });
    return { rows, stable: parsed.stable === true };
  } catch { return { rows: [], stable: false }; }
}

function writeReservation(stored: StoredCheckoutReservation, remove = false): boolean {
  if (typeof window === 'undefined') return false;
  const { key, ...row } = stored;
  const value = remove ? null : JSON.stringify(row);
  let persisted = false;
  try {
    const unchanged = window.localStorage.getItem(key) === value;
    if (!unchanged) {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
      if (window.localStorage.getItem(key) !== value) throw new Error('Storage unavailable');
    }
    const removedFallback = fallbacks.get(window)?.delete(key);
    if (unchanged && !removedFallback) return true;
    persisted = true;
  } catch {
    let fallback = fallbacks.get(window);
    if (!fallback) fallbacks.set(window, fallback = new Map());
    if (fallback.has(key) && fallback.get(key) === value) return false;
    if (value !== null) {
      const identityKey = `${STORAGE_PREFIX}${reservationIdentity(row)}`;
      for (const [previousKey, previousValue] of fallback) {
        if (previousKey !== key && previousValue !== null &&
          (previousKey === identityKey || previousKey.startsWith(`${identityKey}:`))) fallback.delete(previousKey);
      }
    }
    fallback.set(key, value);
  }
  window.dispatchEvent(new window.Event(CHANGED_EVENT));
  return persisted;
}

function subscribe(listener: () => void): () => void {
  const changed = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) listener(); };
  window.addEventListener(CHANGED_EVENT, listener);
  window.addEventListener('storage', changed);
  return () => { window.removeEventListener(CHANGED_EVENT, listener); window.removeEventListener('storage', changed); };
}

function rememberReservation(checkout: EthereumCheckoutStatusResponse, fresh: boolean): { row: StoredCheckoutReservation; persisted: boolean } | null {
  if (!['submitting', 'pending'].includes(checkout.status) || !checkout.wallet) return null;
  const { rows, stable } = parseReservations(snapshot());
  if (!stable) return null;
  const attemptId = checkout.attempt?.attemptId ?? null;
  const matching = rows.filter(row => row.checkoutId === checkout.checkoutId && row.attemptId === attemptId);
  const existing = matching.find(row => !fallbacks.get(window)?.has(row.key)) ?? matching[0];
  if (!existing && new Set(rows.map(reservationIdentity)).size >= MAX_RESERVATIONS) return null;
  if (existing && !fresh) return { row: existing, persisted: !fallbacks.get(window)?.has(existing.key) };
  const row: CheckoutReservation = { checkoutId: checkout.checkoutId, chainId: checkout.chainId,
    contractAddress: checkout.contractAddress, wallet: checkout.wallet, tokenIds: checkout.tokenIds,
    attemptId, revision: crypto.randomUUID() };
  const stored = { ...row, key: `${STORAGE_PREFIX}${reservationIdentity(row)}:${row.revision}` };
  return { row: stored, persisted: writeReservation(stored) };
}

export function rememberCheckoutReservation(checkout: EthereumCheckoutStatusResponse, fresh = false): boolean {
  return rememberReservation(checkout, fresh) !== null;
}

export function persistCheckoutReservation(checkout: EthereumCheckoutStatusResponse): boolean {
  const remembered = rememberReservation(checkout, false);
  return remembered !== null && writeReservation(remembered.row);
}

export function observeCheckoutReservation(checkoutId: string): (checkout: EthereumCheckoutStatusResponse) => void {
  const observed = parseReservations(snapshot()).rows.filter(row => row.checkoutId === checkoutId);
  const observedKeys = new Set(observed.map(row => row.key));
  return checkout => {
    if (checkout.checkoutId !== checkoutId) return;
    const pending = ['submitting', 'pending'].includes(checkout.status);
    const remembered = pending ? rememberReservation(checkout, true) : null;
    const newerFallback = !pending && observed.length > 0 && parseReservations(snapshot()).rows.some(row =>
      row.checkoutId === checkoutId && !observedKeys.has(row.key) && fallbacks.get(window)?.has(row.key));
    for (const existing of observed) {
      if (pending) {
        if (remembered?.persisted) writeReservation(existing, true);
      } else if (!newerFallback && (checkout.status === 'success' || checkout.status === 'failed' ||
        checkout.attempt?.status === 'rejected')) {
        writeReservation(existing, true);
      }
    }
  };
}

export function checkoutReservesItems(items: readonly EthereumInventoryItem[]): boolean {
  const { rows, stable } = parseReservations(snapshot());
  return !stable || items.some(item => rows.some(row => row.wallet === item.owner && row.chainId === item.chainId &&
    row.contractAddress === item.contractAddress && row.tokenIds.includes(item.tokenId)));
}

export function useCheckoutReservations(wallet: string | null, chainId: number, contractAddress: string | null): string {
  const stored = useSyncExternalStore(subscribe, snapshot, () => EMPTY_SNAPSHOT);
  const rows = useMemo(() => [...new Map(parseReservations(stored).rows.filter(row => row.wallet === wallet &&
    row.chainId === chainId && row.contractAddress === contractAddress).map(row => [reservationIdentity(row), row])).values()],
  [stored, wallet, chainId, contractAddress]);
  useQueries({ queries: rows.map(row => ({
    queryKey: ['ethereumCheckoutReservation', row.checkoutId, row.attemptId],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const observe = observeCheckoutReservation(row.checkoutId);
      const checkout = await checkoutApi.status(row.checkoutId, signal);
      observe(checkout);
      return checkout;
    },
    retry: false, refetchInterval: 30_000,
  })) });
  return stored;
}
