import type { ETHEREUM_111K_DROP_ID } from '../../../../shared/ethereum/protocol.js';
import type { EthereumDeliveryRow } from './ethereumCommerceStore.js';

export type EthereumCheckoutRow = {
  checkout_id: string; request_id: string; origin: string; drop_id: typeof ETHEREUM_111K_DROP_ID;
  chain_id: number; contract_address: string; token_ids_json: string; items_json: string;
  callback_url: string; callback_state: string | null; created_block: number; created_at_ms: number; expires_at_ms: number;
};

export type EthereumCheckoutAttemptRow = {
  attempt_id: string; checkout_id: string; order_id: number; wallet: string;
  status: 'started' | 'submitted' | 'rejected' | 'reverted' | 'failed' | 'superseded' | 'expired';
  transaction_hash: string | null; quote_deadline: number; expected_nonce: string | null;
  transaction_nonce: string | null; transaction_sender: string | null;
  block_number: number | null; block_hash: string | null; verified_at_block: number | null; checked_at_ms: number;
  created_at_ms: number; updated_at_ms: number;
};

export type EthereumCheckoutGuard = { sql: string; values: readonly (string | number | null)[] };

export function findEthereumCheckout(db: D1Database, checkoutId: string, chainId: number,
  contractAddress: string | null): Promise<EthereumCheckoutRow | null> {
  return db.prepare(`SELECT * FROM ethereum_delivery_checkouts
    WHERE checkout_id = ? AND chain_id = ? AND contract_address = ?`)
    .bind(checkoutId, chainId, contractAddress).first<EthereumCheckoutRow>();
}

export function findEthereumCheckoutRequest(db: D1Database, requestId: string): Promise<EthereumCheckoutRow | null> {
  return db.prepare('SELECT * FROM ethereum_delivery_checkouts WHERE request_id = ?')
    .bind(requestId).first<EthereumCheckoutRow>();
}

export function findLatestEthereumCheckoutAttempt(db: D1Database, checkoutId: string): Promise<EthereumCheckoutAttemptRow | null> {
  return db.prepare(`SELECT * FROM ethereum_delivery_checkout_attempts
    WHERE checkout_id = ? ORDER BY CASE WHEN status = 'expired' THEN 0
      WHEN status IN ('started', 'submitted') THEN 1 ELSE 2 END, rowid DESC LIMIT 1`)
    .bind(checkoutId).first<EthereumCheckoutAttemptRow>();
}

export function findEthereumCheckoutAttempt(db: D1Database, attemptId: string): Promise<EthereumCheckoutAttemptRow | null> {
  return db.prepare('SELECT * FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ?')
    .bind(attemptId).first<EthereumCheckoutAttemptRow>();
}

