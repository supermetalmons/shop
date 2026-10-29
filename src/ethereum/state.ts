import type { Ethereum111kConfig, EthereumInventoryItem, EthereumSession } from '../../shared/ethereum/api';
import { ETHEREUM_FUNCTIONS, ETHEREUM_MAX_EXPECTED_IDS, ETHEREUM_MAX_UNBOX_QUANTITY, ethereumAssetId, normalizeEthereumAddress, normalizeEthereumTokenId } from '../../shared/ethereum/protocol';
import type { InventoryItem } from '../types';
import { ETHEREUM_CONTAINER_MEDIA } from './containerMedia';
import { decodeReturn, encodeCall } from '../../shared/ethereum/abi';

export type EthereumAction = 'mint' | 'unbox' | 'delivery' | 'claim' | 'transfer' | 'cancel';
export type EthereumPendingTransaction = {
  scope: string;
  hash: string;
  action: EthereumAction;
  submittedAt: number;
  orderId?: number;
  claimId?: string;
  nonce?: string;
  transactionSender?: string;
  transactionCallHash?: string;
  intent?: { to: string; data: string; value: string };
  actionBeforeCancellation?: Exclude<EthereumAction, 'cancel'>;
};
export type EthereumSubmission = Omit<EthereumPendingTransaction, 'hash'>;
export type EthereumRevealJob = { transactionHash: string; submittedAt: number; trackingId: string; crateTokenIds?: string[] };
type EthereumInventoryRecovery = { hash: string; sourceIds: string[]; mintedIds: string[] };

export type EthereumInventoryView = InventoryItem & { ethereum: EthereumInventoryItem };

export function ethereumInventoryScope(config: Pick<Ethereum111kConfig, 'chainId' | 'contractAddress'>, address: string | null): string | null {
  const owner = normalizeEthereumAddress(address);
  return owner && config.contractAddress ? `${config.chainId}:${config.contractAddress.toLowerCase()}:${owner}` : null;
}

export function ethereumInventoryQueryKey(scope: string | null) { return ['ethereum111k', 'inventory', scope] as const; }

