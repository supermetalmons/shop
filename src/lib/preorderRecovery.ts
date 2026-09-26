import { getPreorderConfig, type PreorderOrder } from '../../shared/preorders.ts';
import type { ShopPreorderAssetResolution } from '../../shared/shopApi';
import { parsePreorderOrder } from './preorderApi';

export type PreorderRecoveryRecord = {
  order: PreorderOrder;
  resolvedAssetIds: string[];
  ownedResolvedAssetIds?: string[];
  inventoryResolutionRevisions?: Record<string, number>;
  inventoryResolutionSlots?: Record<string, number>;
  failureNotified: boolean;
};

const PREFIX = 'mons:preorder-recovery:v3:';
const LEGACY_PREFIXES = ['mons:preorder-recovery:v2:', 'mons:preorder-recovery:v1:'];
const listeners = new Set<() => void>();
const fallback = new Map<string, string>();

function storage(shared = true): Storage | null {
  try { return typeof window === 'undefined' ? null : shared ? window.localStorage : window.sessionStorage; } catch { return null; }
}

function keyFor(order: PreorderOrder): string {
  const config = getPreorderConfig(order.preorderId)!;
  return `${PREFIX}${config.cluster}:${config.collection}:${order.buyer}:${encodeURIComponent(order.orderId)}`;
}

function parse(value: string | null): PreorderRecoveryRecord | null {
  try {
    const parsed = JSON.parse(value || 'null');
    if (!parsed || !parsed.order || !Array.isArray(parsed.resolvedAssetIds) || typeof parsed.failureNotified !== 'boolean') return null;
    const order = parsePreorderOrder(parsed.order, parsed.order.preorderId);
    if (order.confirmedSlot == null) return null;
    const resolvedAssetIds: string[] = parsed.inventoryResolutionVersion === 3
      ? parsed.resolvedAssetIds.filter((id: unknown) => order.assets.some(asset => asset.address === id)) : [];
    const ownedResolvedAssetIds = Array.isArray(parsed.ownedResolvedAssetIds)
      ? parsed.ownedResolvedAssetIds.filter((id: unknown) => resolvedAssetIds.includes(id as string)) : [];
    const inventoryResolutionRevisions = Object.fromEntries(order.assets.flatMap(asset => {
      const revision = parsed.inventoryResolutionRevisions?.[asset.address];
      return Number.isSafeInteger(revision) && revision >= 0 ? [[asset.address, revision]] : [];
    }));
    const inventoryResolutionSlots = Object.fromEntries(order.assets.flatMap(asset => {
      const slot = parsed.inventoryResolutionSlots?.[asset.address];
      return Number.isSafeInteger(slot) && slot >= 0 ? [[asset.address, slot]] : [];
    }));
    return { order, resolvedAssetIds, ownedResolvedAssetIds, inventoryResolutionRevisions, inventoryResolutionSlots,
      failureNotified: parsed.failureNotified };
  } catch { return null; }
}

function localValue(key: string): string | null {
  try { return fallback.get(key) ?? storage(false)?.getItem(key) ?? null; } catch { return fallback.get(key) ?? null; }
}

function sourceKeys(key: string): string[] {
  return [key, ...LEGACY_PREFIXES.map(prefix => `${prefix}${key.slice(PREFIX.length)}`)];
}