export async function matchesEthereumCheckoutFailure(db: D1Database, attempt: EthereumCheckoutAttemptRow,
  quote: EthereumDeliveryRow): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM ethereum_delivery_checkout_attempts AS saved
    JOIN ethereum_delivery_quotes AS quote ON quote.order_id = saved.order_id
    WHERE saved.attempt_id = ? AND saved.checkout_id = ? AND saved.status = ?
      AND saved.transaction_hash IS ? AND saved.block_number IS ? AND saved.block_hash IS ? AND saved.updated_at_ms = ?
      AND quote.status = ? AND quote.transaction_hash IS ? AND quote.block_number IS ? AND quote.block_hash IS ?
      AND quote.updated_at_ms = ? AND quote.published_at_ms IS ?
      AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts AS other
        WHERE other.checkout_id = saved.checkout_id
          AND (other.rowid > saved.rowid OR other.status IN ('started', 'submitted', 'expired')))`)
    .bind(attempt.attempt_id, attempt.checkout_id, attempt.status, attempt.transaction_hash,
      attempt.block_number, attempt.block_hash, attempt.updated_at_ms,
      quote.status, quote.transaction_hash, quote.block_number, quote.block_hash, quote.updated_at_ms, quote.published_at_ms).first());
}

export async function insertEthereumCheckout(db: D1Database, row: EthereumCheckoutRow): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO ethereum_delivery_checkouts
    (checkout_id, request_id, origin, drop_id, chain_id, contract_address, token_ids_json, items_json,
      callback_url, callback_state, created_block, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.checkout_id, row.request_id, row.origin, row.drop_id, row.chain_id, row.contract_address,
      row.token_ids_json, row.items_json, row.callback_url, row.callback_state, row.created_block, row.created_at_ms, row.expires_at_ms).run();
}

export async function insertEthereumCheckoutAttempt(db: D1Database, quote: EthereumDeliveryRow,
  args: { attemptId: string; checkoutId: string; quoteDeadline: number; expectedNonce: string; nowMs: number },
  guard: EthereumCheckoutGuard): Promise<boolean> {
  const result = await db.prepare(`INSERT OR IGNORE INTO ethereum_delivery_checkout_attempts
    (attempt_id, checkout_id, order_id, wallet, status, quote_deadline, expected_nonce, created_at_ms, updated_at_ms)
    SELECT ?, ?, quote.order_id, quote.wallet, 'started', quote.deadline, ?, ?, ? FROM ethereum_delivery_quotes AS quote
    WHERE quote.checkout_id = ? AND quote.order_id = ? AND quote.wallet = ? AND quote.status = 'prepared' AND quote.deadline = ?
      AND quote.updated_at_ms = ? AND quote.transaction_hash IS NULL
      AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts AS terminal
        WHERE terminal.checkout_id = quote.checkout_id AND terminal.status = 'expired')
      AND ${guard.sql}`)
    .bind(args.attemptId, args.checkoutId, args.expectedNonce, args.nowMs, args.nowMs,
      args.checkoutId, quote.order_id, quote.wallet, args.quoteDeadline, quote.updated_at_ms, ...guard.values).run();
  return result.meta.changes === 1;
}

export async function rejectEthereumCheckoutAttempt(db: D1Database, attemptId: string, nowMs: number): Promise<void> {
  await db.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = 'rejected',
    updated_at_ms = MAX(updated_at_ms + 1, ?) WHERE attempt_id = ? AND status = 'started' AND transaction_hash IS NULL`)
    .bind(nowMs, attemptId).run();
}

export async function reportEthereumCheckoutAttempt(db: D1Database, attemptId: string, transactionHash: string,
  nowMs: number): Promise<void> {
  await db.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = 'submitted', transaction_hash = ?,
    updated_at_ms = MAX(updated_at_ms + 1, ?) WHERE attempt_id = ? AND status = 'started' AND transaction_hash IS NULL`)
    .bind(transactionHash, nowMs, attemptId).run();
}

export async function replaceEthereumCheckoutAttempt(db: D1Database, previous: EthereumCheckoutAttemptRow,
  args: { attemptId: string; transactionHash: string; nonce: string; from: string; nowMs: number; updatedAtMs: number }): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = 'superseded', updated_at_ms = ?
      WHERE attempt_id = ? AND updated_at_ms = ? AND status = ? AND transaction_hash IS ?`)
      .bind(args.updatedAtMs, previous.attempt_id, previous.updated_at_ms, previous.status, previous.transaction_hash),
    db.prepare(`INSERT INTO ethereum_delivery_checkout_attempts
      (attempt_id, checkout_id, order_id, wallet, status, transaction_hash, quote_deadline, expected_nonce,
        transaction_nonce, transaction_sender, created_at_ms, updated_at_ms)
      SELECT ?, checkout_id, order_id, wallet, 'submitted', ?, quote_deadline, expected_nonce, ?, ?, ?, ?
      FROM ethereum_delivery_checkout_attempts WHERE attempt_id = ? AND status = 'superseded' AND updated_at_ms = ?`)
      .bind(args.attemptId, args.transactionHash, args.nonce, args.from, args.nowMs, args.updatedAtMs,
        previous.attempt_id, args.updatedAtMs),
  ]);
}