export function ethereumInventoryView(item: EthereumInventoryItem): EthereumInventoryView {
  const containerMedia = item.kind === 'crate' || item.kind === 'warehouse' ? ETHEREUM_CONTAINER_MEDIA[item.kind] : undefined;
  return {
    id: ethereumAssetId(item.chainId, item.contractAddress, item.tokenId),
    dropId: '111k_devnet', name: item.name, image: containerMedia?.src ?? item.image,
    ...(containerMedia ? { imageDimensions: { width: containerMedia.width, height: containerMedia.height } } : {}),
    ...(!containerMedia && item.aspectRatio ? { imageDimensions: item.aspectRatio } : {}),
    ...(item.animation_url ? { previewVideo: { sources: [{ src: item.animation_url }], posterSrc: item.image } } : {}),
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

const STORAGE_PREFIX = 'ethereum111k:';
const STORAGE_CHANGED_EVENT = 'ethereum111k-storage';
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
  return locks.request(`ethereum111k-submission:${scope}`, {}, run);
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
    return await locks.request(`ethereum111k-submission:${scope}`, { ifAvailable: true }, async lock => {
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
    const serialized = value === null ? null : JSON.stringify(value);
    if (serialized === null) window.localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
    else window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, serialized);
    if (readPersistedEthereumStorage(key) !== serialized) throw new Error('Storage unavailable');
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

function subscribeEthereumStorage(key: string, listener: () => void, prefixes: readonly string[] = []): () => void {
  const matches = (value: unknown) => typeof value === 'string' && (value === key || prefixes.some(prefix => value.startsWith(prefix)));
  const changed = (event: Event) => { if (matches((event as CustomEvent<string>).detail)) listener(); };
  const storage = (event: StorageEvent) => {
    if (event.key !== null && (!event.key.startsWith(STORAGE_PREFIX) || !matches(event.key.slice(STORAGE_PREFIX.length)))) return;
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

export function subscribeEthereumPending(scope: string, listener: () => void): () => void {
  return subscribeEthereumStorage(`${scope}:pending`, listener);
}

export function subscribeEthereumRevealJobs(scope: string, listener: () => void): () => void {
  return subscribeEthereumStorage(`${scope}:reveals`, listener, [revealJobPrefix(scope), revealClosedPrefix(scope)]);
}

const REVEAL_HASH = /^0x[0-9a-f]{64}$/;
const REVEAL_TRACKING_ID = /^(?:legacy|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const revealJobPrefix = (scope: string) => `${scope}:reveal-job:v2:`;
const revealClosedPrefix = (scope: string) => `${scope}:reveal-closed:v2:`;
const revealClosedKey = (scope: string, hash: string, trackingId: string) => `${revealClosedPrefix(scope)}${hash}:${trackingId}`;

function ethereumStorageKeys(prefix: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  const keys = new Set([...storageFallbacks.get(window)?.keys() ?? [], ...storageSnapshots.get(window)?.keys() ?? []]
    .filter(key => key.startsWith(prefix)));
  try {
    const storage = window.localStorage;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(`${STORAGE_PREFIX}${prefix}`)) keys.add(key.slice(STORAGE_PREFIX.length));
    }
  } catch {}
  return keys;
}

function validRevealCrateIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= ETHEREUM_MAX_UNBOX_QUANTITY &&
    new Set(value).size === value.length && value.every(id => typeof id === 'string' && /^\d{6}$/.test(id) && Number(id) >= 111112 && Number(id) <= 116666);
}

function revealJob(value: unknown, trackingId?: string): EthereumRevealJob | null {
  if (value === null || typeof value !== 'object' || !('transactionHash' in value) ||
    typeof value.transactionHash !== 'string' || !REVEAL_HASH.test(value.transactionHash) ||
    !('submittedAt' in value) || !Number.isSafeInteger(value.submittedAt) || Number(value.submittedAt) < 0) return null;
  const id = trackingId ?? ('trackingId' in value ? value.trackingId : undefined);
  if (typeof id !== 'string' || !REVEAL_TRACKING_ID.test(id)) return null;
  return { transactionHash: value.transactionHash, submittedAt: Number(value.submittedAt), trackingId: id,
    ...('crateTokenIds' in value && validRevealCrateIds(value.crateTokenIds) ? { crateTokenIds: value.crateTokenIds } : {}) };
}

function legacyEthereumRevealJobs(scope: string): EthereumRevealJob[] {
  const value = readEthereumStorage<unknown>(`${scope}:reveals`);
  return Array.isArray(value) ? value.flatMap(entry => { const job = revealJob(entry, 'legacy'); return job ? [job] : []; }) : [];
}

function currentEthereumRevealJob(scope: string, hash: string): EthereumRevealJob | null {
  const job = revealJob(readEthereumStorage(`${revealJobPrefix(scope)}${hash}`));
  return job?.transactionHash === hash ? job : legacyEthereumRevealJobs(scope).find(value => value.transactionHash === hash) ?? null;
}

function ethereumRevealJobClosed(scope: string, job: EthereumRevealJob): boolean {
  return readEthereumStorage(revealClosedKey(scope, job.transactionHash, job.trackingId)) === true;
}

function intendedRevealCrateIds(scope: string, hash: string, operation?: EthereumSubmission | null): string[] | null {
  return operation?.scope === scope && (!('hash' in operation) || typeof operation.hash === 'string' && operation.hash.toLowerCase() === hash) &&
    normalizeEthereumAddress(operation.intent?.to) === scope.split(':')[1] ? ethereumCrateUnpackIds(operation) : null;
}

export function readEthereumRevealJobs(scope: string): EthereumRevealJob[] {
  const jobs = new Map(legacyEthereumRevealJobs(scope).map(job => [job.transactionHash, job]));
  const prefix = revealJobPrefix(scope);
  for (const key of ethereumStorageKeys(prefix)) {
    const job = revealJob(readEthereumStorage(key));
    if (job && key === `${prefix}${job.transactionHash}`) jobs.set(job.transactionHash, job);
  }
  const pending = readEthereumPending(scope);
  return [...jobs.values()].filter(job => !ethereumRevealJobClosed(scope, job)).map(job => {
    const crateTokenIds = !job.crateTokenIds ? intendedRevealCrateIds(scope, job.transactionHash, pending) : null;
    return crateTokenIds ? { ...job, crateTokenIds } : job;
  })
    .sort((a, b) => a.submittedAt - b.submittedAt || a.transactionHash.localeCompare(b.transactionHash));
}

export function rememberEthereumRevealJob(scope: string, transactionHash: string, submittedAt = Date.now(), operation?: EthereumSubmission): void {
  const hash = transactionHash.toLowerCase();
  if (!REVEAL_HASH.test(hash) || !Number.isSafeInteger(submittedAt) || submittedAt < 0) return;
  const crateTokenIds = intendedRevealCrateIds(scope, hash, operation);
  const current = currentEthereumRevealJob(scope, hash);
  if (current && !ethereumRevealJobClosed(scope, current)) {
    if (!current.crateTokenIds && crateTokenIds) writeEthereumStorage(`${revealJobPrefix(scope)}${hash}`, { ...current, crateTokenIds });
    return;
  }
  writeEthereumStorage(`${revealJobPrefix(scope)}${hash}`, { transactionHash: hash, submittedAt, trackingId: crypto.randomUUID(),
    ...(crateTokenIds ? { crateTokenIds } : {}) });
}

export function forgetEthereumRevealJob(scope: string, transactionHash: string, expectedTrackingId?: string): void {
  const hash = transactionHash.toLowerCase();
  if (!REVEAL_HASH.test(hash)) return;
  const trackingId = expectedTrackingId ?? currentEthereumRevealJob(scope, hash)?.trackingId ?? 'legacy';
  if (!REVEAL_TRACKING_ID.test(trackingId)) return;
  const key = revealClosedKey(scope, hash, trackingId);
  if (readEthereumStorage(key) !== true) writeEthereumStorage(key, true);
}

export async function restorePendingEthereumRevealJob(scope: string, transactionHash: string): Promise<void> {
  await withEthereumSubmissionLock(scope, () => {
    const pending = readEthereumPending(scope);
    if (!pending || pending.hash.toLowerCase() !== transactionHash.toLowerCase() || !isEthereumCrateUnpack(pending)) return;
    const hash = pending.hash.toLowerCase();
    const current = currentEthereumRevealJob(scope, hash);
    if (current) {
      if (!ethereumRevealJobClosed(scope, current)) rememberEthereumRevealJob(scope, hash, pending.submittedAt, pending);
      return;
    }
    const prefix = `${revealClosedPrefix(scope)}${hash}:`;
    if ([...ethereumStorageKeys(prefix)].some(key => REVEAL_TRACKING_ID.test(key.slice(prefix.length)) && readEthereumStorage(key) === true)) return;
    rememberEthereumRevealJob(scope, hash, pending.submittedAt, pending);
  });
}

function ethereumCrateUnpackIds(operation: EthereumSubmission): string[] | null {
  if (operation.action !== 'unbox' || !operation.intent) return null;
  try {
    if (BigInt(operation.intent.value) !== 0n) return null;
    const data = operation.intent.data.toLowerCase();
    const batch = data.slice(0, 10) === encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, [], []);
    const signature = batch ? ETHEREUM_FUNCTIONS.unboxCrates : ETHEREUM_FUNCTIONS.unboxCrate;
    if (data.slice(0, 10) !== encodeCall(signature, [], [])) return null;
    const types = [batch ? 'uint256[]' : 'uint256'];
    const args = decodeReturn(types, `0x${data.slice(10)}`);
    if (encodeCall(signature, types, args) !== data) return null;
    const ids = (batch ? args[0] as bigint[] : [args[0] as bigint]).map(String);
    return validRevealCrateIds(ids) ? ids : null;
  } catch { return null; }
}

export function isEthereumCrateUnpack(operation: EthereumSubmission): boolean { return ethereumCrateUnpackIds(operation) !== null; }

function readEthereumTransaction(scope: string): (EthereumPendingTransaction & { awaitingHash?: boolean }) | null {
  const value = readEthereumStorage<EthereumPendingTransaction & { awaitingHash?: boolean }>(`${scope}:pending`);
  return value && value.scope === scope && /^0x[0-9a-fA-F]{64}$/.test(value.hash) &&
    ['mint', 'unbox', 'delivery', 'claim', 'transfer', 'cancel'].includes(value.action) && Number.isFinite(value.submittedAt) &&
    (value.nonce === undefined || /^0x[0-9a-fA-F]+$/.test(value.nonce)) &&
    (value.transactionSender === undefined || typeof value.transactionSender === 'string' && normalizeEthereumAddress(value.transactionSender) === value.transactionSender) &&
    (value.transactionCallHash === undefined || /^0x[0-9a-f]{64}$/.test(value.transactionCallHash)) &&
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
  return expectedIds(Array.isArray(value) ? value : value && typeof value === 'object' && 'ids' in value ? value.ids : null, ETHEREUM_MAX_EXPECTED_IDS);
}

function expectedIds(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length <= 78 && normalizeEthereumTokenId(id) === id))].slice(-limit) : [];
}