function mergeRecoveryRecords(local: PreorderRecoveryRecord | null, shared: PreorderRecoveryRecord | null): PreorderRecoveryRecord | null {
  if (!local) return shared;
  if (!shared || keyFor(local.order) !== keyFor(shared.order) || local.order.signature !== shared.order.signature ||
    local.order.ethereumAddress !== shared.order.ethereumAddress || local.order.expiresAtMs !== shared.order.expiresAtMs ||
    local.order.assets.length !== shared.order.assets.length || local.order.assets.some(asset =>
      !shared.order.assets.some(other => other.id === asset.id && other.address === asset.address))) return local;
  if (local.order.status !== 'submitted' && shared.order.status !== 'submitted' && local.order.status !== shared.order.status) return local;
  const order = { ...(local.order.status === 'submitted' ? shared.order : local.order),
    confirmedSlot: Math.max(local.order.confirmedSlot!, shared.order.confirmedSlot!) };
  const resolved = new Set(local.resolvedAssetIds);
  const owned = new Set(local.ownedResolvedAssetIds);
  const inventoryResolutionSlots = { ...local.inventoryResolutionSlots };
  const inventoryResolutionRevisions = { ...local.inventoryResolutionRevisions };
  for (const { address } of order.assets) {
    const revision = shared.inventoryResolutionRevisions?.[address] ?? 0;
    if (revision > (inventoryResolutionRevisions[address] ?? 0)) inventoryResolutionRevisions[address] = revision;
    if (order.status !== 'succeeded' && order.status !== 'submitted' ||
      shared.order.status !== 'succeeded' && shared.order.status !== 'submitted' || !shared.resolvedAssetIds.includes(address)) continue;
    const currentSlot = inventoryResolutionSlots[address];
    const sharedSlot = shared.inventoryResolutionSlots?.[address];
    if (shared.order.status === 'submitted' && sharedSlot === undefined) continue;
    if (sharedSlot === undefined ? currentSlot !== undefined || resolved.has(address)
      : sharedSlot < order.confirmedSlot || currentSlot !== undefined && sharedSlot <= currentSlot) continue;
    resolved.add(address);
    if (shared.ownedResolvedAssetIds?.includes(address)) owned.add(address);
    else owned.delete(address);
    if (sharedSlot !== undefined) inventoryResolutionSlots[address] = sharedSlot;
  }
  return { order, resolvedAssetIds: order.assets.filter(asset => resolved.has(asset.address)).map(asset => asset.address),
    ownedResolvedAssetIds: order.assets.filter(asset => owned.has(asset.address)).map(asset => asset.address),
    inventoryResolutionRevisions, inventoryResolutionSlots, failureNotified: local.failureNotified || shared.failureNotified };
}

function recordForKey(value: string | null, key: string): PreorderRecoveryRecord | null {
  const record = parse(value);
  return record && keyFor(record.order) === key ? record : null;
}

function recordSource(key: string): { record: PreorderRecoveryRecord | null; local: boolean; needsWrite: boolean } {
  const shared = storage();
  for (const source of sourceKeys(key)) {
    const local = localValue(source);
    if (local !== null) {
      const previous = recordForKey(local, key);
      const record = source === key ? mergeRecoveryRecords(previous, recordForKey(shared?.getItem(source) ?? null, key)) : previous;
      return { record, local: true, needsWrite: source !== key || JSON.stringify(record) !== JSON.stringify(previous) };
    }
    const value = shared?.getItem(source) ?? null;
    if (value !== null) return { record: recordForKey(value, key), local: false, needsWrite: source !== key };
  }
  return { record: null, local: false, needsWrite: false };
}

function safeRecordSource(key: string): ReturnType<typeof recordSource> {
  try { return recordSource(key); }
  catch {
    for (const source of sourceKeys(key)) {
      const value = localValue(source);
      if (value !== null) return { record: recordForKey(value, key), local: true, needsWrite: source !== key };
    }
    return { record: null, local: true, needsWrite: false };
  }
}

function read(key: string): PreorderRecoveryRecord | null {
  return safeRecordSource(key).record;
}

function emit(): void { for (const listener of listeners) listener(); }

function write(key: string, record: PreorderRecoveryRecord, shared: boolean): void {
  const value = JSON.stringify({ ...record, inventoryResolutionVersion: 3 });
  try {
    const target = storage(shared);
    if (!target) throw new Error('Storage unavailable');
    target.setItem(key, value);
    fallback.delete(key);
  } catch {
    try {
      const target = storage(false);
      if (!target) throw new Error('Storage unavailable');
      target.setItem(key, value);
      fallback.delete(key);
    } catch { fallback.set(key, value); }
  }
  emit();
}

