import { DurableObject } from 'cloudflare:workers';
import { decodeReturn, encodeCall } from '../../../../shared/ethereum/abi.js';
import type { EthereumStats } from '../../../../shared/ethereum/api.js';
import { ETHEREUM_FUNCTIONS, ETHEREUM_MAX_RELICS } from '../../../../shared/ethereum/protocol.js';
import { EthereumApiError } from './ethereumError.js';
import { ethereumProviderApiError, ethereumProviderBudget, withEthereumProvider } from './ethereumProvider.js';
import type { ProviderBudgetClient } from './ethereumProviderBudget.js';
import { readAlchemyOwnerIds, readEthereumCollectionStats } from './ethereumRead.js';
import { EthereumPublicReadCache, ethereumPublicReadCacheKey, ethereumPublicReadCacheName,
  type EthereumOwnerIds, type EthereumPublicCacheEvent, type EthereumPublicReadCacheEntry,
  type EthereumPublicReadCacheResult, type EthereumPublicReadCacheScope } from './ethereumPublicReadCache.js';
import { ethereumAddress, ethereumCallBatch, type EthereumCollectionReadContext } from './ethereumRuntime.js';
import { sha256Hex } from './sessionSecrets.js';

export class EthereumPublicReadCacheObject extends DurableObject<Env> {
  private readonly cache = new EthereumPublicReadCache(Date.now, event => this.observeCache(event));
  private readonly maximumRelicsVerified = new Map<string, number>();
  private providerBudgetClient: ProviderBudgetClient | undefined;
  private cacheCounts = { hit: 0, fill: 0, coalesced: 0, capacity: 0 };
  private nextCacheReportMs = Date.now() + 60_000;

  stats(scope: EthereumPublicReadCacheScope, owner: string | null): Promise<EthereumPublicReadCacheResult<EthereumPublicReadCacheEntry<EthereumStats>>> {
    return this.result(async () => {
      const wallet = owner === null ? null : ethereumAddress(owner);
      const key = this.key(scope, 'stats', wallet);
      return this.cache.readEntry(key, wallet === null ? 2_000 : 1_000, signal =>
        this.read(scope, signal, context => {
          context.relicInterfaceCheck = this.relicInterfaceAvailable(scope, context);
          return readEthereumCollectionStats(context, wallet);
        }));
    });
  }

  ownerIds(scope: EthereumPublicReadCacheScope, owner: string, cursor: string | null): Promise<EthereumPublicReadCacheResult<EthereumOwnerIds>> {
    return this.result(async () => {
      const wallet = ethereumAddress(owner);
      const key = this.key(scope, 'owner-ids', wallet, cursor);
      return this.cache.read(key, 2_000, signal =>
        readAlchemyOwnerIds(this.context(scope, signal), wallet, cursor));
    });
  }

  private key(scope: EthereumPublicReadCacheScope, operation: 'stats' | 'owner-ids', owner: string | null, cursor: string | null = null): string {
    const key = ethereumPublicReadCacheKey(scope, operation, owner, cursor);
    if (!this.ctx.id.equals(this.env.ETHEREUM_PUBLIC_READ_CACHE.idFromName(ethereumPublicReadCacheName(scope, owner)))) {
      throw new EthereumApiError('invalid-argument', 'Public Ethereum cache scope does not match its object.');
    }
    return key;
  }

  private read<T>(scope: EthereumPublicReadCacheScope, signal: AbortSignal, read: (context: EthereumCollectionReadContext) => Promise<T>): Promise<T> {
    const context = this.context(scope, signal);
    return withEthereumProvider(this.env, scope.chainId, signal, attempt => read({ ...context,
      signal: attempt.signal, providerAttempt: attempt }), { lane: 'public', budgetClient: context.providerBudgetClient });
  }

  private context(scope: EthereumPublicReadCacheScope, signal: AbortSignal): EthereumCollectionReadContext {
    return { env: this.env, nowMs: Date.now(),
      providerBudgetClient: this.providerBudgetClient ??= ethereumProviderBudget(this.env, scope.chainId),
      config: { chainId: scope.chainId, contractAddress: scope.contractAddress.toLowerCase(), enabled: true,
        metadataBaseUri: scope.metadataBaseUri, deploymentBlock: scope.deploymentBlock },
      signal, fetch: (input, init) => fetch(input, init) };
  }

  private async relicInterfaceAvailable(scope: EthereumPublicReadCacheScope, context: EthereumCollectionReadContext): Promise<boolean> {
    const now = Date.now();
    const key = await sha256Hex(JSON.stringify([scope.chainId, scope.contractAddress.toLowerCase(), scope.deploymentId,
      context.providerAttempt?.provider, context.providerAttempt?.url]));
    const checkMaximum = (this.maximumRelicsVerified.get(key) ?? 0) <= now;
    const calls = [encodeCall(ETHEREUM_FUNCTIONS.relicClaimedMask, [], [])];
    if (checkMaximum) calls.push(encodeCall('MAX_RELICS()', [], []));
    const [mask, maximum] = await ethereumCallBatch(context, calls);
    if (checkMaximum) {
      if (maximum.length !== 66 || decodeReturn(['uint256'], maximum)[0] !== BigInt(ETHEREUM_MAX_RELICS)) return false;
      for (const [cachedKey, expiresAtMs] of this.maximumRelicsVerified) if (expiresAtMs <= now) this.maximumRelicsVerified.delete(cachedKey);
      while (this.maximumRelicsVerified.size >= 8) this.maximumRelicsVerified.delete(this.maximumRelicsVerified.keys().next().value!);
      this.maximumRelicsVerified.set(key, now + 600_000);
    }
    return mask.length === 66 && (decodeReturn(['uint256'], mask)[0] as bigint) < 1n << BigInt(ETHEREUM_MAX_RELICS);
  }

  private observeCache(event: EthereumPublicCacheEvent): void {
    this.cacheCounts[event.result]++;
    if (Date.now() < this.nextCacheReportMs) return;
    console.log({ event: 'ethereum_public_read_cache', ...this.cacheCounts, entries: event.entries, fills: event.fills });
    this.cacheCounts = { hit: 0, fill: 0, coalesced: 0, capacity: 0 };
    this.nextCacheReportMs = Date.now() + 60_000;
  }

  private async result<T>(read: () => Promise<T>): Promise<EthereumPublicReadCacheResult<T>> {
    try { return { ok: true, value: await read() }; }
    catch (error) {
      const failure = error instanceof EthereumApiError ? error : ethereumProviderApiError(error);
      return { ok: false, error: { code: failure.code, message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) } };
    }
  }
}
