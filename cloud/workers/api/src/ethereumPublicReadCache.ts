import type { EthereumStats } from '../../../../shared/ethereum/api.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { ApiErrorCode } from './dataAccess.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import { EthereumApiError } from './ethereumError.js';
import { ethereumAddress, type EthereumCollectionReadContext } from './ethereumRuntime.js';

export type EthereumPublicReadCacheScope = Pick<EthereumRevealDeployment,
  'chainId' | 'contractAddress' | 'deploymentId' | 'revision' | 'metadataBaseUri' | 'deploymentBlock'> & {
  catalogRevision: number;
  catalogUpdateId: string | null;
};

export type EthereumOwnerIds = { ids: string[]; nextCursor: string | null };
export type EthereumPublicReadCacheEntry<T> = { value: T; expiresAtMs: number };
export type EthereumPublicReadCacheResult<T> = { ok: true; value: T } | {
  ok: false;
  error: { code: ApiErrorCode; message: string; details?: unknown };
};

export type EthereumPublicReadCacheBinding = {
  getByName(name: string): {
    stats(scope: EthereumPublicReadCacheScope, owner: string | null): Promise<EthereumPublicReadCacheResult<EthereumPublicReadCacheEntry<EthereumStats>>>;
    ownerIds(scope: EthereumPublicReadCacheScope, owner: string, cursor: string | null): Promise<EthereumPublicReadCacheResult<EthereumOwnerIds>>;
  };
};

const CACHE_LIMIT = 1024;
const FILL_LIMIT = 64;
const FILL_TIMEOUT_MS = 20_000;
export type EthereumPublicCacheEvent = { result: 'hit' | 'fill' | 'coalesced' | 'capacity'; entries: number; fills: number };

export class EthereumPublicReadCache {
  private readonly entries = new Map<string, EthereumPublicReadCacheEntry<unknown>>();
  private readonly fills = new Map<string, Promise<EthereumPublicReadCacheEntry<unknown>>>();

  constructor(private readonly now: () => number = Date.now, private readonly observe?: (event: EthereumPublicCacheEvent) => void) {}

  private observed(result: EthereumPublicCacheEvent['result']): void {
    this.observe?.({ result, entries: this.entries.size, fills: this.fills.size });
  }

  async read<T>(key: string, ttlMs: number, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return (await this.readEntry(key, ttlMs, load)).value;
  }

  async readEntry<T>(key: string, ttlMs: number, load: (signal: AbortSignal) => Promise<T>): Promise<EthereumPublicReadCacheEntry<T>> {
    const now = this.now();
    const cached = this.entries.get(key);
    if (cached && now < cached.expiresAtMs) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.observed('hit');
      return structuredClone(cached) as EthereumPublicReadCacheEntry<T>;
    }
    this.entries.delete(key);
    const current = this.fills.get(key);
    if (current) {
      this.observed('coalesced');
      return structuredClone(await current) as EthereumPublicReadCacheEntry<T>;
    }
    if (this.fills.size >= FILL_LIMIT) {
      this.observed('capacity');
      throw new EthereumApiError('unavailable', 'Public Ethereum reads are busy. Try again shortly.');
    }
    const timeout = createTimedAbortScope(undefined, { timeoutMs: FILL_TIMEOUT_MS, timeoutMessage: 'Public Ethereum read timed out.' });
    const pending = Promise.resolve().then(() => raceWithSignal(load(timeout.signal), timeout.signal)).then(value => {
      timeout.signal.throwIfAborted();
      const completedAtMs = this.now();
      const retainedExpiresAtMs = now + ttlMs;
      if (completedAtMs < retainedExpiresAtMs) {
        for (const [entryKey, entry] of this.entries) if (entry.expiresAtMs <= this.now()) this.entries.delete(entryKey);
        while (this.entries.size >= CACHE_LIMIT) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, { value: structuredClone(value), expiresAtMs: retainedExpiresAtMs });
      }
      return { value, expiresAtMs: completedAtMs + ttlMs };
    }).finally(() => {
      timeout.dispose();
      if (this.fills.get(key) === pending) this.fills.delete(key);
    });
    this.fills.set(key, pending);
    this.observed('fill');
    return structuredClone(await pending);
  }
}

