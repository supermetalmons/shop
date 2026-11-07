import type { EthereumCheckoutGuard } from './ethereumCheckoutStore.js';

export type EthereumDeliveryRow = {
  chain_id: number; contract_address: string; order_id: number; request_id: string; wallet: string;
  address_id: string; address_json: string; token_ids_json: string; items_json: string; fee_wei: string;
  deadline: number; status: 'prepared' | 'pending' | 'confirmed'; transaction_hash: string | null;
  block_number: number | null; block_hash: string | null; created_at_ms: number; updated_at_ms: number;
  published_at_ms: number | null; verified_at_block: number | null;
  checkout_id?: string | null;
  config_id: number;
};

export type EthereumClaimRow = {
  chain_id: number; contract_address: string; receipt_id: string; crate_id: number; order_id: number;
  code_hash: string; code: string; claim_id: string; status: 'available' | 'pending' | 'claimed';
  transaction_hash: string | null; block_number: number | null; block_hash: string | null; updated_at_ms: number;
  verified_at_block: number | null;
};

type DeliveryQuoteInput = Pick<EthereumDeliveryRow,
  'chain_id' | 'contract_address' | 'order_id' | 'request_id' | 'wallet' | 'address_id' | 'address_json' |
  'token_ids_json' | 'items_json' | 'fee_wei' | 'deadline' | 'created_at_ms' | 'updated_at_ms' | 'checkout_id' | 'config_id'>;

export type EthereumClaimInput = {
  receiptId: string; crateId: number; codeHash: string; code: string; claimId: string;
};

export function findEthereumDelivery(db: D1Database, chainId: number, contractAddress: string,
  orderId: number): Promise<EthereumDeliveryRow | null> {
  return db.prepare(`SELECT * FROM ethereum_delivery_quotes
    WHERE chain_id = ? AND contract_address = ? AND order_id = ?`)
    .bind(chainId, contractAddress, orderId).first<EthereumDeliveryRow>();
}

export function findEthereumCheckoutQuote(db: D1Database, checkoutId: string): Promise<EthereumDeliveryRow | null> {
  return db.prepare('SELECT * FROM ethereum_delivery_quotes WHERE checkout_id = ?')
    .bind(checkoutId).first<EthereumDeliveryRow>();
}

export function findEthereumDeliveryRequest(db: D1Database, chainId: number, contractAddress: string,
  wallet: string, requestId: string): Promise<EthereumDeliveryRow | null> {
  return db.prepare(`SELECT * FROM ethereum_delivery_quotes
    WHERE chain_id = ? AND contract_address = ? AND wallet = ? AND request_id = ?`)
    .bind(chainId, contractAddress, wallet, requestId).first<EthereumDeliveryRow>();
}

export async function retireEthereumDeliveryState(db: D1Database, row: EthereumDeliveryRow,
  status: 'pending' | 'prepared', nowMs: number): Promise<boolean> {
  const snapshot = [row.chain_id, row.contract_address, row.order_id, row.status, row.transaction_hash, row.block_hash, row.updated_at_ms];
  const matches = `chain_id = ? AND contract_address = ? AND order_id = ? AND status = ?
    AND transaction_hash IS ? AND block_hash IS ? AND updated_at_ms = ?`;
  const result = await db.prepare(`UPDATE ethereum_delivery_quotes SET status = ?,
    published_at_ms = NULL, verified_at_block = NULL, updated_at_ms = MAX(updated_at_ms + 1, ?)
    WHERE ${matches}`).bind(status, nowMs, ...snapshot).run();
  return result.meta.changes === 1;
}

