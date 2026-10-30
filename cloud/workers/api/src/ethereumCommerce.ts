import { z } from 'zod';
import { decodeEventLogs, decodeReturn, encodeCall, type EthereumDecodedEvent } from '../../../../shared/ethereum/abi.js';
import { crateClaimDigest, deliveryDigest, ethereumReceiptIdsHash, ethereumSignerAddress, signDigest } from '../../../../shared/ethereum/crypto.js';
import {
  ETHEREUM_AUTHORIZATION_TTL_SECONDS, physicalCrateArtworkIds, ethereumAssetId, ethereumMetadataTokenId,
  ethereumHexQuantity, ethereumReceiptTokenId, normalizeEthereumTokenId,
} from '../../../../shared/ethereum/protocol.js';
import type { EthereumDeliveryPrepareResponse, EthereumClaimPrepareResponse } from '../../../../shared/ethereum/api.js';
import { EthereumApiError, readEthereumBody } from './ethereumError.js';
import { requireEthereum111kWrites } from './ethereumControl.js';
import { limitEthereumRequest, verifyEthereumSession } from './ethereumAuth.js';
import { loadEthereumAddress } from './ethereumProfile.js';
import {
  ethereumBlockSnapshot, ethereumCall, ethereumRpc, ethereumTransactionHash, requireEthereumContract, rpcInteger,
  verifyEthereumBlockSnapshot, type EthereumContext,
} from './ethereumRuntime.js';
import {
  ethereumInventoryItems, ethereumReceipt, ethereumTokenInfos, transferTokenIds, type EthereumTokenInfo,
} from './ethereumRead.js';
import { matchesSha256Hex, sha256Hex } from './sessionSecrets.js';
import { D1CommerceRepository, commerceFieldValue, commerceKeys } from './commerceRepository.js';
import { blockingEthereumCheckout, inspectEthereumCheckoutFailures, requireResolvedEthereumCheckoutFailures } from './ethereumCheckoutAttempts.js';

export type EthereumDeliveryRow = {
  chain_id: number; contract_address: string; order_id: number; request_id: string; wallet: string;
  address_id: string; address_json: string; token_ids_json: string; items_json: string; fee_wei: string;
  deadline: number; status: 'prepared' | 'pending' | 'confirmed'; transaction_hash: string | null;
  block_number: number | null; block_hash: string | null; created_at_ms: number; updated_at_ms: number;
  published_at_ms: number | null; verified_at_block: number | null;
  checkout_id?: string | null;
};