function mutateRecord(key: string, update: (current: PreorderRecoveryRecord | null) => PreorderRecoveryRecord | undefined,
  signal?: AbortSignal): Promise<void> {
  const run = (shared: boolean) => {
    signal?.throwIfAborted();
    let source: ReturnType<typeof recordSource>;
    if (shared) {
      try { source = recordSource(key); } catch { run(false); return; }
      shared = !source.local;
    } else source = safeRecordSource(key);
    const current = source.record;
    const next = update(current);
    if (next) write(key, next, shared);
    else if (source.needsWrite && current) write(key, current, shared);
  };
  const locks = typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function' ? navigator.locks : null;
  if (!locks || localValue(key) !== null) {
    try { run(false); return Promise.resolve(); } catch (error) { return Promise.reject(error); }
  }
  let entered = false;
  return Promise.resolve().then(() => locks.request(`mons:preorder-recovery-mutation:${key}`, { signal }, () => {
    entered = true;
    run(localValue(key) === null);
  })).catch(error => {
    if (entered || signal?.aborted) throw error;
    run(false);
  });
}

export function listPreorderRecoveries(owner?: string): PreorderRecoveryRecord[] {
  const keys = new Set(fallback.keys());
  try {
    for (const target of [storage(), storage(false)]) {
      if (target) for (let index = 0; index < target.length; index += 1) {
        const key = target.key(index);
        if (key && [PREFIX, ...LEGACY_PREFIXES].some(prefix => key.startsWith(prefix))) keys.add(key);
      }
    }
  } catch {}
  const canonicalKeys = new Set([...keys].map(key => {
    const legacyPrefix = LEGACY_PREFIXES.find(prefix => key.startsWith(prefix));
    return legacyPrefix ? `${PREFIX}${key.slice(legacyPrefix.length)}` : key;
  }));
  return [...canonicalKeys].sort().flatMap(key => {
    const value = read(key);
    return value && (!owner || value.order.buyer === owner) && key === keyFor(value.order) ? [value] : [];
  });
}

export function preorderRecoverySnapshot(owner?: string): string {
  return JSON.stringify(listPreorderRecoveries(owner));
}

export async function hydratePreorderRecoveries(owner: string, signal?: AbortSignal): Promise<void> {
  for (const { order } of listPreorderRecoveries(owner)) {
    const key = keyFor(order);
    if (safeRecordSource(key).needsWrite) await mutateRecord(key, () => undefined, signal);
  }
}

export function subscribePreorderRecoveries(listener: () => void): () => void {
  listeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (event.key === null || [PREFIX, ...LEGACY_PREFIXES].some(prefix => event.key!.startsWith(prefix))) listener();
  };
  window.addEventListener('storage', changed);
  return () => { listeners.delete(listener); window.removeEventListener('storage', changed); };
}

export function upsertPreorderRecovery(order: PreorderOrder): Promise<void> {
  if (order.confirmedSlot == null) return Promise.resolve();
  const key = keyFor(order);
  return mutateRecord(key, previous => {
    if (previous && previous.order.status !== 'submitted' && order.status === 'submitted') return;
    if (previous && previous.order.status !== 'submitted' && order.status !== previous.order.status) return;
    const next = { order: { ...order, confirmedSlot: Math.max(order.confirmedSlot!, previous?.order.confirmedSlot ?? 0) },
      resolvedAssetIds: previous?.resolvedAssetIds ?? [], ownedResolvedAssetIds: previous?.ownedResolvedAssetIds ?? [],
      inventoryResolutionRevisions: previous?.inventoryResolutionRevisions ?? {},
      inventoryResolutionSlots: previous?.inventoryResolutionSlots ?? {},
      failureNotified: previous?.failureNotified ?? false };
    return JSON.stringify(previous) !== JSON.stringify(next) ? next : undefined;
  });
}

