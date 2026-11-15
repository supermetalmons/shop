import { Connection, PublicKey } from '@solana/web3.js';
import { dasAssetBoxId } from '../../../../shared/dasAsset.js';
import { HELIUS_COLLECTION_GROUPING_OPTIONS } from '../../../../shared/dasAssetCollections.js';
import { heliusSearchAssetsHasNextPage, heliusSearchAssetsItems } from '../../../../shared/heliusDas.js';
import { adminIrlCardReceiptProofHasIdentity, classifyAdminIrlCardReceiptLookupError } from './adminIrlCardReceipt.js';
import { getAdminIrlRedeemUnsupportedReason } from './adminIrlRedeem.js';
import {
  normalizeAdminIrlRedeemFinalizeError as normalizedError,
  rethrowAdminIrlRedeemFinalizeCancellation as rethrowFinalizeCancellation,
  summarizeAdminIrlRedeemFinalizeError as summarizeError,
} from './adminIrlRedeemErrors.js';
import type { Runtime } from './adminIrlRedeemFinalizeTypes.js';
import { AdminIrlRedeemFinalizeError } from './adminIrlRedeemFinalizeWorkflowState.js';
import {
  receiptDropIdentity as adminIrlRedeemReceiptDropIdentity,
  rpcCall as adminIrlRedeemRpcCall,
  fetchAsset as fetchAdminIrlRedeemAsset,
  fetchAssetProof as fetchAdminIrlRedeemAssetProof,
  parseProof as parseAdminIrlRedeemProof,
  type ProviderContext,
} from './adminIrlRedeemOnchain.js';
import { normalizeReceiptTxs, type RequestItem } from './adminIrlRedeemRequestState.js';
import { sleepWithSignal } from './boundedRequest.js';
import { isRecord } from './dataAccess.js';
import { API_DROPS } from './dropConfig.js';
import { mapWithConcurrency } from './mapWithConcurrency.js';
import { assetMatchesReceiptDropIdentity, assetMatchesReceiptMetadataIdentity } from './receiptProof.js';
import { bubblegumReceiptAssetIds, coreTransferAssetIds, matchingReceiptTransferCount } from './receiptTransferVerification.js';
import { createSolanaConnection } from './solanaConnection.js';

const RECEIPT_INDEX_MAX_WAIT_MS = 30_000;

const RECEIPT_INDEX_POLL_MS = 2_000;

const HELIUS_ASSET_PAGE_LIMIT = 1000;

const HELIUS_ASSET_MAX_PAGES = 64;

const NAME_POLICY = { metadataNameMode: 'string-only' } as const;

async function loadTransaction(
  connection: Pick<Connection, 'getTransaction'>,
  signature: string,
): Promise<NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>> {
  const transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!transaction) {
    throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem transfer transaction not found yet; retry shortly.');
  }
  if (transaction.meta?.err) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem transfer transaction failed.', {
      err: transaction.meta.err,
    });
  }
  return transaction;
}

export async function verifyPackTransfer(
  connection: Pick<Connection, 'getTransaction'>,
  signature: string,
  owner: string,
  admin: string,
  collection: PublicKey,
  itemIds: string[],
): Promise<void> {
  const transaction = await loadTransaction(connection, signature);
  if (transaction.transaction.message.staticAccountKeys[0]?.toBase58() !== owner) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem transfer payer does not match requester.');
  }
  const transferred = coreTransferAssetIds(transaction, { sender: owner, recipient: admin, collection });
  if (transferred.length !== itemIds.length || transferred.some((asset, index) => asset !== itemIds[index])) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem transfer asset mismatch.', {
      expected: itemIds,
      got: transferred,
    });
  }
}

export async function verifyCardTransfer(
  connection: Pick<Connection, 'getTransaction'>,
  runtime: Runtime,
  signature: string,
  owner: string,
  admin: string,
  collection: PublicKey,
  receiptAssetId: string,
): Promise<void> {
  const transaction = await loadTransaction(connection, signature);
  if (transaction.transaction.message.staticAccountKeys[0]?.toBase58() !== owner) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Card receipt transfer payer does not match sender.');
  }
  const matches = matchingReceiptTransferCount(transaction, {
    sender: owner,
    recipient: admin,
    collection,
    merkleTree: runtime.receiptsMerkleTree,
  });
  const ids = bubblegumReceiptAssetIds(transaction);
  if (matches !== 1 || ids.length !== 1 || ids[0] !== receiptAssetId) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Card receipt transfer asset mismatch.', {
      expected: receiptAssetId,
      got: ids,
    });
  }
}

