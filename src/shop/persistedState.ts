import type { FrontendDeploymentConfig } from '../config/deployment';

export type LocalPendingReveal = {
  id: string;
  createdAt: number;
  dropId?: string;
  name?: string;
  image?: string;
  boxId?: string;
};

export type ShopStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export const DISCOUNT_USED_STORAGE_PREFIX = 'monsDiscountUsed';

function browserStorage(): ShopStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

export function hiddenInventoryKey(wallet?: string): string {
  return wallet ? `monsHiddenAssets:${wallet}` : 'monsHiddenAssets:disconnected';
}

export function loadHiddenAssets(
  wallet?: string,
  storage: ShopStorage | null = browserStorage(),
): Set<string> {
  if (!wallet || !storage) return new Set();
  try {
    const raw = storage.getItem(hiddenInventoryKey(wallet));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value) => typeof value === 'string' && value));
  } catch {
    return new Set();
  }
}

export function persistHiddenAssets(
  wallet: string,
  ids: ReadonlySet<string>,
  storage: ShopStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(hiddenInventoryKey(wallet), JSON.stringify(Array.from(ids)));
  } catch {}
}

export function pendingRevealKey(wallet?: string): string {
  return wallet ? `monsPendingReveals:${wallet}` : 'monsPendingReveals:disconnected';
}

export function loadPendingReveals(
  wallet?: string,
  storage: ShopStorage | null = browserStorage(),
): LocalPendingReveal[] {
  if (!wallet || !storage) return [];
  try {
    const raw = storage.getItem(pendingRevealKey(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: LocalPendingReveal[] = [];
    parsed.forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const id = typeof entry.id === 'string' ? entry.id : '';
      const createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : 0;
      if (!id || !createdAt) return;
      const dropId = typeof entry.dropId === 'string' ? entry.dropId : undefined;
      const name = typeof entry.name === 'string' ? entry.name : undefined;
      const image = typeof entry.image === 'string' ? entry.image : undefined;
      const boxId = typeof entry.boxId === 'string' ? entry.boxId : undefined;
      entries.push({ id, createdAt, dropId, name, image, boxId });
    });
    return entries;
  } catch {
    return [];
  }
}

export function persistPendingReveals(
  wallet: string,
  entries: readonly LocalPendingReveal[],
  storage: ShopStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(pendingRevealKey(wallet), JSON.stringify(entries));
  } catch {}
}

export function recentRevealKey(wallet?: string): string {
  return wallet ? `monsRecentReveals:${wallet}` : 'monsRecentReveals:disconnected';
}

export function loadRecentReveals(
  wallet?: string,
  storage: ShopStorage | null = browserStorage(),
): string[] {
  if (!wallet || !storage) return [];
  try {
    const raw = storage.getItem(recentRevealKey(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === 'string' && id);
  } catch {
    return [];
  }
}

export function persistRecentReveals(
  wallet: string,
  ids: readonly string[],
  storage: ShopStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(recentRevealKey(wallet), JSON.stringify(ids));
  } catch {}
}

export function discountUsedVersion(
  drop: Pick<FrontendDeploymentConfig, 'dropId' | 'boxMinterProgramId' | 'discountMerkleRoot' | 'discountMintsPerWallet'>,
): string {
  return `${String(drop.dropId || '').trim().toLowerCase()}:${drop.boxMinterProgramId}:${drop.discountMerkleRoot}:${drop.discountMintsPerWallet}`;
}

export function discountUsedScope(drop: Pick<FrontendDeploymentConfig, 'dropId'>): string {
  return `${DISCOUNT_USED_STORAGE_PREFIX}:${String(drop.dropId || '').trim().toLowerCase()}`;
}

export function discountUsedKey(version: string, wallet?: string): string {
  return wallet
    ? `${DISCOUNT_USED_STORAGE_PREFIX}:${version}:${wallet}`
    : `${DISCOUNT_USED_STORAGE_PREFIX}:${version}:disconnected`;
}

function cleanupDiscountUsedKeys(
  scopePrefix: string,
  wallet: string,
  keepKey: string,
  storage: ShopStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    const keysToRemove: string[] = [];
    const walletSuffix = `:${wallet}`;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !key.startsWith(`${scopePrefix}:`)) continue;
      if (!key.endsWith(walletSuffix)) continue;
      if (key !== keepKey) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => storage.removeItem(key));
  } catch {}
}

function parseDiscountUsedCount(raw: string | null | undefined): number {
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 1) return 0;
  return parsed;
}

export function loadDiscountUsedCount(
  scopePrefix: string,
  version: string,
  wallet?: string,
  storage: ShopStorage | null = browserStorage(),
): number {
  if (!wallet || !storage) return 0;
  const key = discountUsedKey(version, wallet);
  cleanupDiscountUsedKeys(scopePrefix, wallet, key, storage);
  try {
    return parseDiscountUsedCount(storage.getItem(key));
  } catch {
    return 0;
  }
}

export function persistDiscountUsedCount(
  scopePrefix: string,
  version: string,
  wallet: string,
  usedCount: number,
  storage: ShopStorage | null = browserStorage(),
): void {
  if (!storage) return;
  const key = discountUsedKey(version, wallet);
  cleanupDiscountUsedKeys(scopePrefix, wallet, key, storage);
  try {
    if (usedCount > 0) {
      storage.setItem(key, String(usedCount));
    } else {
      storage.removeItem(key);
    }
  } catch {}
}