export type EthereumClaimRow = {
  chain_id: number; contract_address: string; receipt_id: string; crate_id: number; order_id: number;
  code_hash: string; code: string; claim_id: string; status: 'available' | 'pending' | 'claimed';
  transaction_hash: string | null; block_number: number | null; block_hash: string | null; updated_at_ms: number;
  verified_at_block: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimalId = z.string().regex(/^[1-9][0-9]{0,77}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export async function loadEthereumDelivery(context: EthereumContext, orderId: number): Promise<EthereumDeliveryRow> {
  const row = await context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_delivery_quotes
    WHERE chain_id = ? AND contract_address = ? AND order_id = ?`)
    .bind(context.config.chainId, requireEthereumContract(context), orderId).first<EthereumDeliveryRow>();
  if (!row) throw new EthereumApiError('not-found', 'Delivery order not found.');
  return row;
}

export async function retireEthereumDelivery(context: EthereumContext, row: EthereumDeliveryRow): Promise<boolean> {
  const [used] = decodeReturn(['bool'], await ethereumCall(context, encodeCall('usedDeliveryOrders(uint256)', ['uint256'], [row.order_id])));
  const status = used ? 'pending' : 'prepared';
  const snapshot = [row.chain_id, row.contract_address, row.order_id, row.status, row.transaction_hash, row.block_hash, row.updated_at_ms];
  const matches = `chain_id = ? AND contract_address = ? AND order_id = ? AND status = ?
    AND transaction_hash IS ? AND block_hash IS ? AND updated_at_ms = ?`;
  const result = await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_quotes SET status = ?,
    published_at_ms = NULL, verified_at_block = NULL, updated_at_ms = MAX(updated_at_ms + 1, ?)
    WHERE ${matches}`).bind(status, context.nowMs, ...snapshot).run();
  if (result.meta.changes !== 1) return false;
  const retiredAtMs = Math.max(context.nowMs, row.updated_at_ms + 1);
  const projected = await projectPendingEthereumDelivery(context, { ...row, status,
    published_at_ms: null, updated_at_ms: retiredAtMs });
  if (!projected || used) return false;
  const acknowledged = await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_quotes SET transaction_hash = NULL,
    block_number = NULL, block_hash = NULL WHERE chain_id = ? AND contract_address = ? AND order_id = ?
      AND status = 'prepared' AND transaction_hash IS ? AND block_number IS ? AND block_hash IS ?
      AND updated_at_ms = ? AND published_at_ms IS NULL`)
    .bind(row.chain_id, row.contract_address, row.order_id, row.transaction_hash, row.block_number, row.block_hash, retiredAtMs).run();
  return acknowledged.meta.changes === 1;
}

async function projectPendingEthereumDelivery(context: EthereumContext, row: EthereumDeliveryRow): Promise<boolean> {
  const repository = new D1CommerceRepository(context.env.COMMERCE_DB);
  const key = commerceKeys.deliveryOrder(context.config.dropId, String(row.order_id));
  return repository.run(context.nowMs, async (unit) => {
    const existing = await unit.get(key);
    const current = await loadEthereumDelivery(context, row.order_id);
    if (current.status !== row.status || current.transaction_hash !== row.transaction_hash ||
      current.block_number !== row.block_number || current.block_hash !== row.block_hash ||
      current.updated_at_ms !== row.updated_at_ms) return false;
    unit.expectEthereumState({ kind: 'delivery', chainId: row.chain_id, contractAddress: row.contract_address,
      id: String(row.order_id), status: row.status, transactionHash: row.transaction_hash,
      blockNumber: row.block_number, blockHash: row.block_hash, updatedAtMs: row.updated_at_ms });
    if (existing) await unit.update(key, { status: 'processing', irlClaims: [] });
    return true;
  });
}

async function authorizationDeadline(context: EthereumContext): Promise<number> {
  const block = await ethereumRpc(context, 'eth_getBlockByNumber', ['latest', false]);
  if (!block || typeof block !== 'object' || !('timestamp' in block)) throw new EthereumApiError('unavailable', 'Ethereum block time is unavailable.');
  const chainTime = rpcInteger(block.timestamp);
  const now = Math.floor(context.nowMs / 1000);
  const deadline = Math.min(now, chainTime) + ETHEREUM_AUTHORIZATION_TTL_SECONDS;
  if (deadline <= now || deadline <= chainTime) throw new EthereumApiError('unavailable', 'Ethereum block time is stale. Try again when the chain is advancing.');
  return deadline;
}

async function signerSecret(context: EthereumContext): Promise<string> {
  const secret = context.env.ETHEREUM_111K_SIGNER_SECRET?.trim();
  if (!secret) throw new EthereumApiError('unavailable', 'Ethereum delivery signing is not configured.');
  let address: string;
  try { address = ethereumSignerAddress(secret); } catch { throw new EthereumApiError('unavailable', 'Ethereum delivery signing is not configured.'); }
  const [expected] = decodeReturn(['address'], await ethereumCall(context, encodeCall('quoteSigner()', [], [])));
  if (address !== expected) throw new EthereumApiError('unavailable', 'Ethereum delivery signing is not configured for this collection.');
  return secret;
}

function deliveryItems(row: EthereumDeliveryRow): EthereumTokenInfo[] {
  const value: unknown = JSON.parse(row.items_json);
  if (!Array.isArray(value) || !value.length || value.length > 50 || value.some((item) =>
    !item || typeof item.tokenId !== 'string' || !['artwork', 'crate'].includes(item.kind) ||
    !Number.isSafeInteger(item.displayId) || item.displayId < 1 || item.owner !== row.wallet)) {
    throw new EthereumApiError('unavailable', 'Stored delivery data is invalid.');
  }
  return value as EthereumTokenInfo[];
}

function deliveryReceiptIds(items: EthereumTokenInfo[]): string[] {
  return items.map((item) => ethereumReceiptTokenId(item.kind as 'artwork' | 'crate', item.displayId));
}

async function prepareEthereumDelivery(request: Request, context: EthereumContext): Promise<EthereumDeliveryPrepareResponse> {
  const session = await verifyEthereumSession(request, context);
  await limitEthereumRequest(request, context, `delivery:${session.wallet}`, context.env.STAFF_AUTH_SESSION_RATE_LIMITER);
  const body = await readEthereumBody(request, context.signal, z.object({
    tokenIds: z.array(decimalId).min(1).max(50), addressId: z.string().regex(/^[A-Za-z0-9]{20}$/), requestId: z.string().regex(UUID),
  }).strict());
  return prepareEthereumDeliveryQuote(context, session.wallet, body);
}

export async function prepareEthereumDeliveryQuote(context: EthereumContext, wallet: string,
  body: { tokenIds: string[]; addressId: string; requestId: string },
  checkout?: { checkoutId: string; items: readonly Pick<EthereumTokenInfo, 'tokenId' | 'kind' | 'displayId'>[] }): Promise<EthereumDeliveryPrepareResponse> {
  const ids = body.tokenIds.map(normalizeEthereumTokenId);
  if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) throw new EthereumApiError('invalid-argument', 'Choose distinct owned artworks or crates.');
  const tokenIds = ids as string[];
  const contractAddress = requireEthereumContract(context);
  const secret = await signerSecret(context);
  const loadPrepared = () => checkout
    ? context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_delivery_quotes WHERE checkout_id = ?`)
      .bind(checkout.checkoutId).first<EthereumDeliveryRow>()
    : context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_delivery_quotes
      WHERE chain_id = ? AND contract_address = ? AND wallet = ? AND request_id = ?`)
      .bind(context.config.chainId, contractAddress, wallet, body.requestId).first<EthereumDeliveryRow>();
  let row = await loadPrepared();
  if (row && (row.wallet !== wallet || row.chain_id !== context.config.chainId || row.contract_address !== contractAddress)) {
    throw new EthereumApiError('permission-denied', 'This checkout belongs to a different wallet or collection.');
  }
  const failures = await inspectEthereumCheckoutFailures(context, { wallet, tokenIdsJson: JSON.stringify(tokenIds) });
  requireResolvedEthereumCheckoutFailures(failures);
  const assertCheckoutAvailable = async (prepared: EthereumDeliveryRow | null) => {
    if (!await context.env.COMMERCE_DB.prepare(`SELECT 1 WHERE ${failures.sql}
      AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts
        WHERE checkout_id = ? AND status IN ('started', 'submitted', 'expired'))`)
      .bind(...failures.values, prepared?.checkout_id ?? null).first()) {
      const expired = prepared?.checkout_id && await context.env.COMMERCE_DB.prepare(`SELECT 1 FROM ethereum_delivery_checkout_attempts
        WHERE checkout_id = ? AND status = 'expired' LIMIT 1`).bind(prepared.checkout_id).first();
      const blockingCheckoutId = expired ? null : await blockingEthereumCheckout(context, { wallet, tokenIdsJson: JSON.stringify(tokenIds) });
      throw new EthereumApiError('failed-precondition', blockingCheckoutId
        ? 'Some selected items already have a pending redemption. Return to that checkout to track or recover it.'
        : 'This checkout is already being checked or has expired. Return to it before starting again.',
      blockingCheckoutId ? { blockingCheckoutId } : undefined);
    }
  };
  await assertCheckoutAvailable(row);
  if (row && (row.address_id !== body.addressId || row.token_ids_json !== JSON.stringify(tokenIds))) {
    throw new EthereumApiError('failed-precondition', 'This delivery request was already used for a different selection.');
  }
  if (row?.status === 'confirmed') throw new EthereumApiError('failed-precondition', 'This delivery was already completed.');
  const [used] = row ? decodeReturn(['bool'], await ethereumCall(context, encodeCall('usedDeliveryOrders(uint256)', ['uint256'], [row.order_id]))) : [false];
  if (used) throw new EthereumApiError('failed-precondition', 'This delivery is already onchain. Wait for its confirmation.');
  const items = await ethereumTokenInfos(context, tokenIds);
  if (items.length !== tokenIds.length || items.some((item) => item.owner !== wallet || !['artwork', 'crate'].includes(item.kind))) {
    throw new EthereumApiError('permission-denied', 'Only owned artworks and crates can be delivered.');
  }
  if (checkout && (checkout.items.length !== items.length || checkout.items.some((item, index) =>
    item.tokenId !== items[index].tokenId || item.kind !== items[index].kind || item.displayId !== items[index].displayId))) {
    throw new EthereumApiError('failed-precondition', 'The selected items changed onchain. Start a new checkout.');
  }
  const address = await loadEthereumAddress(context, wallet, body.addressId);
  const deadline = await authorizationDeadline(context);
  if (!row) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const orderId = (crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fff_ffff) || 1;
      const existing = await new D1CommerceRepository(context.env.COMMERCE_DB).get(commerceKeys.deliveryOrder(context.config.dropId, String(orderId)));
      if (existing) continue;
      const result = await context.env.COMMERCE_DB.prepare(`INSERT OR IGNORE INTO ethereum_delivery_quotes
        (chain_id, contract_address, order_id, request_id, wallet, address_id, address_json, token_ids_json, items_json,
         fee_wei, deadline, status, created_at_ms, updated_at_ms, checkout_id)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ? WHERE ${failures.sql}`)
        .bind(context.config.chainId, contractAddress, orderId, body.requestId, wallet, body.addressId,
          JSON.stringify(address), JSON.stringify(tokenIds), JSON.stringify(items), context.config.deliveryFeeWei,
          deadline, context.nowMs, context.nowMs, checkout?.checkoutId ?? null, ...failures.values).run();
      row = await loadPrepared();
      if (row) break;
      await assertCheckoutAvailable(row);
      if (result.meta.changes === 1) throw new EthereumApiError('unavailable', 'Delivery preparation is temporarily unavailable.');
    }
    if (!row) throw new EthereumApiError('unavailable', 'Delivery preparation is temporarily unavailable.');
    if (row.wallet !== wallet || row.address_id !== body.addressId || row.token_ids_json !== JSON.stringify(tokenIds)) {
      throw new EthereumApiError('failed-precondition', 'This delivery request was already used for a different selection.');
    }
  } else if (row.deadline <= Math.floor(context.nowMs / 1000)) {
    await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_quotes SET deadline = ?, updated_at_ms = MAX(updated_at_ms + 1, ?)
      WHERE chain_id = ? AND contract_address = ? AND order_id = ? AND deadline = ? AND status != 'confirmed'
        AND (checkout_id IS NULL OR NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts AS attempt
          WHERE attempt.checkout_id = ethereum_delivery_quotes.checkout_id AND attempt.status IN ('started', 'submitted', 'expired')))
        AND ${failures.sql}`)
      .bind(deadline, context.nowMs, context.config.chainId, contractAddress, row.order_id, row.deadline, ...failures.values).run();
    row = await loadEthereumDelivery(context, row.order_id);
  }
  const storedItems = deliveryItems(row);
  if (storedItems.length !== items.length || storedItems.some((item, index) =>
    item.tokenId !== items[index].tokenId || item.kind !== items[index].kind || item.displayId !== items[index].displayId)) {
    throw new EthereumApiError('failed-precondition', 'The selected items changed onchain. Refresh your inventory and start a new delivery.');
  }
  const quote = { orderId: row.order_id, wallet: row.wallet, fee: row.fee_wei, deadline: row.deadline,
    receiptIdsHash: ethereumReceiptIdsHash(deliveryReceiptIds(storedItems)) };
  await requireEthereum111kWrites(context.env.COMMERCE_DB, context.config, context.signal);
  await assertCheckoutAvailable(row);
  const signature = signDigest(secret, deliveryDigest({ ...quote, chainId: context.config.chainId, contractAddress, tokenIds }));
  return { orderId: row.order_id, expiresAtMs: row.deadline * 1000, quote, signature,
    transaction: { to: contractAddress, chainId: context.config.chainId, value: ethereumHexQuantity(row.fee_wei),
      data: encodeCall('redeemForDelivery(uint256[],(uint256,address,uint256,uint256,bytes32),bytes)',
        ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'],
        [tokenIds, [quote.orderId, quote.wallet, quote.fee, quote.deadline, quote.receiptIdsHash], signature]) } };
}

function randomClaimCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => (byte & 15).toString(16)).join('').toUpperCase();
}

async function ensureCrateClaims(context: EthereumContext, row: EthereumDeliveryRow): Promise<EthereumClaimRow[]> {
  const crates = deliveryItems(row).filter((item) => item.kind === 'crate');
  if (!crates.length) return [];
  const receiptIds = crates.map((item) => ethereumReceiptTokenId('crate', item.displayId));
  const loadClaims = async () => {
    const result = await context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_crate_claims
      WHERE chain_id = ? AND contract_address = ? AND receipt_id IN (${receiptIds.map(() => '?').join(',')})`)
      .bind(row.chain_id, row.contract_address, ...receiptIds).all<EthereumClaimRow>();
    return new Map(result.results.map((claim) => [claim.receipt_id, claim]));
  };
  let claims = await loadClaims();
  const conflictingOrders = new Set([...claims.values()].filter((claim) => claim.order_id !== row.order_id).map((claim) => claim.order_id));
  for (const orderId of conflictingOrders) {
    const previous = await loadEthereumDelivery(context, orderId);
    if (!await retireEthereumDelivery(context, previous)) continue;
    const conflicts = [...claims.values()].filter((claim) => claim.order_id === orderId);
    const deleted = await context.env.COMMERCE_DB.batch(conflicts.map((claim) =>
      context.env.COMMERCE_DB.prepare(`DELETE FROM ethereum_crate_claims
        WHERE chain_id = ? AND contract_address = ? AND receipt_id = ? AND order_id = ? AND claim_id = ? AND updated_at_ms = ?
          AND EXISTS (SELECT 1 FROM ethereum_delivery_quotes WHERE chain_id = ? AND contract_address = ? AND order_id = ?
            AND status = 'prepared' AND transaction_hash IS NULL AND updated_at_ms = ?)
          AND EXISTS (SELECT 1 FROM ethereum_delivery_quotes WHERE chain_id = ? AND contract_address = ? AND order_id = ?
            AND status = 'confirmed' AND transaction_hash = ? AND block_hash = ?)`)
        .bind(claim.chain_id, claim.contract_address, claim.receipt_id, claim.order_id, claim.claim_id, claim.updated_at_ms,
          previous.chain_id, previous.contract_address, previous.order_id, Math.max(context.nowMs, previous.updated_at_ms + 1),
          row.chain_id, row.contract_address, row.order_id, row.transaction_hash, row.block_hash)));
    deleted.forEach((result, index) => { if (result.meta.changes === 1) claims.delete(conflicts[index].receipt_id); });
  }
  const inserts: D1PreparedStatement[] = [];
  for (const item of crates) {
    const receiptId = ethereumReceiptTokenId('crate', item.displayId);
    if (claims.has(receiptId)) continue;
    const code = randomClaimCode();
    const claimId = `0x${await sha256Hex(crypto.randomUUID())}`;
    inserts.push(context.env.COMMERCE_DB.prepare(`INSERT OR IGNORE INTO ethereum_crate_claims
      (chain_id, contract_address, receipt_id, crate_id, order_id, code_hash, code, claim_id, status, updated_at_ms)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'available', ? WHERE EXISTS (
        SELECT 1 FROM ethereum_delivery_quotes WHERE chain_id = ? AND contract_address = ? AND order_id = ?
          AND status = 'confirmed' AND transaction_hash = ? AND block_hash = ?)`)
      .bind(row.chain_id, row.contract_address, receiptId, item.displayId, row.order_id,
        await sha256Hex(code), code, claimId, context.nowMs, row.chain_id, row.contract_address, row.order_id,
        row.transaction_hash, row.block_hash));
  }
  if (inserts.length) {
    await context.env.COMMERCE_DB.batch(inserts);
    claims = await loadClaims();
  }
  return crates.map((item, index) => {
    const claim = claims.get(receiptIds[index]);
    if (!claim || claim.order_id !== row.order_id || claim.crate_id !== item.displayId) {
      throw new EthereumApiError('failed-precondition', 'Physical crate records conflict. Contact support.');
    }
    return claim;
  });
}

async function publishEthereumOrder(context: EthereumContext, row: EthereumDeliveryRow, claims: EthereumClaimRow[], receiptIds: string[]): Promise<void> {
  const repository = new D1CommerceRepository(context.env.COMMERCE_DB);
  const key = commerceKeys.deliveryOrder(context.config.dropId, String(row.order_id));
  const items = deliveryItems(row);
  await repository.run(context.nowMs, async (unit) => {
    const existing = await unit.get(key);
    const current = await loadEthereumDelivery(context, row.order_id);
    if (current.status !== 'confirmed' || current.transaction_hash !== row.transaction_hash ||
      current.block_hash !== row.block_hash || current.updated_at_ms !== row.updated_at_ms) {
      throw new EthereumApiError('unavailable', 'The delivery confirmation changed. Try again.');
    }
    const currentClaims = await context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_crate_claims
      WHERE chain_id = ? AND contract_address = ? AND order_id = ? ORDER BY receipt_id`)
      .bind(row.chain_id, row.contract_address, row.order_id).all<EthereumClaimRow>();
    if (currentClaims.results.length !== claims.length) throw new EthereumApiError('unavailable', 'The delivery claims changed. Try again.');
    const irlClaims = currentClaims.results.map((claim) => ({ code: claim.code, boxId: claim.crate_id,
      boxAssetId: ethereumAssetId(row.chain_id, row.contract_address, String(111111 + claim.crate_id)),
      receiptTokenId: claim.receipt_id, dudeIds: physicalCrateArtworkIds(claim.crate_id), status: claim.status }));
    unit.expectEthereumState({ kind: 'delivery', chainId: row.chain_id, contractAddress: row.contract_address,
      id: String(row.order_id), status: row.status, transactionHash: row.transaction_hash,
      blockNumber: row.block_number, blockHash: row.block_hash, updatedAtMs: row.updated_at_ms });
    for (const claim of currentClaims.results) {
      unit.expectEthereumState({ kind: 'claim', chainId: claim.chain_id, contractAddress: claim.contract_address,
        id: claim.receipt_id, orderId: claim.order_id, claimId: claim.claim_id, status: claim.status,
        transactionHash: claim.transaction_hash, blockNumber: claim.block_number, blockHash: claim.block_hash,
        updatedAtMs: claim.updated_at_ms });
    }
    if (existing) {
      if (existing.data.source !== 'ethereum' || existing.data.owner !== row.wallet || existing.data.contractAddress !== row.contract_address) {
        throw new EthereumApiError('failed-precondition', 'Delivery order identity conflict.');
      }
      if (existing.data.status === 'processing' || JSON.stringify(existing.data.irlClaims) !== JSON.stringify(irlClaims) ||
        existing.data.deliverySignature !== row.transaction_hash) {
        await unit.update(key, { irlClaims, deliverySignature: row.transaction_hash,
          receiptTxs: row.transaction_hash ? [row.transaction_hash] : [],
          ...(existing.data.status === 'processing' ? { status: 'ready_to_ship', processedAt: commerceFieldValue.serverTimestamp() } : {}) });
      }
      return;
    }
    await unit.create(key, {
      dropId: context.config.dropId, source: 'ethereum', testnet: true,
      chainId: row.chain_id, contractAddress: row.contract_address,
      deliveryId: row.order_id, owner: row.wallet, receiptOwner: row.wallet,
      status: 'ready_to_ship', addressId: row.address_id, addressSnapshot: JSON.parse(row.address_json),
      itemIds: items.map((item) => ethereumAssetId(row.chain_id, row.contract_address, item.tokenId)),
      items: items.map((item) => ({ assetId: ethereumAssetId(row.chain_id, row.contract_address, item.tokenId),
        tokenId: item.tokenId, kind: item.kind === 'crate' ? 'box' : 'dude', refId: item.displayId })),
      deliveryFeeWei: row.fee_wei, deliverySignature: row.transaction_hash,
      receiptsMinted: receiptIds.length, receiptTxs: row.transaction_hash ? [row.transaction_hash] : [], receiptTokenIds: receiptIds,
      irlClaims,
      createdAt: commerceFieldValue.timestamp(Math.floor(row.created_at_ms / 1000), (row.created_at_ms % 1000) * 1_000_000),
      processedAt: commerceFieldValue.serverTimestamp(),
    });
  });
}

