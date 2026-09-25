import bs58 from 'bs58';
import {
  HELIUS_COLLECTION_GROUPING_OPTIONS,
  uniqueAssetGroupingCollectionMint,
} from '../../../../shared/dasAssetCollections.js';
import type { DasAsset } from '../../../../shared/dasAsset.js';
import {
  HELIUS_SEARCH_ASSETS_PAGE_LIMITS,
  heliusSearchAssetsCursorPageInfo,
  heliusSearchAssetsItems,
} from '../../../../shared/heliusDas.js';
import { PENDING_OPEN_BOX_DISCRIMINATOR } from '../../../../shared/pendingOpenCodec.js';
import {
  isExactShopInventoryRequest,
  isExactShopPendingOpenBoxesRequest,
  SHOP_API_MAX_RESPONSE_ITEMS,
  type ShopExpectedAssetIds,
  type ShopInventoryRequest,
  type ShopInventoryItem,
  type ShopInventoryResponse,
  type ShopPendingOpenBoxesRequest,
  type ShopPendingOpenBoxesResponse,
} from '../../../../shared/shopApi.js';
import {
  decodePendingOpenRecordData,
  listShopInventoryCollectionScopes,
  listShopPendingOpenProgramScopes,
  resolvePendingOpenDropId,
  toShopPendingOpenBox,
  transformShopInventoryItem,
  type PendingOpenRecordCandidate,
  type ShopInventoryCollectionScope,
} from '../../../../shared/shopDomain.js';
import type { SolanaCluster } from '../../../../shared/deploymentCore.js';
import { DEPLOYMENT_DROPS } from '../../../../shared/deploymentRegistry.js';
import { isBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import { getPreorderConfig, preorderIdFromMetadataUri, preorderImageUrl } from '../../../../shared/preorders.js';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.js';
import { decodePreorderAssetAccount } from './preorderTransaction.js';
import { listSucceededPreorderAssets } from './preorderStore.js';
import { MAX_INVENTORY_SERIALIZED_ITEM_BYTES } from './inventoryLimits.js';
import {
  PUBLIC_RATE_LIMITS,
  applyPublicCors,
  observePublicRateLimit,
  publicRequestOrigin,
} from './publicRequestPolicy.js';
import {
  createRequestDeadline,
  isRequestCancellationError,
  raceWithSignal,
} from './boundedRequest.js';
import {
  BASE_HEADERS,
  parseJsonRequestBody,
  publicJsonResponse,
  publicOriginDeniedResponse,
  type WorkerDependencies,
  type WorkerRequestMetrics,
} from './publicRouteSupport.js';
import {
  ProviderFailure,
  ProviderReadGate,
  createAttemptScope,
  heliusRpc,
  type ProviderContext,
} from './shopInventoryProvider.js';

const HELIUS_BATCH_LIMIT = 1000;

const PROVIDER_CONCURRENCY = 3;

const PENDING_OPEN_DISCRIMINATOR_BASE58 = bs58.encode(PENDING_OPEN_BOX_DISCRIMINATOR);

type ShopInventoryDependencies = ProviderContext['dependencies'] & Pick<WorkerDependencies,
  | 'log'
  | 'providerTimeoutMs'
  | 'validateInventoryResponse'
  | 'validatePendingOpenBoxesResponse'
>;

type GroupedInventoryResult = {
  scope: ShopInventoryCollectionScope;
  items: ShopInventoryItem[];
  needsFallback: boolean;
};

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function inventoryItemWithinLimit(item: ShopInventoryItem): boolean {
  return utf8ByteLength(JSON.stringify(item)) <= MAX_INVENTORY_SERIALIZED_ITEM_BYTES;
}

function compactInventoryItem(item: ShopInventoryItem): ShopInventoryItem {
  const {
    attributes: _attributes,
    ...withoutAttributes
  } = item as ShopInventoryItem & { attributes?: unknown };
  if (inventoryItemWithinLimit(withoutAttributes)) return withoutAttributes;
  const { rawImage: _rawImage, ...withoutImage } = withoutAttributes;
  if (inventoryItemWithinLimit(withoutImage)) return withoutImage;
  const { boxId: _boxId, ...withoutBoxId } = withoutImage;
  if (inventoryItemWithinLimit(withoutBoxId)) return withoutBoxId;
  const withFallbackName = { ...withoutBoxId, name: withoutBoxId.id };
  if (inventoryItemWithinLimit(withFallbackName)) return withFallbackName;
  throw new ProviderFailure('unavailable');
}

async function parseShopRequestBody<T extends ShopInventoryRequest | ShopPendingOpenBoxesRequest>(
  request: Request,
  validate: (value: unknown) => value is T,
): Promise<T> {
  const value = await parseJsonRequestBody(request, validate);
  if (!isBase58Bytes(value.owner, 32)) throw new Error('invalid-request');
  return value;
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseSearchAssetsResult(value: unknown): { raw: unknown; items: DasAsset[] } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) throw new ProviderFailure('unavailable');
  return { raw: value, items: heliusSearchAssetsItems<DasAsset>(value) };
}