export function runtimeSupportsFinalize(runtime: Runtime): void {
  const unsupported = getAdminIrlRedeemUnsupportedReason({
    dropFamily: runtime.config.dropFamily,
    itemsPerBox: runtime.itemsPerBox,
    sharesCollectionMint: Object.values(API_DROPS).filter((drop) =>
      drop.solanaCluster === runtime.cluster && drop.collectionMint === runtime.collectionMint.toBase58()
    ).length > 1,
  });
  if (unsupported) throw new AdminIrlRedeemFinalizeError('failed-precondition', unsupported);
}

export function createConnection(provider: ProviderContext, runtime: Runtime): Connection {
  return createSolanaConnection({
    apiKey: provider.apiKey,
    cluster: runtime.cluster,
    fetch: provider.providerFetch,
    signal: provider.signal,
    mapError: (failure) => new AdminIrlRedeemFinalizeError(
      failure.kind === 'timeout' ? 'deadline-exceeded' : 'unavailable',
      failure.kind === 'timeout'
        ? 'Admin IRL redeem provider request timed out.'
        : 'Admin IRL redeem provider is temporarily unavailable.',
    ),
  });
}

function receiptMatches(asset: unknown, runtime: Runtime, boxId: number, owner: string): boolean {
  if (!isRecord(asset) || !isRecord(asset.ownership) || asset.ownership.owner !== owner) return false;
  return assetMatchesReceiptMetadataIdentity(
    asset,
    adminIrlRedeemReceiptDropIdentity(runtime),
    { kind: 'box', id: boxId },
  );
}