function readEthereumInventoryRecovery(scope: string): EthereumInventoryRecovery | null {
  const value = readEthereumStorage<{ recovery?: EthereumInventoryRecovery }>(`${scope}:expected`);
  const recovery = value?.recovery;
  return recovery && typeof recovery.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(recovery.hash)
    ? { hash: recovery.hash, sourceIds: expectedIds(recovery.sourceIds, ETHEREUM_MAX_EXPECTED_IDS), mintedIds: expectedIds(recovery.mintedIds, ETHEREUM_MAX_EXPECTED_IDS) } : null;
}

function readEthereumRetainedIds(scope: string): string[] {
  return expectedIds(readEthereumStorage<{ retainedIds?: unknown }>(`${scope}:expected`)?.retainedIds, ETHEREUM_MAX_EXPECTED_IDS);
}

export function readEthereumInventoryExpected(scope: string): string[] {
  const recoveryIds = [...new Set([...readEthereumRetainedIds(scope), ...(readEthereumInventoryRecovery(scope)?.sourceIds ?? [])])].slice(-ETHEREUM_MAX_EXPECTED_IDS);
  return [...new Set([...readEthereumExpected(scope), ...recoveryIds])];
}

export function writeEthereumExpected(scope: string, ids: string[], recovery = readEthereumInventoryRecovery(scope), retainedIds = readEthereumRetainedIds(scope)): void {
  const normalized = expectedIds(ids, ETHEREUM_MAX_EXPECTED_IDS);
  const previous = readEthereumInventoryRecovery(scope);
  if (recovery && previous && previous.hash !== recovery.hash) retainedIds.push(...previous.sourceIds);
  if (recovery && previous?.hash === recovery.hash) recovery = {
    ...recovery, sourceIds: [...new Set([...previous.sourceIds, ...recovery.sourceIds])].slice(-ETHEREUM_MAX_EXPECTED_IDS),
  };
  if (recovery) recovery = { ...recovery, sourceIds: expectedIds(recovery.sourceIds, ETHEREUM_MAX_EXPECTED_IDS), mintedIds: expectedIds(recovery.mintedIds, ETHEREUM_MAX_EXPECTED_IDS) };
  retainedIds = [...new Set([...retainedIds, ...(recovery?.sourceIds ?? [])])].slice(-ETHEREUM_MAX_EXPECTED_IDS)
    .filter(id => !recovery?.sourceIds.includes(id));
  writeEthereumStorage(`${scope}:expected`, recovery || retainedIds.length
    ? { ids: normalized, ...(recovery ? { recovery } : {}), ...(retainedIds.length ? { retainedIds } : {}) } : normalized);
}

