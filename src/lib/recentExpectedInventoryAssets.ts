import {
  SHOP_EXPECTED_ASSET_IDS_MAX,
  type ShopExpectedAssetIds,
} from '../../functions/src/shared/shopApi';
import { isBase58Bytes } from '../../functions/src/shared/solanaRpcProxy';

export const RECENT_EXPECTED_INVENTORY_ASSET_TTL_MS = 10 * 60 * 1000;
export const RECENT_EXPECTED_INVENTORY_ASSET_MAX_ENTRIES = 60;

type ExpectedAssetCluster = keyof ShopExpectedAssetIds;

type RecentExpectedInventoryAsset = {
  assetId: string;
  cluster: ExpectedAssetCluster;
  registeredAt: number;
};

export type RecentExpectedInventoryAssetState = {
  cursor: number;
  entries: RecentExpectedInventoryAsset[];
};

export type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type RecentExpectedInventoryAssetSelection = {
  commit: (now?: number) => void;
  expectedAssetIds?: ShopExpectedAssetIds;
};

type StoreOptions = {
  now?: number;
  storage?: SessionStorageLike | null;
};

const STORAGE_VERSION = 1;
const STORAGE_KEY_PREFIX = 'mons:recent-expected-inventory-assets:v1:';

function emptyState(): RecentExpectedInventoryAssetState {
  return { cursor: 0, entries: [] };
}

function isExpectedAssetCluster(value: unknown): value is ExpectedAssetCluster {
  return value === 'mainnet-beta' || value === 'devnet';
}

function normalizeState(value: unknown, now: number): RecentExpectedInventoryAssetState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState();
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.entries)) return emptyState();
  const seen = new Set<string>();
  const entries: RecentExpectedInventoryAsset[] = [];
  for (const candidate of record.entries) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry.assetId !== 'string' ||
      !isBase58Bytes(entry.assetId, 32) ||
      !isExpectedAssetCluster(entry.cluster) ||
      typeof entry.registeredAt !== 'number' ||
      !Number.isFinite(entry.registeredAt) ||
      entry.registeredAt > now ||
      now - entry.registeredAt >= RECENT_EXPECTED_INVENTORY_ASSET_TTL_MS ||
      seen.has(entry.assetId)
    ) continue;
    seen.add(entry.assetId);
    entries.push({
      assetId: entry.assetId,
      cluster: entry.cluster,
      registeredAt: entry.registeredAt,
    });
  }
  entries.sort((left, right) => right.registeredAt - left.registeredAt);
  const bounded = entries.slice(0, RECENT_EXPECTED_INVENTORY_ASSET_MAX_ENTRIES);
  const rawCursor = Number.isSafeInteger(record.cursor) && Number(record.cursor) >= 0
    ? Number(record.cursor)
    : 0;
  return {
    cursor: rawCursor < bounded.length ? rawCursor : 0,
    entries: bounded,
  };
}

export function registerRecentExpectedInventoryAssetsInState(
  state: RecentExpectedInventoryAssetState,
  cluster: ExpectedAssetCluster,
  assetIds: readonly string[],
  now: number,
): RecentExpectedInventoryAssetState {
  const current = normalizeState(state, now);
  const uniqueIds = Array.from(new Set(assetIds.filter((assetId) => isBase58Bytes(assetId, 32))));
  if (!uniqueIds.length) return current;
  const registeredIds = new Set(uniqueIds);
  return {
    cursor: 0,
    entries: [
      ...uniqueIds.map((assetId) => ({ assetId, cluster, registeredAt: now })),
      ...current.entries.filter((entry) => !registeredIds.has(entry.assetId)),
    ].slice(0, RECENT_EXPECTED_INVENTORY_ASSET_MAX_ENTRIES),
  };
}

export function takeRecentExpectedInventoryAssetsFromState(
  state: RecentExpectedInventoryAssetState,
  includeDevnet: boolean,
  now: number,
): { expectedAssetIds?: ShopExpectedAssetIds; state: RecentExpectedInventoryAssetState } {
  const current = normalizeState(state, now);
  if (!current.entries.length) return { state: current };
  const selected: RecentExpectedInventoryAsset[] = [];
  let cursor = current.cursor;
  let scanned = 0;
  while (scanned < current.entries.length && selected.length < SHOP_EXPECTED_ASSET_IDS_MAX) {
    const entry = current.entries[cursor];
    if (includeDevnet || entry.cluster === 'mainnet-beta') selected.push(entry);
    cursor = (cursor + 1) % current.entries.length;
    scanned += 1;
  }
  if (!selected.length) return { state: { ...current, cursor } };
  const expectedAssetIds: ShopExpectedAssetIds = {};
  for (const entry of selected) {
    const group = expectedAssetIds[entry.cluster];
    if (group) group.push(entry.assetId);
    else expectedAssetIds[entry.cluster] = [entry.assetId];
  }
  return {
    expectedAssetIds,
    state: { ...current, cursor },
  };
}