export async function saveEthereumCheckoutProof(db: D1Database, attempt: EthereumCheckoutAttemptRow,
  proof: { nonce: string; from: string }): Promise<void> {
  await db.prepare(`UPDATE ethereum_delivery_checkout_attempts
    SET transaction_nonce = ?, transaction_sender = ? WHERE attempt_id = ? AND transaction_hash = ? AND status = 'submitted'`)
    .bind(proof.nonce, proof.from, attempt.attempt_id, attempt.transaction_hash).run();
}

export async function expireEthereumCheckoutAttempt(db: D1Database, quote: EthereumDeliveryRow,
  attempt: EthereumCheckoutAttemptRow, snapshot: { blockNumber: number; blockHash: string }, nowMs: number): Promise<void> {
  await db.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = 'expired',
    block_number = ?, block_hash = ?, verified_at_block = ?, updated_at_ms = MAX(updated_at_ms + 1, ?)
    WHERE attempt_id = ? AND status = ? AND transaction_hash IS ? AND updated_at_ms = ?
      AND EXISTS (SELECT 1 FROM ethereum_delivery_quotes WHERE order_id = ? AND checkout_id = ?
        AND chain_id = ? AND contract_address = ? AND status = 'prepared' AND transaction_hash IS NULL
        AND deadline = ? AND updated_at_ms = ?)`)
    .bind(snapshot.blockNumber, snapshot.blockHash, snapshot.blockNumber, nowMs,
      attempt.attempt_id, attempt.status, attempt.transaction_hash, attempt.updated_at_ms,
      quote.order_id, attempt.checkout_id, quote.chain_id, quote.contract_address, quote.deadline, quote.updated_at_ms).run();
}

export async function hasExpiredEthereumCheckout(db: D1Database, checkoutId: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM ethereum_delivery_checkout_attempts
    WHERE checkout_id = ? AND status = 'expired' LIMIT 1`).bind(checkoutId).first());
}

export async function restoreSubmittedEthereumCheckoutAttempt(db: D1Database, attempt: EthereumCheckoutAttemptRow,
  nowMs: number): Promise<void> {
  await db.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = 'submitted',
    block_number = NULL, block_hash = NULL, verified_at_block = NULL, updated_at_ms = MAX(updated_at_ms + 1, ?)
    WHERE attempt_id = ? AND status = ? AND transaction_hash = ? AND updated_at_ms = ?
      AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts AS active
        WHERE active.checkout_id = ? AND active.status IN ('started', 'submitted', 'expired'))`)
    .bind(nowMs, attempt.attempt_id, attempt.status, attempt.transaction_hash, attempt.updated_at_ms, attempt.checkout_id).run();
}

export async function recordEthereumCheckoutFailure(db: D1Database, attempt: EthereumCheckoutAttemptRow,
  args: { status: 'reverted' | 'failed'; blockNumber: number; blockHash: string; verifiedAtBlock: number; nowMs: number }): Promise<void> {
  await db.prepare(`UPDATE ethereum_delivery_checkout_attempts SET status = ?, block_number = ?, block_hash = ?,
    verified_at_block = ?, updated_at_ms = MAX(updated_at_ms + 1, ?) WHERE attempt_id = ? AND transaction_hash = ?
      AND status IN ('submitted', 'reverted', 'failed')`)
    .bind(args.status, args.blockNumber, args.blockHash, args.verifiedAtBlock, args.nowMs,
      attempt.attempt_id, attempt.transaction_hash).run();
}

export async function isEthereumCheckoutAvailable(db: D1Database, checkoutId: string | null,
  guard: EthereumCheckoutGuard): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 WHERE ${guard.sql}
    AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts
      WHERE checkout_id = ? AND status IN ('started', 'submitted', 'expired'))`)
    .bind(...guard.values, checkoutId).first());
}