export function clearEthereumInventoryRecovery(scope: string, hash: string): void {
  if (readEthereumInventoryRecovery(scope)?.hash === hash) writeEthereumExpected(scope, readEthereumExpected(scope), null);
}

export function restoreEthereumExpected(scope: string, hash: string): void {
  const recovery = readEthereumInventoryRecovery(scope);
  if (!recovery || recovery.hash !== hash) return;
  const minted = new Set(recovery.mintedIds);
  const restored = [...new Set([...readEthereumExpected(scope).filter(id => !minted.has(id)), ...recovery.sourceIds])];
  writeEthereumExpected(scope, restored, null, [...readEthereumRetainedIds(scope), ...restored.slice(0, -ETHEREUM_MAX_EXPECTED_IDS)]);
}

export function replaceEthereumInventoryRecovery(scope: string, previousHash: string, hash: string): void {
  const recovery = readEthereumInventoryRecovery(scope);
  if (recovery?.hash === previousHash) writeEthereumExpected(scope, readEthereumExpected(scope), { ...recovery, hash });
}

export function readEthereumSession(scope: string, config: Ethereum111kConfig, owner: string): EthereumSession | null {
  try {
    const session = JSON.parse(window.sessionStorage.getItem(`ethereum111k:${scope}:session`) ?? 'null') as EthereumSession | null;
    return session?.address === owner && session.chainId === config.chainId && session.dropId === config.dropId &&
      typeof session.token === 'string' && session.expiresAtMs > Date.now() + 10_000 ? session : null;
  } catch { return null; }
}

export function saveEthereumSession(scope: string, session: EthereumSession | null): void {
  try {
    if (session) window.sessionStorage.setItem(`ethereum111k:${scope}:session`, JSON.stringify(session));
    else window.sessionStorage.removeItem(`ethereum111k:${scope}:session`);
  } catch {}
}

export function clearEthereumSession(scope: string, rejectedToken: string): void {
  try {
    const key = `${STORAGE_PREFIX}${scope}:session`;
    const stored = JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as EthereumSession | null;
    if (stored?.token === rejectedToken) window.sessionStorage.removeItem(key);
  } catch {}
}