export async function scanAssetsByOwner(
  provider: ProviderContext,
  runtime: Runtime,
  owner: string,
  visit: (asset: unknown) => void,
  grouping?: readonly [string, string],
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<void> {
  for (let page = 1; page <= HELIUS_ASSET_MAX_PAGES; page += 1) {
    if (Date.now() >= deadlineMs) {
      throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem receipt indexing timed out.');
    }
    const params: Record<string, unknown> = {
      ownerAddress: owner,
      page,
      limit: HELIUS_ASSET_PAGE_LIMIT,
      options: HELIUS_COLLECTION_GROUPING_OPTIONS,
      ...(grouping ? { grouping } : {}),
    };
    const result = await adminIrlRedeemRpcCall(provider, runtime, 'searchAssets', params);
    const items = heliusSearchAssetsItems(result);
    items.forEach(visit);
    if (!heliusSearchAssetsHasNextPage(result, page, items, HELIUS_ASSET_PAGE_LIMIT)) return;
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', 'Too many assets to search for Admin IRL receipts.');
}

export async function findReceiptAssets(
  connection: Connection,
  provider: ProviderContext,
  runtime: Runtime,
  owner: string,
  items: RequestItem[],
  receiptTxs: string[],
): Promise<Map<number, Record<string, unknown>[]>> {
  const expected = new Set(items.map((item) => item.refId));
  const direct = new Map<number, Record<string, unknown>[]>();
  const add = (asset: unknown) => {
    if (!isRecord(asset)) return;
    const boxId = Number(dasAssetBoxId(asset, NAME_POLICY));
    if (!Number.isSafeInteger(boxId) || !expected.has(boxId) || !receiptMatches(asset, runtime, boxId, owner)) return;
    const list = direct.get(boxId) || [];
    if (!list.some((entry) => entry.id === asset.id)) list.push(asset);
    direct.set(boxId, list);
  };
  try {
    const signatures = normalizeReceiptTxs(receiptTxs);
    const transactions = await connection.getTransactions(signatures, { maxSupportedTransactionVersion: 0 });
    if (transactions.length === signatures.length && transactions.every(Boolean)) {
      const ids = transactions.flatMap((transaction) => transaction ? bubblegumReceiptAssetIds(transaction) : []);
      if (ids.length !== items.length || new Set(ids).size !== ids.length) {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem receipt transaction assets do not match the request.');
      }
      const assets = await mapWithConcurrency(ids, 4, (id, _index, signal) =>
        fetchAdminIrlRedeemAsset({ ...provider, signal }, runtime, id), { signal: provider.signal });
      for (const asset of assets) {
        const boxId = isRecord(asset) ? Number(dasAssetBoxId(asset, NAME_POLICY)) : Number.NaN;
        if (!Number.isSafeInteger(boxId) || !expected.has(boxId) || !receiptMatches(asset, runtime, boxId, owner)) {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem indexed receipt does not match the request.');
        }
        add(asset);
      }
      if (!items.every((item) => (direct.get(item.refId) || []).length === 1)) {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem indexed receipts are ambiguous.');
      }
      return direct;
    }
  } catch (error) {
    rethrowFinalizeCancellation(provider.signal, error);
    if (error instanceof AdminIrlRedeemFinalizeError && error.code === 'failed-precondition') throw error;
    console.warn({ event: 'admin_irl_redeem_receipt_transaction_lookup_failed', dropId: runtime.dropId, error: summarizeError(error) });
  }
  const startedAt = Date.now();
  const deadlineMs = startedAt + RECEIPT_INDEX_MAX_WAIT_MS;
  while (Date.now() <= deadlineMs) {
    direct.clear();
    await scanAssetsByOwner(
      provider,
      runtime,
      owner,
      add,
      ['collection', runtime.collectionMint.toBase58()],
      deadlineMs,
    );
    if (!items.every((item) => (direct.get(item.refId) || []).length === 1)) {
      await scanAssetsByOwner(provider, runtime, owner, add, undefined, deadlineMs);
    }
    if (items.every((item) => (direct.get(item.refId) || []).length === 1)) return direct;
    await sleepWithSignal(RECEIPT_INDEX_POLL_MS, provider.signal);
  }
  return direct;
}

export async function waitForCardReceipt(
  provider: ProviderContext,
  runtime: Runtime,
  receiptAssetId: string,
  figureId: number,
  admin: string,
): Promise<void> {
  const startedAt = Date.now();
  let lastOwner = '';
  let lastTransient: unknown;
  while (Date.now() - startedAt <= RECEIPT_INDEX_MAX_WAIT_MS) {
    try {
      const asset = await fetchAdminIrlRedeemAsset(provider, runtime, receiptAssetId);
      lastOwner = isRecord(asset.ownership) && typeof asset.ownership.owner === 'string' ? asset.ownership.owner : '';
      if (lastOwner === admin) {
        if (!assetMatchesReceiptMetadataIdentity(asset, adminIrlRedeemReceiptDropIdentity(runtime), { kind: 'figure', id: figureId })) {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem receipt does not belong to the requested drop.');
        }
        const proof = await fetchAdminIrlRedeemAssetProof(provider, runtime, receiptAssetId);
        if (adminIrlCardReceiptProofHasIdentity(proof)) {
          if (!assetMatchesReceiptDropIdentity(asset, proof, adminIrlRedeemReceiptDropIdentity(runtime), { kind: 'figure', id: figureId })) {
            throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem receipt proof belongs to a different drop.');
          }
          parseAdminIrlRedeemProof(asset, proof, runtime, admin);
          return;
        }
      }
      lastTransient = undefined;
    } catch (error) {
      rethrowFinalizeCancellation(provider.signal, error);
      const disposition = classifyAdminIrlCardReceiptLookupError(error);
      if (disposition === 'fatal') throw normalizedError(error, 'Admin IRL card receipt lookup failed.');
      lastTransient = disposition === 'transient' ? error : undefined;
    }
    await sleepWithSignal(RECEIPT_INDEX_POLL_MS, provider.signal);
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', lastTransient
    ? 'Admin IRL card receipt lookup failed while waiting for indexing; retry shortly.'
    : 'Admin IRL card receipt is not indexed under the deployer wallet yet.', {
      receiptAssetId,
      expectedOwner: admin,
      lastOwner,
      ...(lastTransient ? { lastError: summarizeError(lastTransient) } : {}),
    });
}