export async function acknowledgeRetiredEthereumDelivery(db: D1Database, row: EthereumDeliveryRow,
  retiredAtMs: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE ethereum_delivery_quotes SET transaction_hash = NULL,
    block_number = NULL, block_hash = NULL WHERE chain_id = ? AND contract_address = ? AND order_id = ?
      AND status = 'prepared' AND transaction_hash IS ? AND block_number IS ? AND block_hash IS ?
      AND updated_at_ms = ? AND published_at_ms IS NULL`)
    .bind(row.chain_id, row.contract_address, row.order_id, row.transaction_hash, row.block_number, row.block_hash, retiredAtMs).run();
  return result.meta.changes === 1;
}

export async function insertEthereumDeliveryQuote(db: D1Database, row: DeliveryQuoteInput,
  guard: EthereumCheckoutGuard): Promise<boolean> {
  const result = await db.prepare(`INSERT OR IGNORE INTO ethereum_delivery_quotes
    (chain_id, contract_address, order_id, request_id, wallet, address_id, address_json, token_ids_json, items_json,
     fee_wei, deadline, status, created_at_ms, updated_at_ms, checkout_id, config_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ? WHERE ${guard.sql}`)
    .bind(row.chain_id, row.contract_address, row.order_id, row.request_id, row.wallet, row.address_id,
      row.address_json, row.token_ids_json, row.items_json, row.fee_wei, row.deadline, row.created_at_ms,
      row.updated_at_ms, row.checkout_id ?? null, row.config_id, ...guard.values).run();
  return result.meta.changes === 1;
}

export async function renewEthereumDeliveryQuote(db: D1Database, row: EthereumDeliveryRow,
  deadline: number, nowMs: number, guard: EthereumCheckoutGuard): Promise<void> {
  await db.prepare(`UPDATE ethereum_delivery_quotes SET deadline = ?, updated_at_ms = MAX(updated_at_ms + 1, ?)
    WHERE chain_id = ? AND contract_address = ? AND order_id = ? AND deadline = ? AND status != 'confirmed'
      AND (checkout_id IS NULL OR NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts AS attempt
        WHERE attempt.checkout_id = ethereum_delivery_quotes.checkout_id AND attempt.status IN ('started', 'submitted', 'expired')))
      AND ${guard.sql}`)
    .bind(deadline, nowMs, row.chain_id, row.contract_address, row.order_id, row.deadline, ...guard.values).run();
}

export async function findEthereumReceiptClaims(db: D1Database, chainId: number, contractAddress: string,
  receiptIds: readonly string[]): Promise<EthereumClaimRow[]> {
  const result = await db.prepare(`SELECT * FROM ethereum_crate_claims
    WHERE chain_id = ? AND contract_address = ? AND receipt_id IN (${receiptIds.map(() => '?').join(',')})`)
    .bind(chainId, contractAddress, ...receiptIds).all<EthereumClaimRow>();
  return result.results;
}

export async function deleteRetiredEthereumClaims(db: D1Database, claims: readonly EthereumClaimRow[],
  previous: EthereumDeliveryRow, current: EthereumDeliveryRow, retiredAtMs: number): Promise<boolean[]> {
  const results = await db.batch(claims.map((claim) => db.prepare(`DELETE FROM ethereum_crate_claims
    WHERE chain_id = ? AND contract_address = ? AND receipt_id = ? AND order_id = ? AND claim_id = ? AND updated_at_ms = ?
      AND EXISTS (SELECT 1 FROM ethereum_delivery_quotes WHERE chain_id = ? AND contract_address = ? AND order_id = ?
        AND status = 'prepared' AND transaction_hash IS NULL AND updated_at_ms = ?)
      AND EXISTS (SELECT 1 FROM ethereum_delivery_quotes WHERE chain_id = ? AND contract_address = ? AND order_id = ?
        AND status = 'confirmed' AND transaction_hash = ? AND block_hash = ?)`)
    .bind(claim.chain_id, claim.contract_address, claim.receipt_id, claim.order_id, claim.claim_id, claim.updated_at_ms,
      previous.chain_id, previous.contract_address, previous.order_id, retiredAtMs,
      current.chain_id, current.contract_address, current.order_id, current.transaction_hash, current.block_hash)));
  return results.map(result => result.meta.changes === 1);
}

export async function insertEthereumClaims(db: D1Database, row: EthereumDeliveryRow,
  claims: readonly EthereumClaimInput[], nowMs: number): Promise<void> {
  await db.batch(claims.map(claim => db.prepare(`INSERT OR IGNORE INTO ethereum_crate_claims
    (chain_id, contract_address, receipt_id, crate_id, order_id, code_hash, code, claim_id, status, updated_at_ms)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'available', ? WHERE EXISTS (
      SELECT 1 FROM ethereum_delivery_quotes WHERE chain_id = ? AND contract_address = ? AND order_id = ?
        AND status = 'confirmed' AND transaction_hash = ? AND block_hash = ?)`)
    .bind(row.chain_id, row.contract_address, claim.receiptId, claim.crateId, row.order_id,
      claim.codeHash, claim.code, claim.claimId, nowMs, row.chain_id, row.contract_address, row.order_id,
      row.transaction_hash, row.block_hash)));
}

export async function findEthereumOrderClaims(db: D1Database, row: EthereumDeliveryRow): Promise<EthereumClaimRow[]> {
  const result = await db.prepare(`SELECT * FROM ethereum_crate_claims
    WHERE chain_id = ? AND contract_address = ? AND order_id = ? ORDER BY receipt_id`)
    .bind(row.chain_id, row.contract_address, row.order_id).all<EthereumClaimRow>();
  return result.results;
}

export async function recordEthereumDeliveryConfirmation(db: D1Database, previous: EthereumDeliveryRow,
  current: EthereumDeliveryRow): Promise<boolean> {
  const result = await db.prepare(`UPDATE ethereum_delivery_quotes SET status = ?, transaction_hash = ?,
    block_number = ?, block_hash = ?, verified_at_block = NULL, published_at_ms = NULL, updated_at_ms = ?
    WHERE chain_id = ? AND contract_address = ? AND order_id = ? AND status = ?
      AND transaction_hash IS ? AND block_hash IS ? AND updated_at_ms = ?`)
    .bind(current.status, current.transaction_hash, current.block_number, current.block_hash, current.updated_at_ms,
      previous.chain_id, previous.contract_address, previous.order_id, previous.status,
      previous.transaction_hash, previous.block_hash, previous.updated_at_ms).run();
  return result.meta.changes === 1;
}

export async function acknowledgePublishedEthereumDelivery(db: D1Database, row: EthereumDeliveryRow,
  publishedAtMs: number, verifiedAtBlock: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE ethereum_delivery_quotes SET published_at_ms = ?, verified_at_block = ?
    WHERE chain_id = ? AND contract_address = ? AND order_id = ? AND status = 'confirmed'
      AND transaction_hash = ? AND block_hash = ? AND updated_at_ms = ?`)
    .bind(publishedAtMs, verifiedAtBlock, row.chain_id, row.contract_address, row.order_id,
      row.transaction_hash, row.block_hash, row.updated_at_ms).run();
  return result.meta.changes === 1;
}

