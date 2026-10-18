import type { Ethereum111kConfig, EthereumInventoryItem, EthereumSession } from '../../shared/ethereum/api';
import { ethereumAssetId, normalizeEthereumAddress, normalizeEthereumTokenId } from '../../shared/ethereum/protocol';
import type { InventoryItem } from '../types';

export type EthereumAction = 'mint' | 'unbox' | 'delivery' | 'claim' | 'transfer' | 'cancel';
export type EthereumPendingTransaction = {
  scope: string;
  hash: string;
  action: EthereumAction;
  submittedAt: number;
  orderId?: number;
  claimId?: string;
  nonce?: string;
  intent?: { to: string; data: string; value: string };
  actionBeforeCancellation?: Exclude<EthereumAction, 'cancel'>;
};
export type EthereumSubmission = Omit<EthereumPendingTransaction, 'hash'>;

export type EthereumInventoryView = InventoryItem & { ethereum: EthereumInventoryItem };

export function ethereumInventoryScope(config: Pick<Ethereum111kConfig, 'chainId' | 'contractAddress'>, address: string | null): string | null {
  const owner = normalizeEthereumAddress(address);
  return owner && config.contractAddress ? `${config.chainId}:${config.contractAddress.toLowerCase()}:${owner}` : null;
}

export function ethereumInventoryQueryKey(scope: string | null) { return ['ethereum111k', 'inventory', scope] as const; }

export function ethereumInventoryView(item: EthereumInventoryItem): EthereumInventoryView {
  return {
    id: ethereumAssetId(item.chainId, item.contractAddress, item.tokenId),
    dropId: '111k_devnet', name: item.name, image: item.image,
    kind: item.kind.endsWith('_receipt') ? 'certificate' : item.kind === 'artwork' ? 'dude' : 'box',
    ...(item.kind === 'artwork' || item.kind === 'artwork_receipt' ? { dudeId: item.displayId } : { boxId: String(item.displayId) }),
    attributes: item.attributes?.map(attribute => ({ trait_type: attribute.trait_type, value: String(attribute.value) })),
    ethereum: item,
  };
}

export function isEthereumInventoryView(item: InventoryItem): item is EthereumInventoryView { return 'ethereum' in item; }

export function toggleEthereumSelection(selected: ReadonlySet<string>, item: EthereumInventoryItem, items: ReadonlyMap<string, EthereumInventoryItem>, maximum: number): Set<string> {
  if (item.kind.endsWith('_receipt')) return new Set(selected);
  const next = new Set(selected);
  if (next.has(item.id)) { next.delete(item.id); return next; }
  if (item.kind === 'warehouse' || [...next].some(id => items.get(id)?.kind === 'warehouse')) return new Set([item.id]);
  if (next.size < maximum) next.add(item.id);
  return next;
}

const STORAGE_PREFIX = 'mons.ethereum111k:';
const STORAGE_CHANGED_EVENT = 'mons:ethereum111k-storage';
const storageFallbacks = new WeakMap<Window, Map<string, { value: unknown; baseline: string | null }>>();
const storageSnapshots = new WeakMap<Window, Map<string, string | null>>();
const activeOperations = new WeakMap<Window, Map<string, { label: string }>>();

export function readEthereumOperation(scope: string): string | null {
  return typeof window === 'undefined' ? null : activeOperations.get(window)?.get(scope)?.label ?? null;
}

export function subscribeEthereumOperation(scope: string, listener: () => void): () => void {
  const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === `${scope}:operation`) listener(); };
  window.addEventListener(STORAGE_CHANGED_EVENT, changed);
  return () => window.removeEventListener(STORAGE_CHANGED_EVENT, changed);
}

export async function withEthereumSubmissionLock<T>(scope: string, run: () => T): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (typeof locks?.request !== 'function') throw new Error('This browser cannot safely coordinate wallet transactions. Update your browser and try again.');
  return locks.request(`mons:ethereum111k-submission:${scope}`, {}, run);
}