export function requireMatchingDelivery(event: Extract<EthereumDecodedEvent, { name: 'DeliveryRedeemed' }>, row: EthereumDeliveryRow): void {
  const expectedReceipts = deliveryReceiptIds(deliveryItems(row));
  if (event.wallet !== row.wallet || event.fee !== row.fee_wei || JSON.stringify(event.tokenIds) !== row.token_ids_json ||
    JSON.stringify(event.receiptIds) !== JSON.stringify(expectedReceipts)) {
    throw new EthereumApiError('permission-denied', 'The transaction does not match this delivery order.');
  }
}

export async function confirmEthereumDelivery(context: EthereumContext, orderId: number, transactionHash: string,
  verified?: Awaited<ReturnType<typeof ethereumReceipt>> & { row: EthereumDeliveryRow }): Promise<{ status: 'pending' | 'confirmed'; confirmations: number; orderId: number }> {
  const row = verified?.row ?? await loadEthereumDelivery(context, orderId);
  const { receipt, confirmations } = verified ?? await ethereumReceipt(context, transactionHash);
  if (!receipt) return { status: 'pending', confirmations, orderId };
  const events = decodeEventLogs(receipt.logs, row.contract_address).filter((event) => event.name === 'DeliveryRedeemed' && event.orderId === orderId);
  if (events.length !== 1 || events[0].name !== 'DeliveryRedeemed') throw new EthereumApiError('permission-denied', 'The transaction does not contain this delivery order.');
  const event = events[0];
  requireMatchingDelivery(event, row);
  const ready = confirmations >= context.config.confirmationBlocks;
  const blockNumber = rpcInteger(receipt.blockNumber);
  const updatedAtMs = Math.max(context.nowMs, row.updated_at_ms + 1);
  const result = await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_quotes SET status = ?, transaction_hash = ?,
    block_number = ?, block_hash = ?, verified_at_block = NULL, published_at_ms = NULL, updated_at_ms = ?
    WHERE chain_id = ? AND contract_address = ? AND order_id = ? AND status = ?
      AND transaction_hash IS ? AND block_hash IS ? AND updated_at_ms = ?`)
    .bind(ready ? 'confirmed' : 'pending', transactionHash, blockNumber, receipt.blockHash, updatedAtMs,
      row.chain_id, row.contract_address, row.order_id, row.status, row.transaction_hash, row.block_hash, row.updated_at_ms).run();
  if (result.meta.changes !== 1) return { status: 'pending', confirmations: 0, orderId };
  const current: EthereumDeliveryRow = { ...row, status: ready ? 'confirmed' : 'pending', transaction_hash: transactionHash,
    block_number: blockNumber, block_hash: receipt.blockHash, verified_at_block: null,
    published_at_ms: null, updated_at_ms: updatedAtMs };
  if (ready) {
    await publishEthereumOrder(context, current, await ensureCrateClaims(context, current), event.receiptIds);
    const acknowledged = await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_quotes SET published_at_ms = ?, verified_at_block = ?
      WHERE chain_id = ? AND contract_address = ? AND order_id = ? AND status = 'confirmed'
        AND transaction_hash = ? AND block_hash = ? AND updated_at_ms = ?`)
      .bind(context.nowMs, blockNumber + confirmations - 1, row.chain_id, row.contract_address, row.order_id,
        transactionHash, receipt.blockHash, updatedAtMs).run();
    if (acknowledged.meta.changes !== 1) return { status: 'pending', confirmations: 0, orderId };
  } else if (!await projectPendingEthereumDelivery(context, current)) return { status: 'pending', confirmations: 0, orderId };
  return { status: ready ? 'confirmed' : 'pending', confirmations, orderId };
}