export async function matchesPublishedEthereumDelivery(db: D1Database, row: EthereumDeliveryRow): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM ethereum_delivery_quotes
    WHERE chain_id = ? AND contract_address = ? AND order_id = ? AND status = 'confirmed'
      AND transaction_hash = ? AND block_hash = ? AND block_number = ? AND updated_at_ms = ? AND published_at_ms = ?`)
    .bind(row.chain_id, row.contract_address, row.order_id, row.transaction_hash, row.block_hash,
      row.block_number, row.updated_at_ms, row.published_at_ms).first());
}

export function findEthereumReceiptClaim(db: D1Database, chainId: number, contractAddress: string,
  receiptId: string): Promise<EthereumClaimRow | null> {
  return db.prepare(`SELECT * FROM ethereum_crate_claims WHERE chain_id = ? AND contract_address = ? AND receipt_id = ?`)
    .bind(chainId, contractAddress, receiptId).first<EthereumClaimRow>();
}

export function findEthereumClaim(db: D1Database, chainId: number, contractAddress: string,
  claimId: string): Promise<EthereumClaimRow | null> {
  return db.prepare(`SELECT * FROM ethereum_crate_claims WHERE chain_id = ? AND contract_address = ? AND claim_id = ?`)
    .bind(chainId, contractAddress, claimId).first<EthereumClaimRow>();
}

export async function recordEthereumClaimConfirmation(db: D1Database, previous: EthereumClaimRow,
  current: EthereumClaimRow, nowMs: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE ethereum_crate_claims SET status = ?, transaction_hash = ?,
    block_number = ?, block_hash = ?, verified_at_block = NULL, claim_id = ?, updated_at_ms = MAX(updated_at_ms + 1, ?)
    WHERE chain_id = ? AND contract_address = ? AND claim_id = ? AND order_id = ? AND status = ?
      AND transaction_hash IS ? AND block_hash IS ? AND updated_at_ms = ?`)
    .bind(current.status, current.transaction_hash, current.block_number, current.block_hash, current.claim_id, nowMs,
      previous.chain_id, current.contract_address, previous.claim_id, previous.order_id, previous.status,
      previous.transaction_hash, previous.block_hash, previous.updated_at_ms).run();
  return result.meta.changes === 1;
}

export async function matchesEthereumClaimState(db: D1Database, row: EthereumClaimRow): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM ethereum_crate_claims
    WHERE chain_id = ? AND contract_address = ? AND claim_id = ? AND order_id = ? AND status = ?
      AND transaction_hash = ? AND block_hash = ? AND updated_at_ms = ?`)
    .bind(row.chain_id, row.contract_address, row.claim_id, row.order_id, row.status,
      row.transaction_hash, row.block_hash, row.updated_at_ms).first());
}

export async function acknowledgeEthereumClaim(db: D1Database, row: EthereumClaimRow,
  verifiedAtBlock: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE ethereum_crate_claims SET verified_at_block = ?
    WHERE chain_id = ? AND contract_address = ? AND receipt_id = ? AND order_id = ? AND claim_id = ?
      AND status = 'claimed' AND transaction_hash = ? AND block_number = ? AND block_hash = ? AND updated_at_ms = ?`)
    .bind(verifiedAtBlock, row.chain_id, row.contract_address, row.receipt_id, row.order_id, row.claim_id,
      row.transaction_hash, row.block_number, row.block_hash, row.updated_at_ms).run();
  return result.meta.changes === 1;
}