export async function resolvePreorderInventoryAssets(owner: string, ids: readonly string[], ownedIds: readonly string[] = [],
  requestRecords?: readonly PreorderRecoveryRecord[], signal?: AbortSignal,
  proofs?: readonly ShopPreorderAssetResolution[]): Promise<void> {
  const resolved = new Set(ids);
  const proofById = new Map(proofs?.filter(proof => Number.isSafeInteger(proof.slot) && proof.slot >= 0 && typeof proof.owned === 'boolean')
    .map(proof => [proof.id, proof]));
  const owned = new Set(proofs === undefined ? ownedIds : [...proofById.values()].filter(proof => proof.owned).map(proof => proof.id));
  for (const candidate of listPreorderRecoveries(owner)) {
    if (!candidate.order.assets.some(asset => resolved.has(asset.address))) continue;
    await mutateRecord(keyFor(candidate.order), record => {
      if (!record || record.order.status !== 'succeeded' &&
        !(record.order.status === 'submitted' && record.order.confirmedSlot != null && proofs !== undefined)) return;
      const initial = requestRecords?.find(value => value.order.orderId === record.order.orderId && value.order.preorderId === record.order.preorderId);
      const accepted = new Set(record.order.assets.filter(({ address }) => {
        if (!resolved.has(address)) return false;
        const currentSlot = record.inventoryResolutionSlots?.[address];
        if (proofs !== undefined) {
          const proof = proofById.get(address);
          if (!proof || proof.slot < Math.max(currentSlot ?? 0, record.order.confirmedSlot ?? 0)) return false;
          if (currentSlot === proof.slot && record.resolvedAssetIds.includes(address)) return false;
          return true;
        }
        if (currentSlot !== undefined) return false;
        const proofChanged = (initial?.inventoryResolutionRevisions?.[address] ?? 0) !== (record.inventoryResolutionRevisions?.[address] ?? 0) ||
          Boolean(initial?.resolvedAssetIds.includes(address)) !== record.resolvedAssetIds.includes(address) ||
          Boolean(initial?.ownedResolvedAssetIds?.includes(address)) !== Boolean(record.ownedResolvedAssetIds?.includes(address));
        return requestRecords === undefined || !proofChanged;
      }).map(asset => asset.address));
      if (!accepted.size) return;
      const resolvedAssetIds = record.order.assets.filter(asset => accepted.has(asset.address) || record.resolvedAssetIds.includes(asset.address)).map(asset => asset.address);
      const ownedResolvedAssetIds = record.order.assets.filter(asset => accepted.has(asset.address)
        ? owned.has(asset.address) : record.ownedResolvedAssetIds?.includes(asset.address)).map(asset => asset.address);
      const inventoryResolutionRevisions = { ...record.inventoryResolutionRevisions };
      const inventoryResolutionSlots = { ...record.inventoryResolutionSlots };
      for (const id of accepted) inventoryResolutionRevisions[id] = (inventoryResolutionRevisions[id] ?? 0) + 1;
      for (const id of accepted) if (proofById.has(id)) inventoryResolutionSlots[id] = proofById.get(id)!.slot;
      return { ...record, resolvedAssetIds, ownedResolvedAssetIds, inventoryResolutionRevisions, inventoryResolutionSlots };
    }, signal);
  }
}

export function acknowledgePreorderFailure(owner: string, preorderId: string, orderId: string): Promise<void> {
  const record = listPreorderRecoveries(owner).find(value => value.order.preorderId === preorderId && value.order.orderId === orderId);
  if (!record) return Promise.resolve();
  return mutateRecord(keyFor(record.order), current => current && !current.failureNotified &&
    (current.order.status === 'failed' || current.order.status === 'expired') ? { ...current, failureNotified: true } : undefined);
}