export function ethereumPublicReadCacheScope(deployment: EthereumRevealDeployment): EthereumPublicReadCacheScope {
  return { chainId: deployment.chainId, contractAddress: deployment.contractAddress, deploymentId: deployment.deploymentId,
    revision: deployment.revision, catalogRevision: deployment.catalogRevision ?? 0, catalogUpdateId: deployment.catalogUpdateId ?? null,
    metadataBaseUri: deployment.metadataBaseUri, deploymentBlock: deployment.deploymentBlock };
}

export function ethereumPublicReadCacheName(scope: EthereumPublicReadCacheScope, owner: string | null): string {
  return `${scope.chainId}:${scope.contractAddress.toLowerCase()}:${scope.deploymentId}:${owner === null ? 'common' : `wallet-${owner.slice(-1).toLowerCase()}`}`;
}

export function ethereumPublicReadCacheKey(scope: EthereumPublicReadCacheScope, operation: 'stats' | 'owner-ids',
  owner: string | null, cursor: string | null = null): string {
  if (![1, 11155111].includes(scope.chainId) || !scope.deploymentId ||
    !Number.isSafeInteger(scope.revision) || scope.revision < 1 ||
    !Number.isSafeInteger(scope.catalogRevision) || scope.catalogRevision < 0 ||
    !Number.isSafeInteger(scope.deploymentBlock) || scope.deploymentBlock < 0 ||
    (cursor !== null && cursor.length > 4096)) throw new EthereumApiError('invalid-argument', 'Invalid public Ethereum cache scope.');
  return JSON.stringify([scope.chainId, ethereumAddress(scope.contractAddress), scope.deploymentId, scope.revision,
    scope.catalogRevision, scope.catalogUpdateId, scope.metadataBaseUri, scope.deploymentBlock, operation,
    owner === null ? null : ethereumAddress(owner), cursor]);
}

async function readCached<T>(operation: Promise<EthereumPublicReadCacheResult<T>>, signal: AbortSignal): Promise<T> {
  try {
    const result = await raceWithSignal(operation, signal);
    if (!result.ok) throw new EthereumApiError(result.error.code, result.error.message, result.error.details);
    return result.value;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof EthereumApiError) throw error;
    throw new EthereumApiError('unavailable', 'Public Ethereum reads are temporarily unavailable.');
  }
}

export function cachedEthereumCollectionStats(context: EthereumCollectionReadContext, owner: string | null): Promise<EthereumStats> | undefined {
  if (context.env.ETHEREUM_PUBLIC_READ_CACHE_ENABLED === 'false') return;
  const scope = context.publicReadCacheScope;
  const namespace = context.env.ETHEREUM_PUBLIC_READ_CACHE;
  if (!scope || !namespace || ![1, 11155111].includes(scope.chainId)) return;
  context.signal.throwIfAborted();
  const normalizedOwner = owner === null ? null : ethereumAddress(owner);
  const object = namespace.getByName(ethereumPublicReadCacheName(scope, normalizedOwner));
  return readCached(object.stats(scope, normalizedOwner), context.signal).then(entry => {
    if (!Number.isSafeInteger(entry.expiresAtMs)) throw new EthereumApiError('unavailable', 'Public Ethereum reads are temporarily unavailable.');
    context.publicReadCacheExpiresAtMs = entry.expiresAtMs;
    return entry.value;
  });
}

export function cachedAlchemyOwnerIds(context: EthereumCollectionReadContext, owner: string, cursor: string | null): Promise<EthereumOwnerIds> | undefined {
  if (context.env.ETHEREUM_PUBLIC_READ_CACHE_ENABLED === 'false') return;
  const scope = context.publicReadCacheScope;
  const namespace = context.env.ETHEREUM_PUBLIC_READ_CACHE;
  if (!scope || !namespace || ![1, 11155111].includes(scope.chainId)) return;
  context.signal.throwIfAborted();
  const normalizedOwner = ethereumAddress(owner);
  const object = namespace.getByName(ethereumPublicReadCacheName(scope, normalizedOwner));
  return readCached(object.ownerIds(scope, normalizedOwner, cursor), context.signal);
}