function compactInventoryPage(
  context: ProviderContext,
  assets: DasAsset[],
  cluster: SolanaCluster,
  seenIds: Set<string>,
  owner: string,
  collections: ReadonlySet<string>,
): ShopInventoryItem[] {
  context.inventoryCandidates += assets.length;
  if (context.inventoryCandidates > context.dependencies.inventoryMaxCandidates) {
    throw new ProviderFailure('limit');
  }
  const items: ShopInventoryItem[] = [];
  for (const asset of assets) {
    if (typeof asset?.id !== 'string' || !isBase58Bytes(asset.id, 32) || seenIds.has(asset.id)) {
      throw new ProviderFailure('unavailable');
    }
    seenIds.add(asset.id);
    const collection = uniqueAssetGroupingCollectionMint(asset);
    if (!collection || !collections.has(collection)) continue;
    const item = transformShopInventoryItem(asset, cluster);
    if (!item) continue;
    if (item.kind === 'preorder' && asset.ownership?.owner !== owner) continue;
    items.push(compactInventoryItem(item));
  }
  return items;
}

function decodePendingOpenRecordCandidate(
  entry: unknown,
  owner: string,
  scope: ReturnType<typeof listShopPendingOpenProgramScopes>[number],
): PendingOpenRecordCandidate {
  if (!entry || typeof entry !== 'object') throw new ProviderFailure('unavailable');
  const record = entry as Record<string, unknown>;
  const pendingPda = typeof record.pubkey === 'string' ? record.pubkey : '';
  const account = record.account && typeof record.account === 'object'
    ? record.account as Record<string, unknown>
    : null;
  const dataField = account?.data;
  const dataBase64 = Array.isArray(dataField) && typeof dataField[0] === 'string'
    ? dataField[0]
    : typeof dataField === 'string' ? dataField : '';
  if (
    !isBase58Bytes(pendingPda, 32) ||
    !dataBase64 ||
    (Array.isArray(dataField) && dataField[1] !== undefined && dataField[1] !== 'base64')
  ) throw new ProviderFailure('unavailable');
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(dataBase64), (character) => character.charCodeAt(0));
  } catch {
    throw new ProviderFailure('unavailable');
  }
  const decoded = decodePendingOpenRecordData(bytes, scope);
  if (!decoded || decoded.owner !== owner) throw new ProviderFailure('unavailable');
  return {
    solanaCluster: scope.solanaCluster,
    pendingPda,
    boxAssetId: decoded.boxAssetId,
    dudeAssetIds: decoded.dudeAssetIds,
    candidateDrops: scope.drops,
    ...(decoded.createdSlot != null ? { createdSlot: decoded.createdSlot } : {}),
    ...(decoded.configPda ? { configPda: decoded.configPda } : {}),
  };
}