export async function runEthereumOperation<T>(scope: string, label: string, run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (typeof locks?.request !== 'function') throw new Error('This browser cannot safely coordinate wallet transactions. Update your browser and try again.');
  const browserWindow = window;
  let operations = activeOperations.get(browserWindow);
  if (!operations) activeOperations.set(browserWindow, operations = new Map());
  if (operations.has(scope)) throw new Error('Another Ethereum wallet request is already in progress. Wait for it to finish and try again.');
  const operation = { label };
  const notify = () => browserWindow.dispatchEvent(new browserWindow.CustomEvent(STORAGE_CHANGED_EVENT, { detail: `${scope}:operation` }));
  operations.set(scope, operation);
  notify();
  try {
    return await locks.request(`mons:ethereum111k-submission:${scope}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Another Ethereum wallet request is already in progress. Wait for it to finish and try again.');
      return run();
    });
  } finally {
    if (operations.get(scope) === operation) {
      operations.delete(scope);
      notify();
    }
  }
}

function readPersistedEthereumStorage(key: string): string | null {
  const value = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  let snapshots = storageSnapshots.get(window);
  if (!snapshots) storageSnapshots.set(window, snapshots = new Map());
  snapshots.set(key, value);
  return value;
}

function readEthereumStorage<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  const fallback = storageFallbacks.get(window)?.get(key);
  let stored: string | null;
  try { stored = readPersistedEthereumStorage(key); }
  catch { return fallback ? fallback.value as T | null : null; }
  if (fallback && stored === fallback.baseline) return fallback.value as T | null;
  storageFallbacks.get(window)?.delete(key);
  try { return JSON.parse(stored ?? 'null') as T | null; } catch { return null; }
}

export function writeEthereumStorage(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  let baseline = storageSnapshots.get(window)?.get(key) ?? null;
  try { baseline = readPersistedEthereumStorage(key); } catch {}
  try {
    if (value === null) window.localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
    else window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
    if (readPersistedEthereumStorage(key) !== (value === null ? null : JSON.stringify(value))) throw new Error('Storage unavailable');
    storageFallbacks.get(window)?.delete(key);
  } catch {
    let fallback = storageFallbacks.get(window);
    if (!fallback) storageFallbacks.set(window, fallback = new Map());
    fallback.set(key, { value, baseline });
  }
  window.dispatchEvent(new window.CustomEvent(STORAGE_CHANGED_EVENT, { detail: key }));
}

export function reserveEthereumSubmission(submission: EthereumSubmission): void {
  const key = `${submission.scope}:pending`;
  const value = JSON.stringify({ ...submission, hash: `0x${'0'.repeat(64)}`, awaitingHash: true });
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
    if (readPersistedEthereumStorage(key) !== value) throw new Error('Storage unavailable');
  } catch {
    try { window.localStorage.removeItem(`${STORAGE_PREFIX}${key}`); } catch {}
    throw new Error('Browser storage is unavailable. Enable storage or free up space before submitting an Ethereum transaction.');
  }
  storageFallbacks.get(window)?.delete(key);
  window.dispatchEvent(new window.CustomEvent(STORAGE_CHANGED_EVENT, { detail: key }));
}

export function isEthereumPendingSaved(scope: string, hash: string): boolean {
  try {
    const value = JSON.parse(readPersistedEthereumStorage(`${scope}:pending`) ?? 'null');
    return value?.hash === hash && !value.awaitingHash;
  } catch { return false; }
}

export function subscribeEthereumPending(scope: string, listener: () => void): () => void {
  const key = `${scope}:pending`;
  const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === key) listener(); };
  const storage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== `${STORAGE_PREFIX}${key}`) return;
    try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
    listener();
  };
  window.addEventListener(STORAGE_CHANGED_EVENT, changed);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(STORAGE_CHANGED_EVENT, changed);
    window.removeEventListener('storage', storage);
  };
}

function readEthereumTransaction(scope: string): (EthereumPendingTransaction & { awaitingHash?: boolean }) | null {
  const value = readEthereumStorage<EthereumPendingTransaction & { awaitingHash?: boolean }>(`${scope}:pending`);
  return value && value.scope === scope && /^0x[0-9a-fA-F]{64}$/.test(value.hash) &&
    ['mint', 'unbox', 'delivery', 'claim', 'transfer', 'cancel'].includes(value.action) && Number.isFinite(value.submittedAt) &&
    (value.nonce === undefined || /^0x[0-9a-fA-F]+$/.test(value.nonce)) &&
    (value.actionBeforeCancellation === undefined || ['mint', 'unbox', 'delivery', 'claim', 'transfer'].includes(value.actionBeforeCancellation)) &&
    (value.intent === undefined || normalizeEthereumAddress(value.intent?.to) && /^0x(?:[0-9a-fA-F]{2})*$/.test(value.intent?.data) && /^0x[0-9a-fA-F]+$/.test(value.intent?.value)) ? value : null;
}

export function readEthereumPending(scope: string): EthereumPendingTransaction | null {
  const value = readEthereumTransaction(scope);
  return value && !value.awaitingHash ? value : null;
}

export function readEthereumSubmission(scope: string): EthereumSubmission | null {
  const value = readEthereumTransaction(scope);
  if (!value?.awaitingHash) return null;
  const { hash: _hash, awaitingHash: _awaitingHash, ...submission } = value;
  return submission;
}

export function readEthereumExpected(scope: string): string[] {
  const value = readEthereumStorage<unknown>(`${scope}:expected`);
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length <= 78 && normalizeEthereumTokenId(id) === id))].slice(-100) : [];
}

export function readEthereumSession(scope: string, config: Ethereum111kConfig, owner: string): EthereumSession | null {
  try {
    const session = JSON.parse(window.sessionStorage.getItem(`mons.ethereum111k:${scope}:session`) ?? 'null') as EthereumSession | null;
    return session?.address === owner && session.chainId === config.chainId && session.dropId === config.dropId &&
      typeof session.token === 'string' && session.expiresAtMs > Date.now() + 10_000 ? session : null;
  } catch { return null; }
}

export function saveEthereumSession(scope: string, session: EthereumSession | null): void {
  try {
    if (session) window.sessionStorage.setItem(`mons.ethereum111k:${scope}:session`, JSON.stringify(session));
    else window.sessionStorage.removeItem(`mons.ethereum111k:${scope}:session`);
  } catch {}
}

export function clearEthereumSession(scope: string, rejectedToken: string): void {
  try {
    const key = `${STORAGE_PREFIX}${scope}:session`;
    const stored = JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as EthereumSession | null;
    if (stored?.token === rejectedToken) window.sessionStorage.removeItem(key);
  } catch {}
}