async function prepareEthereumClaim(request: Request, context: EthereumContext): Promise<EthereumClaimPrepareResponse> {
  const session = await verifyEthereumSession(request, context);
  await limitEthereumRequest(request, context, `claim:${session.wallet}`, context.env.STAFF_AUTH_SESSION_RATE_LIMITER);
  const body = await readEthereumBody(request, context.signal, z.object({ code: z.string().min(1).max(64), receiptId: decimalId }).strict());
  const contractAddress = requireEthereumContract(context);
  const claim = await context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_crate_claims WHERE chain_id = ? AND contract_address = ? AND receipt_id = ?`)
    .bind(context.config.chainId, contractAddress, body.receiptId).first<EthereumClaimRow>();
  const code = body.code.replace(/[\s-]/g, '').toUpperCase();
  if (!claim || !await matchesSha256Hex(code, claim.code_hash)) throw new EthereumApiError('invalid-argument', 'This code does not match the selected crate receipt.');
  if (claim.status === 'claimed') throw new EthereumApiError('failed-precondition', 'This crate receipt has already been claimed.');
  const [info] = await ethereumTokenInfos(context, [body.receiptId]);
  if (!info || info.kind !== 'crate_receipt' || info.displayId !== claim.crate_id || info.owner !== session.wallet) {
    throw new EthereumApiError('permission-denied', 'You must own the matching crate receipt.');
  }
  const delivery = await loadEthereumDelivery(context, claim.order_id);
  if (!delivery.transaction_hash || (await confirmEthereumDelivery(context, claim.order_id, delivery.transaction_hash)).status !== 'confirmed') {
    throw new EthereumApiError('failed-precondition', 'The physical order is still confirming.');
  }
  const deadline = await authorizationDeadline(context);
  const secret = await signerSecret(context);
  await requireEthereum111kWrites(context.env.COMMERCE_DB, context.config, context.signal);
  const signature = signDigest(secret, crateClaimDigest({ chainId: context.config.chainId,
    contractAddress, wallet: session.wallet, receiptId: body.receiptId, claimId: claim.claim_id, deadline }));
  return { claimId: claim.claim_id, receiptId: body.receiptId, deadline, expiresAtMs: deadline * 1000, signature,
    transaction: { to: contractAddress, chainId: context.config.chainId, value: '0x0',
      data: encodeCall('claimCrateReceipt(uint256,bytes32,uint256,bytes)', ['uint256', 'bytes32', 'uint256', 'bytes'],
        [body.receiptId, claim.claim_id, deadline, signature]) } };
}

export async function confirmEthereumClaim(context: EthereumContext, claimId: string, transactionHash: string,
  verified?: Awaited<ReturnType<typeof ethereumReceipt>> & { row: EthereumClaimRow }): Promise<{ status: 'pending' | 'confirmed'; confirmations: number }> {
  const contract = requireEthereumContract(context);
  let row = verified?.row ?? await context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_crate_claims WHERE chain_id = ? AND contract_address = ? AND claim_id = ?`)
    .bind(context.config.chainId, contract, claimId).first<EthereumClaimRow>();
  const { receipt, confirmations } = verified ?? await ethereumReceipt(context, transactionHash);
  if (!receipt) {
    if (!row) throw new EthereumApiError('not-found', 'Crate claim not found.');
    return { status: 'pending', confirmations };
  }
  const events = decodeEventLogs(receipt.logs, contract).filter((event) => event.name === 'CrateReceiptClaimed' && event.claimId === claimId);
  const event = events[0];
  if (events.length !== 1 || event.name !== 'CrateReceiptClaimed') {
    throw new EthereumApiError('permission-denied', 'The transaction does not match this crate claim.');
  }
  row ??= await context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_crate_claims
    WHERE chain_id = ? AND contract_address = ? AND receipt_id = ?`)
    .bind(context.config.chainId, contract, event.receiptId).first<EthereumClaimRow>();
  if (!row) throw new EthereumApiError('not-found', 'Crate claim not found.');
  const expectedIds = physicalCrateArtworkIds(row.crate_id).map((id) => ethereumMetadataTokenId('artwork_receipt', id));
  if (event.receiptId !== row.receipt_id ||
    JSON.stringify(event.receiptIds) !== JSON.stringify(expectedIds)) throw new EthereumApiError('permission-denied', 'The transaction does not match this crate claim.');
  const ready = confirmations >= context.config.confirmationBlocks;
  const blockNumber = rpcInteger(receipt.blockNumber);
  const result = await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_crate_claims SET status = ?, transaction_hash = ?,
    block_number = ?, block_hash = ?, verified_at_block = NULL, claim_id = ?, updated_at_ms = MAX(updated_at_ms + 1, ?)
    WHERE chain_id = ? AND contract_address = ? AND claim_id = ? AND order_id = ? AND status = ?
      AND transaction_hash IS ? AND block_hash IS ? AND updated_at_ms = ?`)
    .bind(ready ? 'claimed' : 'pending', transactionHash, blockNumber, receipt.blockHash, claimId, context.nowMs,
      row.chain_id, contract, row.claim_id, row.order_id, row.status, row.transaction_hash, row.block_hash, row.updated_at_ms).run();
  if (result.meta.changes !== 1) return { status: 'pending', confirmations: 0 };
  const status = ready ? 'claimed' : 'pending';
  const repository = new D1CommerceRepository(context.env.COMMERCE_DB);
  const key = commerceKeys.deliveryOrder(context.config.dropId, String(row.order_id));
  const updatedAtMs = Math.max(context.nowMs, row.updated_at_ms + 1);
  const projected = await repository.run(context.nowMs, async (unit) => {
    const order = await unit.get(key);
    if (!order) return false;
    const current = await context.env.COMMERCE_DB.prepare(`SELECT 1 FROM ethereum_crate_claims
      WHERE chain_id = ? AND contract_address = ? AND claim_id = ? AND order_id = ? AND status = ?
        AND transaction_hash = ? AND block_hash = ? AND updated_at_ms = ?`)
      .bind(row.chain_id, contract, claimId, row.order_id, status, transactionHash, receipt.blockHash,
        updatedAtMs).first();
    if (!current) return false;
    unit.expectEthereumState({ kind: 'claim', chainId: row.chain_id, contractAddress: contract,
      id: row.receipt_id, orderId: row.order_id, claimId, status, transactionHash,
      blockNumber, blockHash: receipt.blockHash, updatedAtMs });
    const claims = Array.isArray(order.data.irlClaims) ? order.data.irlClaims : [];
    await unit.update(key, { irlClaims: claims.map((claim) => claim && typeof claim === 'object' && !Array.isArray(claim) &&
      claim.boxId === row.crate_id && claim.code === row.code
      ? { ...claim, status } : claim) });
    return true;
  });
  if (!projected) return { status: 'pending', confirmations: 0 };
  if (ready) {
    const acknowledged = await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_crate_claims SET verified_at_block = ?
      WHERE chain_id = ? AND contract_address = ? AND receipt_id = ? AND order_id = ? AND claim_id = ?
        AND status = 'claimed' AND transaction_hash = ? AND block_number = ? AND block_hash = ? AND updated_at_ms = ?`)
      .bind(blockNumber + confirmations - 1, row.chain_id, contract, row.receipt_id, row.order_id, claimId,
        transactionHash, blockNumber, receipt.blockHash, updatedAtMs).run();
    if (acknowledged.meta.changes !== 1) return { status: 'pending', confirmations: 0 };
  }
  return { status: ready ? 'confirmed' : 'pending', confirmations };
}

export async function ethereumCommerce(request: Request, context: EthereumContext, path: string): Promise<unknown> {
  if (path.endsWith('/delivery/prepare') || path.endsWith('/delivery/confirm') ||
    path.endsWith('/claims/prepare') || path.endsWith('/claims/confirm')) {
    await requireEthereum111kWrites(context.env.COMMERCE_DB, context.config, context.signal);
  }
  if (path.endsWith('/delivery/prepare')) return prepareEthereumDelivery(request, context);
  if (path.endsWith('/claims/prepare')) return prepareEthereumClaim(request, context);
  if (path.endsWith('/transactions/confirm')) {
    const body = await readEthereumBody(request, context.signal, z.object({ transactionHash: hash }).strict());
    const { receipt, confirmations } = await ethereumReceipt(context, ethereumTransactionHash(body.transactionHash));
    if (!receipt) return { status: 'pending', confirmations, items: [], burnedTokenIds: [] };
    const snapshot = await ethereumBlockSnapshot(context);
    const receiptBlock = rpcInteger(receipt.blockNumber);
    if (snapshot.blockNumber < receiptBlock) throw new EthereumApiError('unavailable', 'Ethereum changed while confirming your transaction. Try again.');
    const blockReference = snapshot.blockHash;
    const ids = transferTokenIds(receipt, requireEthereumContract(context));
    const items = await ethereumInventoryItems(context, await ethereumTokenInfos(context, ids.minted, blockReference));
    const logs = receipt.logs.filter(log => log.address.toLowerCase() === context.config.contractAddress);
    await Promise.all([verifyEthereumBlockSnapshot(context, snapshot),
      verifyEthereumBlockSnapshot(context, { blockNumber: receiptBlock, blockHash: receipt.blockHash })]);
    return { status: 'confirmed', confirmations: snapshot.blockNumber - receiptBlock + 1, items, burnedTokenIds: ids.burned, logs };
  }
  const session = await verifyEthereumSession(request, context);
  if (path.endsWith('/delivery/confirm')) {
    const body = await readEthereumBody(request, context.signal, z.object({ orderId: z.number().int().positive().max(2147483647), transactionHash: hash }).strict());
    const row = await loadEthereumDelivery(context, body.orderId);
    if (row.wallet !== session.wallet) throw new EthereumApiError('permission-denied', 'This delivery belongs to a different wallet.');
    return confirmEthereumDelivery(context, body.orderId, ethereumTransactionHash(body.transactionHash));
  }
  const body = await readEthereumBody(request, context.signal, z.object({ claimId: hash, transactionHash: hash }).strict());
  return confirmEthereumClaim(context, body.claimId.toLowerCase(), ethereumTransactionHash(body.transactionHash));
}