async function fetchGroupedInventoryScope(
  context: ProviderContext,
  owner: string,
  scope: ShopInventoryCollectionScope,
): Promise<GroupedInventoryResult> {
  const progress = { receivedResult: false };
  try {
    const items = await fetchInventoryCursorChain(
      context,
      owner,
      scope.solanaCluster,
      new Set([scope.collectionMint]),
      ['collection', scope.collectionMint],
      progress,
    );
    return { scope, items, needsFallback: false };
  } catch (error) {
    if (
      !progress.receivedResult &&
      !context.signal.aborted &&
      error instanceof ProviderFailure &&
      (error.kind === 'unavailable' || error.kind === 'timeout')
    ) {
      return { scope, items: [], needsFallback: true };
    }
    throw error;
  }
}

async function fetchInventoryCursorChain(
  context: ProviderContext,
  owner: string,
  cluster: SolanaCluster,
  collections: ReadonlySet<string>,
  grouping?: ['collection', string],
  progress?: { receivedResult: boolean },
): Promise<ShopInventoryItem[]> {
  const items: ShopInventoryItem[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageLimitIndex = 0;
  let hasPageReservation = false;
  while (true) {
    if (!hasPageReservation) {
      if (context.inventoryCursorPages >= context.dependencies.inventoryMaxCursorPages) {
        throw new ProviderFailure('limit');
      }
      context.inventoryCursorPages += 1;
      hasPageReservation = true;
    }
    const limit = HELIUS_SEARCH_ASSETS_PAGE_LIMITS[pageLimitIndex];
    let parsed: { raw: unknown; items: DasAsset[] };
    try {
      const result = await heliusRpc(
        context,
        cluster,
        'searchAssets',
        {
          ownerAddress: owner,
          ...(grouping ? { grouping } : {}),
          tokenType: 'nonFungible',
          limit,
          ...(cursor ? { cursor } : {}),
          sortBy: { sortBy: 'id', sortDirection: 'asc' },
          burnt: false,
          options: HELIUS_COLLECTION_GROUPING_OPTIONS,
        },
        { inventoryCall: true, pageOverflowIsRetryable: true },
      );
      if (progress) progress.receivedResult = true;
      parsed = parseSearchAssetsResult(result);
    } catch (error) {
      if (error instanceof ProviderFailure && error.kind === 'page-too-large') {
        if (pageLimitIndex + 1 < HELIUS_SEARCH_ASSETS_PAGE_LIMITS.length) {
          pageLimitIndex += 1;
          continue;
        }
        throw new ProviderFailure('unavailable');
      }
      throw error;
    }
    let pageInfo: ReturnType<typeof heliusSearchAssetsCursorPageInfo>;
    try {
      pageInfo = heliusSearchAssetsCursorPageInfo(
        parsed.raw,
        parsed.items.length,
        limit,
        seenCursors,
      );
    } catch {
      throw new ProviderFailure('unavailable');
    }
    items.push(...compactInventoryPage(context, parsed.items, cluster, seenIds, owner, collections));
    if (!pageInfo.hasMore) return items;
    seenCursors.add(pageInfo.cursor);
    cursor = pageInfo.cursor;
    hasPageReservation = false;
  }
}

async function fetchUngroupedInventory(
  context: ProviderContext,
  owner: string,
  cluster: SolanaCluster,
  collections: ReadonlySet<string>,
): Promise<ShopInventoryItem[]> {
  return fetchInventoryCursorChain(context, owner, cluster, collections);
}

async function fetchInventoryCollections(
  context: ProviderContext,
  owner: string,
  scopes: readonly ShopInventoryCollectionScope[],
): Promise<Map<string, ShopInventoryItem>> {
  const grouped = await mapConcurrent(scopes, PROVIDER_CONCURRENCY, (scope) =>
    fetchGroupedInventoryScope(context, owner, scope));
  const fallbackClusters = Array.from(new Set(
    grouped.filter((entry) => entry.needsFallback).map((entry) => entry.scope.solanaCluster),
  ));
  const fallbackRows = await mapConcurrent(fallbackClusters, PROVIDER_CONCURRENCY, async (cluster) => ({
    cluster,
    items: await fetchUngroupedInventory(context, owner, cluster, new Set(scopes.filter((scope) => scope.solanaCluster === cluster).map((scope) => scope.collectionMint))),
  }));
  const itemsById = new Map<string, ShopInventoryItem>();
  for (const result of grouped) {
    for (const item of result.items) itemsById.set(item.id, item);
  }
  for (const fallback of fallbackRows) {
    for (const item of fallback.items) itemsById.set(item.id, item);
  }
  return itemsById;
}

async function fetchInventory(
  context: ProviderContext,
  requestBody: ShopInventoryRequest,
  commerceDb: D1Database,
): Promise<ShopInventoryResponse> {
  const expectedGroups = expectedAssetGroups(requestBody.expectedAssetIds);
  context.metrics.expectedAssetIds = expectedGroups.reduce((total, group) => total + group.ids.length, 0);
  const scopes = listShopInventoryCollectionScopes(requestBody.includeDevnet === true);
  const optionalScopes = scopes.filter((scope) => scope.solanaCluster === 'devnet' &&
    !Object.values(DEPLOYMENT_DROPS).some((drop) =>
      drop.solanaCluster === scope.solanaCluster && drop.collectionMint === scope.collectionMint));
  const requiredScopes = scopes.filter((scope) => !optionalScopes.includes(scope));
  const itemsById = await fetchInventoryCollections(context, requestBody.owner, requiredScopes);
  await mergeExpectedInventoryItems(context, requestBody.owner, expectedGroups.filter((group) =>
    requiredScopes.some((scope) => scope.solanaCluster === group.cluster)), itemsById, scopes);

  const optionalScope = createAttemptScope(context.signal, context.dependencies.expectedAssetRecoveryTimeoutMs);
  const optionalContext: ProviderContext = {
    ...context,
    signal: optionalScope.signal,
    providerResponseBodyBytes: 0,
    inventoryCandidates: 0,
    inventoryCursorPages: 0,
    inventoryProviderCalls: 0,
    providerReadGate: new ProviderReadGate(),
  };
  let optionalItems: Map<string, ShopInventoryItem> | undefined;
  try {
    optionalItems = await fetchInventoryCollections(optionalContext, requestBody.owner, optionalScopes);
    await mergeExpectedInventoryItems(optionalContext, requestBody.owner, expectedGroups.filter((group) =>
      !requiredScopes.some((scope) => scope.solanaCluster === group.cluster) &&
      optionalScopes.some((scope) => scope.solanaCluster === group.cluster)), optionalItems, optionalScopes);
    await mergeRecentPreorderItems(optionalContext, requestBody.owner, commerceDb, optionalItems);
  } catch {
    context.metrics.expectedAssetRecoveryFailures += 1;
  } finally {
    optionalScope.dispose();
  }
  if (optionalItems) {
    const combined = new Map([...itemsById, ...optionalItems]);
    if (combined.size <= SHOP_API_MAX_RESPONSE_ITEMS &&
      utf8ByteLength(JSON.stringify({ ok: true, items: Array.from(combined.values()) })) <= context.dependencies.inventoryMaxResponseBodyBytes) {
      return { ok: true, items: Array.from(combined.values()) };
    }
    context.metrics.expectedAssetRecoveryFailures += 1;
  }
  return { ok: true, items: Array.from(itemsById.values()) };
}

async function mergeRecentPreorderItems(
  context: ProviderContext,
  owner: string,
  db: D1Database,
  items: Map<string, ShopInventoryItem>,
): Promise<void> {
  const recoveryScope = createAttemptScope(context.signal, context.dependencies.expectedAssetRecoveryTimeoutMs);
  try {
    const recent = await raceWithSignal(listSucceededPreorderAssets(db, owner), recoveryScope.signal);
    const missing = recent.filter((asset) => !items.has(asset.address)).slice(0, 15);
    if (!missing.length) return;
    for (const cluster of new Set(missing.map((asset) => getPreorderConfig(asset.preorderId)?.cluster))) {
      if (!cluster) continue;
      const assets = missing.filter((asset) => getPreorderConfig(asset.preorderId)?.cluster === cluster);
      if (context.inventoryCandidates + assets.length > context.dependencies.inventoryMaxCandidates) {
        context.metrics.expectedAssetRecoveryFailures += 1;
        continue;
      }
      context.inventoryCandidates += assets.length;
      const result = await heliusRpc<{ context: { slot: number }; value: ({ owner: string; executable: boolean; data: [string, string] } | null)[] }>(
        context, cluster, 'getMultipleAccounts', [assets.map((asset) => asset.address), { commitment: 'finalized', encoding: 'base64' }],
        { signal: recoveryScope.signal, inventoryCall: true, maxAttempts: 1 },
      );
      if (!Number.isSafeInteger(result?.context?.slot) || !Array.isArray(result?.value) || result.value.length !== assets.length) throw new ProviderFailure('unavailable');
      const recovered = new Map(items);
      result.value.forEach((account, index) => {
        if (!account || account.owner !== MPL_CORE_PROGRAM_ADDRESS || account.executable !== false || !Array.isArray(account.data) || typeof account.data[0] !== 'string' || account.data[1] !== 'base64') return;
        const asset = assets[index];
        const config = getPreorderConfig(asset.preorderId);
        if (!config?.enabled) return;
        const decoded = decodePreorderAssetAccount(Buffer.from(account.data[0], 'base64'));
        if (!decoded || decoded.owner !== owner || decoded.collection !== config.collection || preorderIdFromMetadataUri(config, decoded.uri) !== asset.id) return;
        recovered.set(asset.address, {
          id: asset.address, dropId: config.preorderId, name: `Preorder #${asset.id}`, kind: 'preorder',
          preorderId: asset.id, rawImage: preorderImageUrl(config, asset.id),
        });
      });
      if (recovered.size > SHOP_API_MAX_RESPONSE_ITEMS || utf8ByteLength(JSON.stringify({ ok: true, items: Array.from(recovered.values()) })) > context.dependencies.inventoryMaxResponseBodyBytes) {
        context.metrics.expectedAssetRecoveryFailures += 1;
        continue;
      }
      for (const [id, item] of recovered) items.set(id, item);
    }
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason;
    context.metrics.expectedAssetRecoveryFailures += 1;
  } finally {
    recoveryScope.dispose();
  }
}

async function fetchPendingProgramScope(
  context: ProviderContext,
  owner: string,
  scope: ReturnType<typeof listShopPendingOpenProgramScopes>[number],
): Promise<PendingOpenRecordCandidate[]> {
  const result = await heliusRpc<unknown>(context, scope.solanaCluster, 'getProgramAccounts', [
    scope.boxMinterProgramId,
    {
      commitment: 'confirmed',
      encoding: 'base64',
      filters: [
        { memcmp: { offset: 0, bytes: PENDING_OPEN_DISCRIMINATOR_BASE58 } },
        { memcmp: { offset: 8, bytes: owner } },
      ],
    },
  ]);
  if (!Array.isArray(result)) throw new ProviderFailure('unavailable');
  return result.map((entry) => decodePendingOpenRecordCandidate(entry, owner, scope));
}

async function fetchAssetBatch(
  context: ProviderContext,
  cluster: SolanaCluster,
  ids: string[],
  options: {
    assetBatchNotFoundIsRecoverable?: boolean;
    attemptTimeoutMs?: number;
    includeUnverifiedCollections?: boolean;
    inventoryCall?: boolean;
    maxAttempts?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Map<string, DasAsset>> {
  const { includeUnverifiedCollections = true, ...rpcOptions } = options;
  const byId = new Map<string, DasAsset>();
  for (let offset = 0; offset < ids.length; offset += HELIUS_BATCH_LIMIT) {
    const batchIds = ids.slice(offset, offset + HELIUS_BATCH_LIMIT);
    const requestedIds = new Set(batchIds);
    const result = await heliusRpc<unknown>(context, cluster, 'getAssetBatch', {
      ids: batchIds,
      ...(includeUnverifiedCollections ? { options: HELIUS_COLLECTION_GROUPING_OPTIONS } : {}),
    }, rpcOptions);
    if (!Array.isArray(result) || result.length > batchIds.length) {
      throw new ProviderFailure('unavailable');
    }
    for (const asset of result) {
      if (asset === null) continue;
      if (!asset || typeof asset !== 'object') throw new ProviderFailure('unavailable');
      const assetId = (asset as DasAsset).id;
      if (typeof assetId !== 'string' || !requestedIds.has(assetId) || byId.has(assetId)) {
        throw new ProviderFailure('unavailable');
      }
      byId.set(assetId, asset as DasAsset);
    }
  }
  return byId;
}

type ExpectedAssetGroup = {
  cluster: SolanaCluster;
  ids: string[];
};

function expectedAssetGroups(expectedAssetIds?: ShopExpectedAssetIds): ExpectedAssetGroup[] {
  if (!expectedAssetIds) return [];
  const groups: ExpectedAssetGroup[] = [];
  if (expectedAssetIds['mainnet-beta']?.length) {
    groups.push({ cluster: 'mainnet-beta', ids: expectedAssetIds['mainnet-beta'] });
  }
  if (expectedAssetIds.devnet?.length) groups.push({ cluster: 'devnet', ids: expectedAssetIds.devnet });
  return groups;
}

function recoveredExpectedInventoryItem(
  asset: DasAsset,
  owner: string,
  cluster: SolanaCluster,
  scopes: readonly ShopInventoryCollectionScope[],
): ShopInventoryItem | null {
  if (asset?.interface !== 'MplCoreAsset' || asset?.burnt !== false) return null;
  const assetOwner = asset?.ownership?.owner;
  if (typeof assetOwner !== 'string' || !isBase58Bytes(assetOwner, 32) || assetOwner !== owner) return null;
  const collectionMint = uniqueAssetGroupingCollectionMint(asset);
  if (!collectionMint) return null;
  const collectionIsRegistered = scopes.some((scope) =>
    scope.solanaCluster === cluster && scope.collectionMint === collectionMint);
  if (!collectionIsRegistered) return null;
  const item = transformShopInventoryItem(asset, cluster);
  if (!item) return null;
  return compactInventoryItem(item);
}

async function fetchExpectedAssetGroup(
  context: ProviderContext,
  cluster: SolanaCluster,
  ids: string[],
  signal: AbortSignal,
): Promise<{ assetsById: Map<string, DasAsset>; failures: number }> {
  try {
    return {
      assetsById: await fetchAssetBatch(context, cluster, ids, {
        assetBatchNotFoundIsRecoverable: true,
        attemptTimeoutMs: context.dependencies.expectedAssetRecoveryTimeoutMs,
        includeUnverifiedCollections: false,
        inventoryCall: true,
        maxAttempts: 1,
        signal,
      }),
      failures: 0,
    };
  } catch (error) {
    if (context.signal.aborted && error === context.signal.reason) throw error;
    if (error instanceof ProviderFailure && error.kind === 'asset-not-found' && ids.length > 1) {
      const midpoint = Math.floor(ids.length / 2);
      const left = await fetchExpectedAssetGroup(context, cluster, ids.slice(0, midpoint), signal);
      const right = await fetchExpectedAssetGroup(context, cluster, ids.slice(midpoint), signal);
      for (const [id, asset] of right.assetsById) left.assetsById.set(id, asset);
      return { assetsById: left.assetsById, failures: left.failures + right.failures };
    }
    return { assetsById: new Map(), failures: 1 };
  }
}

async function mergeExpectedInventoryItems(
  context: ProviderContext,
  owner: string,
  groups: ExpectedAssetGroup[],
  itemsById: Map<string, ShopInventoryItem>,
  scopes: readonly ShopInventoryCollectionScope[],
): Promise<void> {
  if (groups.length === 0) return;
  const recoveryScope = createAttemptScope(context.signal, context.dependencies.expectedAssetRecoveryTimeoutMs);
  try {
    const rows = await mapConcurrent(groups, PROVIDER_CONCURRENCY, async ({ cluster, ids }) => {
      const recovery = await fetchExpectedAssetGroup(context, cluster, ids, recoveryScope.signal);
      context.metrics.expectedAssetRecoveryFailures += recovery.failures;
      const items: ShopInventoryItem[] = [];
      for (const asset of recovery.assetsById.values()) {
        const item = recoveredExpectedInventoryItem(asset, owner, cluster, scopes);
        if (item) items.push(item);
      }
      return { items, rawAssets: recovery.assetsById.size };
    });
    if (context.signal.aborted) throw context.signal.reason;
    for (const row of rows) {
      if (context.inventoryCandidates + row.rawAssets > context.dependencies.inventoryMaxCandidates) {
        context.metrics.expectedAssetRecoveryFailures += 1;
        continue;
      }
      context.inventoryCandidates += row.rawAssets;
      const nextItemsById = new Map(itemsById);
      let resolved = 0;
      for (const item of row.items) {
        if (!nextItemsById.has(item.id)) resolved += 1;
        nextItemsById.set(item.id, item);
      }
      const nextItems = Array.from(nextItemsById.values());
      if (
        nextItems.length > SHOP_API_MAX_RESPONSE_ITEMS ||
        utf8ByteLength(JSON.stringify({ ok: true, items: nextItems })) > context.dependencies.inventoryMaxResponseBodyBytes
      ) {
        context.metrics.expectedAssetRecoveryFailures += 1;
        continue;
      }
      itemsById.clear();
      for (const [id, item] of nextItemsById) itemsById.set(id, item);
      context.metrics.expectedAssetResolved += resolved;
    }
  } finally {
    recoveryScope.dispose();
  }
}

async function fetchPendingOpenBoxes(
  context: ProviderContext,
  requestBody: ShopPendingOpenBoxesRequest,
): Promise<ShopPendingOpenBoxesResponse> {
  const scopes = listShopPendingOpenProgramScopes(requestBody.includeDevnet === true);
  const rows = (await mapConcurrent(scopes, PROVIDER_CONCURRENCY, (scope) =>
    fetchPendingProgramScope(context, requestBody.owner, scope))).flat();
  const deduped = new Map<string, PendingOpenRecordCandidate>();
  for (const row of rows) {
    const key = `${row.solanaCluster}:${row.pendingPda}`;
    if (deduped.has(key)) throw new ProviderFailure('unavailable');
    deduped.set(key, row);
  }
  const records = Array.from(deduped.values());
  const unresolved = records.filter((entry) => resolvePendingOpenDropId(entry) === null && !entry.configPda);
  const assetsByCluster = new Map<SolanaCluster, Map<string, DasAsset>>();
  const unresolvedClusters = Array.from(new Set(unresolved.map((entry) => entry.solanaCluster)));
  await mapConcurrent(unresolvedClusters, PROVIDER_CONCURRENCY, async (cluster) => {
    const ids = Array.from(new Set(unresolved.filter((entry) => entry.solanaCluster === cluster).map((entry) => entry.boxAssetId)));
    assetsByCluster.set(cluster, await fetchAssetBatch(context, cluster, ids));
  });
  const items = records.flatMap((entry) => {
    const resolvedWithoutAsset = resolvePendingOpenDropId(entry);
    if (resolvedWithoutAsset) return [toShopPendingOpenBox(entry, resolvedWithoutAsset)];
    if (entry.configPda) return [];
    const asset = assetsByCluster.get(entry.solanaCluster)?.get(entry.boxAssetId);
    const dropId = resolvePendingOpenDropId(entry, asset);
    if (!dropId) return [];
    return [toShopPendingOpenBox(entry, dropId)];
  });
  items.sort((left, right) => Number(right.createdSlot || 0) - Number(left.createdSlot || 0));
  return { ok: true, items };
}

export async function handlePost(
  request: Request,
  env: Env,
  pathname: '/inventory' | '/pending-open-boxes',
  dependencies: ShopInventoryDependencies,
  metrics: WorkerRequestMetrics,
): Promise<{ response: Response; includeDevnet: boolean }> {
  const origin = publicRequestOrigin(request);
  if (!origin) return { response: publicOriginDeniedResponse(), includeDevnet: false };
  const result = (response: Response, includeDevnet: boolean) => ({
    response: applyPublicCors(response, origin, 'POST, OPTIONS'),
    includeDevnet,
  });
  let parsedRequest:
    | { kind: 'inventory'; body: ShopInventoryRequest }
    | { kind: 'pending-open-boxes'; body: ShopPendingOpenBoxesRequest };
  try {
    parsedRequest = pathname === '/inventory'
      ? { kind: 'inventory', body: await parseShopRequestBody(request, isExactShopInventoryRequest) }
      : { kind: 'pending-open-boxes', body: await parseShopRequestBody(request, isExactShopPendingOpenBoxesRequest) };
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    return result(publicJsonResponse({ ok: false, error: 'invalid-request' }, 400), false);
  }
  const requestBody = parsedRequest.body;
  await observePublicRateLimit({
    binding: env.PUBLIC_SHOP_RATE_LIMITER,
    keyScope: pathname,
    limit: PUBLIC_RATE_LIMITS.shop,
    log: dependencies.log,
    request,
    route: pathname,
  });
  const apiKey = typeof env.HELIUS_API_KEY === 'string' ? env.HELIUS_API_KEY.trim() : '';
  if (!apiKey) {
    return result(
      publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502),
      requestBody.includeDevnet === true,
    );
  }
  const deadline = createRequestDeadline(request, {
    timeoutMs: dependencies.providerTimeoutMs,
    timeoutMessage: 'Shop provider request timed out',
  });
  const controller = new AbortController();
  const signal = AbortSignal.any([deadline.signal, controller.signal]);
  const context: ProviderContext = {
    apiKey,
    signal,
    dependencies,
    metrics,
    providerResponseBodyBytes: 0,
    inventoryCandidates: 0,
    inventoryCursorPages: 0,
    inventoryProviderCalls: 0,
    providerReadGate: new ProviderReadGate(),
  };
  try {
    const body = parsedRequest.kind === 'inventory'
      ? await fetchInventory(context, parsedRequest.body, env.COMMERCE_DB)
      : await fetchPendingOpenBoxes(context, parsedRequest.body);
    request.signal.throwIfAborted();
    const valid = parsedRequest.kind === 'inventory'
      ? dependencies.validateInventoryResponse(body)
      : dependencies.validatePendingOpenBoxesResponse(body);
    if (!valid) throw new ProviderFailure('unavailable');
    const text = JSON.stringify(body);
    if (
      pathname === '/inventory' &&
      utf8ByteLength(text) > dependencies.inventoryMaxResponseBodyBytes
    ) throw new ProviderFailure('limit');
    return result(
      new Response(text, { status: 200, headers: BASE_HEADERS }),
      requestBody.includeDevnet === true,
    );
  } catch (error) {
    controller.abort();
    if (isRequestCancellationError(request, error)) throw error;
    const kind = deadline.timedOut()
      ? 'deadline'
      : error instanceof ProviderFailure
        ? error.kind
        : 'unavailable';
    return result(
      publicJsonResponse(
        { ok: false, error: kind === 'timeout' || kind === 'deadline' ? 'provider-timeout' : 'provider-unavailable' },
        kind === 'timeout' || kind === 'deadline' ? 504 : 502,
      ),
      requestBody.includeDevnet === true,
    );
  } finally {
    deadline.dispose();
  }
}