export function reconcileRecentExpectedInventoryAssetsInState(
  state: RecentExpectedInventoryAssetState,
  recoveredAssetIds: ReadonlySet<string>,
  now: number,
): RecentExpectedInventoryAssetState {
  const current = normalizeState(state, now);
  const entries = current.entries.filter((entry) => !recoveredAssetIds.has(entry.assetId));
  if (entries.length === current.entries.length) return current;
  if (!entries.length) return { cursor: 0, entries };
  const start = current.cursor;
  let nextAssetId: string | undefined;
  for (let offset = 0; offset < current.entries.length; offset += 1) {
    const candidate = current.entries[(start + offset) % current.entries.length];
    if (!recoveredAssetIds.has(candidate.assetId)) {
      nextAssetId = candidate.assetId;
      break;
    }
  }
  return {
    cursor: nextAssetId ? entries.findIndex((entry) => entry.assetId === nextAssetId) : 0,
    entries,
  };
}

function browserSessionStorage(): SessionStorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function resolveStorage(options: StoreOptions): SessionStorageLike | null {
  return Object.prototype.hasOwnProperty.call(options, 'storage')
    ? options.storage ?? null
    : browserSessionStorage();
}

function storageKey(owner: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(owner)}`;
}

function readState(owner: string, storage: SessionStorageLike, now: number): RecentExpectedInventoryAssetState {
  const key = storageKey(owner);
  let parsed: unknown;
  try {
    const raw = storage.getItem(key);
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    try {
      storage.removeItem(key);
    } catch {}
    return emptyState();
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== STORAGE_VERSION) {
    return emptyState();
  }
  return normalizeState(parsed, now);
}

function writeState(owner: string, storage: SessionStorageLike, state: RecentExpectedInventoryAssetState): void {
  const key = storageKey(owner);
  try {
    if (!state.entries.length) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify({ version: STORAGE_VERSION, ...state }));
  } catch {}
}

function stateFingerprint(state: RecentExpectedInventoryAssetState): string {
  return JSON.stringify(state);
}

export function registerRecentExpectedInventoryAssets(
  owner: string,
  cluster: string,
  assetIds: readonly string[],
  options: StoreOptions = {},
): void {
  const normalizedOwner = owner.trim();
  const storage = resolveStorage(options);
  if (!normalizedOwner || !storage || !assetIds.length || !isExpectedAssetCluster(cluster)) return;
  const now = options.now ?? Date.now();
  const state = registerRecentExpectedInventoryAssetsInState(
    readState(normalizedOwner, storage, now),
    cluster,
    assetIds,
    now,
  );
  writeState(normalizedOwner, storage, state);
}

export function takeRecentExpectedInventoryAssets(
  owner: string,
  includeDevnet: boolean,
  options: StoreOptions = {},
): ShopExpectedAssetIds | undefined {
  const normalizedOwner = owner.trim();
  const storage = resolveStorage(options);
  if (!normalizedOwner || !storage) return undefined;
  const now = options.now ?? Date.now();
  const result = takeRecentExpectedInventoryAssetsFromState(
    readState(normalizedOwner, storage, now),
    includeDevnet,
    now,
  );
  writeState(normalizedOwner, storage, result.state);
  return result.expectedAssetIds;
}

export function prepareRecentExpectedInventoryAssets(
  owner: string,
  includeDevnet: boolean,
  options: StoreOptions = {},
): RecentExpectedInventoryAssetSelection {
  const normalizedOwner = owner.trim();
  const storage = resolveStorage(options);
  if (!normalizedOwner || !storage) return { commit: () => undefined };
  const selectedAt = options.now ?? Date.now();
  const current = readState(normalizedOwner, storage, selectedAt);
  const result = takeRecentExpectedInventoryAssetsFromState(current, includeDevnet, selectedAt);
  const fingerprint = stateFingerprint(current);
  writeState(normalizedOwner, storage, current);
  return {
    ...(result.expectedAssetIds ? { expectedAssetIds: result.expectedAssetIds } : {}),
    commit: (now) => {
      const committedAt = now ?? options.now ?? Date.now();
      const latest = readState(normalizedOwner, storage, committedAt);
      if (stateFingerprint(latest) !== fingerprint) return;
      writeState(normalizedOwner, storage, normalizeState(result.state, committedAt));
    },
  };
}

export function reconcileRecentExpectedInventoryAssets(
  owner: string,
  recoveredAssetIds: Iterable<string>,
  options: StoreOptions = {},
): void {
  const normalizedOwner = owner.trim();
  const storage = resolveStorage(options);
  if (!normalizedOwner || !storage) return;
  const now = options.now ?? Date.now();
  const state = reconcileRecentExpectedInventoryAssetsInState(
    readState(normalizedOwner, storage, now),
    new Set(recoveredAssetIds),
    now,
  );
  writeState(normalizedOwner, storage, state);
}

export function shouldUseRecentExpectedInventoryAssets(owner?: string, walletOwner?: string): boolean {
  return Boolean(owner && walletOwner && owner === walletOwner);
}
