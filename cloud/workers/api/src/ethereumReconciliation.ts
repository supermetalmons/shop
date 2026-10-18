import { decodeEventLogs, decodeReturn, encodeCall, ETHEREUM_EVENT_TOPICS, type EthereumDecodedEvent } from '../../../../shared/ethereum/abi.js';
import { ethereumHexQuantity } from '../../../../shared/ethereum/protocol.js';
import { cleanupEthereumAuth } from './ethereumAuth.js';
import {
  confirmEthereumClaim, confirmEthereumDelivery, retireEthereumDelivery, type EthereumClaimRow, type EthereumDeliveryRow,
} from './ethereumCommerce.js';
import {
  ethereumCall, ethereumConfig, ethereumRpc, rpcInteger,
  type EthereumContext, type EthereumEnvironment,
} from './ethereumRuntime.js';
import { ethereumReceipt, ethereumTokenInfos, parseEthereumLog } from './ethereumRead.js';
import { EthereumApiError } from './ethereumError.js';
import { CommerceWriteConflict, D1CommerceRepository, commerceKeys } from './commerceRepository.js';
import { createTimedAbortScope, isSignalCancellationError } from './boundedRequest.js';
import { emptyReconciliationResult, recordReconciliationOutcome, reportReconciliationResult, type ReconciliationOptions, type ReconciliationResult } from './reconciliationResult.js';

const REORG_WINDOW_BLOCKS = 64;
const RECENT_RECONCILIATION_TIMEOUT_MS = 30_000;

type QueryBudget = { remaining: number; exhausted: boolean; limited: boolean };

function budgetedDatabase(db: D1Database, budget: QueryBudget): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const reserve = (count: number) => {
    if (count > budget.remaining) {
      budget.exhausted = true;
      budget.limited = true;
      throw new Error('Ethereum reconciliation query limit reached');
    }
    budget.remaining -= count;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (['first', 'all', 'run', 'raw'].includes(String(property))) return (...args: unknown[]) => {
          reserve(1);
          return Reflect.apply(Reflect.get(target, property), target, args);
        };
        return Reflect.get(target, property, target);
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (property === 'batch') return (statements: D1PreparedStatement[]) => {
        reserve(statements.length);
        return target.batch(statements.map((statement) => originals.get(statement) || statement));
      };
      return Reflect.get(target, property, target);
    },
  });
}

async function recoverableReceipt(context: EthereumContext, transactionHash: string) {
  try { return await ethereumReceipt(context, transactionHash); }
  catch (error) {
    if (error instanceof EthereumApiError && error.details && typeof error.details === 'object' &&
      'kind' in error.details && error.details.kind === 'transaction-reverted') return { receipt: null, confirmations: 0 };
    throw error;
  }
}

async function reconcileRecentDeliveries(context: EthereumContext, summary: ReconciliationResult, failures: unknown[], budget: QueryBudget): Promise<void> {
  const deliveries = await context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_delivery_quotes
    WHERE chain_id = ? AND contract_address = ? AND transaction_hash IS NOT NULL AND
      (status = 'pending' OR published_at_ms IS NULL OR verified_at_block IS NULL OR verified_at_block < block_number + ${REORG_WINDOW_BLOCKS})
    ORDER BY updated_at_ms ASC LIMIT 20`)
    .bind(context.config.chainId, context.config.contractAddress).all<EthereumDeliveryRow>();
  for (const row of deliveries.results) {
    context.signal.throwIfAborted();
    try {
      const result = await recoverableReceipt(context, row.transaction_hash!);
      const hasDelivery = result.receipt && decodeEventLogs(result.receipt.logs, row.contract_address)
        .some((event) => event.name === 'DeliveryRedeemed' && event.orderId === row.order_id);
      if (!hasDelivery) {
        const retired = await retireEthereumDelivery(context, row);
        if (!retired) {
          await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_delivery_quotes SET updated_at_ms = MAX(updated_at_ms + 1, ?)
            WHERE chain_id = ? AND contract_address = ? AND order_id = ? AND status = ?
              AND transaction_hash IS ? AND block_number IS ? AND block_hash IS ? AND updated_at_ms = ?`)
            .bind(context.nowMs, row.chain_id, row.contract_address, row.order_id, row.status,
              row.transaction_hash, row.block_number, row.block_hash, row.updated_at_ms).run();
        }
        recordReconciliationOutcome(summary, retired ? 'completed' : 'deferred');
      } else {
        const outcome = await confirmEthereumDelivery(context, row.order_id, row.transaction_hash!, { ...result, row });
        recordReconciliationOutcome(summary, outcome.status === 'confirmed' ? 'completed' : 'deferred');
      }
    } catch (error) {
      context.signal.throwIfAborted();
      if (budget.exhausted) { recordReconciliationOutcome(summary, 'deferred'); break; }
      if (error instanceof CommerceWriteConflict) { recordReconciliationOutcome(summary, 'deferred'); continue; }
      recordReconciliationOutcome(summary, 'failed');
      failures.push(error);
    }
  }
}

async function reconcileRecentClaims(context: EthereumContext, summary: ReconciliationResult, failures: unknown[], budget: QueryBudget): Promise<void> {
  const claims = await context.env.COMMERCE_DB.prepare(`SELECT * FROM ethereum_crate_claims
    WHERE chain_id = ? AND contract_address = ? AND transaction_hash IS NOT NULL AND
      (status IN ('pending', 'available') OR verified_at_block IS NULL OR verified_at_block < block_number + ${REORG_WINDOW_BLOCKS})
    ORDER BY updated_at_ms ASC LIMIT 20`)
    .bind(context.config.chainId, context.config.contractAddress).all<EthereumClaimRow>();
  for (const row of claims.results) {
    context.signal.throwIfAborted();
    try {
      const result = await recoverableReceipt(context, row.transaction_hash!);
      const hasClaim = result.receipt && decodeEventLogs(result.receipt.logs, row.contract_address)
        .some((event) => event.name === 'CrateReceiptClaimed' && event.claimId === row.claim_id);
      if (!hasClaim) {
        const [usedResult, [info]] = await Promise.all([
          ethereumCall(context, encodeCall('usedClaims(bytes32)', ['bytes32'], [row.claim_id])),
          ethereumTokenInfos(context, [row.receipt_id]),
        ]);
        const [used] = decodeReturn(['bool'], usedResult);
        if (used || info?.kind !== 'crate_receipt' || info.displayId !== row.crate_id) {
          await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_crate_claims SET updated_at_ms = MAX(updated_at_ms + 1, ?)
            WHERE chain_id = ? AND contract_address = ? AND receipt_id = ? AND order_id = ? AND claim_id = ?
              AND status = ? AND transaction_hash IS ? AND block_number IS ? AND block_hash IS ? AND updated_at_ms = ?`)
            .bind(context.nowMs, row.chain_id, row.contract_address, row.receipt_id, row.order_id, row.claim_id,
              row.status, row.transaction_hash, row.block_number, row.block_hash, row.updated_at_ms).run();
          recordReconciliationOutcome(summary, 'deferred');
          continue;
        }
        const updated = await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_crate_claims SET status = 'available', verified_at_block = NULL,
          updated_at_ms = MAX(updated_at_ms + 1, ?)
          WHERE chain_id = ? AND contract_address = ? AND receipt_id = ? AND order_id = ? AND claim_id = ?
            AND status = ? AND transaction_hash IS ? AND block_hash IS ? AND updated_at_ms = ?`)
          .bind(context.nowMs, row.chain_id, row.contract_address, row.receipt_id, row.order_id, row.claim_id,
            row.status, row.transaction_hash, row.block_hash, row.updated_at_ms).run();
        if (updated.meta.changes !== 1) { recordReconciliationOutcome(summary, 'deferred'); continue; }
        const retiredAtMs = Math.max(context.nowMs, row.updated_at_ms + 1);
        const repository = new D1CommerceRepository(context.env.COMMERCE_DB);
        const key = commerceKeys.deliveryOrder(context.config.dropId, String(row.order_id));
        const projected = await repository.run(context.nowMs, async (unit) => {
          const order = await unit.get(key);
          const current = await context.env.COMMERCE_DB.prepare(`SELECT 1 FROM ethereum_crate_claims
            WHERE chain_id = ? AND contract_address = ? AND receipt_id = ? AND claim_id = ? AND order_id = ? AND status = 'available'
              AND transaction_hash IS ? AND block_number IS ? AND block_hash IS ? AND updated_at_ms = ?`)
            .bind(row.chain_id, row.contract_address, row.receipt_id, row.claim_id, row.order_id,
              row.transaction_hash, row.block_number, row.block_hash, retiredAtMs).first();
          if (!current) return false;
          unit.expectEthereumState({ kind: 'claim', chainId: row.chain_id, contractAddress: row.contract_address,
            id: row.receipt_id, orderId: row.order_id, claimId: row.claim_id, status: 'available',
            transactionHash: row.transaction_hash, blockNumber: row.block_number, blockHash: row.block_hash,
            updatedAtMs: retiredAtMs });
          if (order && Array.isArray(order.data.irlClaims)) {
            await unit.update(key, { irlClaims: order.data.irlClaims.map((claim) => claim && typeof claim === 'object' &&
              !Array.isArray(claim) && claim.boxId === row.crate_id && claim.code === row.code ? { ...claim, status: 'available' } : claim) });
          }
          return true;
        });
        if (!projected) { recordReconciliationOutcome(summary, 'deferred'); continue; }
        const acknowledged = await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_crate_claims SET transaction_hash = NULL,
          block_number = NULL, block_hash = NULL WHERE chain_id = ? AND contract_address = ? AND receipt_id = ?
            AND order_id = ? AND claim_id = ? AND status = 'available' AND transaction_hash IS ?
            AND block_number IS ? AND block_hash IS ? AND updated_at_ms = ?`)
          .bind(row.chain_id, row.contract_address, row.receipt_id, row.order_id, row.claim_id,
            row.transaction_hash, row.block_number, row.block_hash, retiredAtMs).run();
        recordReconciliationOutcome(summary, acknowledged.meta.changes === 1 ? 'completed' : 'deferred');
      } else {
        const outcome = await confirmEthereumClaim(context, row.claim_id, row.transaction_hash!, { ...result, row });
        recordReconciliationOutcome(summary, outcome.status === 'confirmed' ? 'completed' : 'deferred');
      }
    } catch (error) {
      context.signal.throwIfAborted();
      if (budget.exhausted) { recordReconciliationOutcome(summary, 'deferred'); return; }
      if (error instanceof CommerceWriteConflict) { recordReconciliationOutcome(summary, 'deferred'); continue; }
      recordReconciliationOutcome(summary, 'failed');
      failures.push(error);
    }
  }
}

type ReconciliationEvent = Extract<EthereumDecodedEvent, { name: 'DeliveryRedeemed' | 'CrateReceiptClaimed' }>;

function eventKey(event: ReconciliationEvent): string {
  return `${event.name}:${event.name === 'DeliveryRedeemed' ? event.orderId : event.claimId}:${event.log.transactionHash}:${event.log.blockHash}`;
}

async function completedEvents(context: EthereumContext, events: ReconciliationEvent[]): Promise<Set<string>> {
  const statements: D1PreparedStatement[] = [];
  for (const name of ['DeliveryRedeemed', 'CrateReceiptClaimed'] as const) {
    const ids = [...new Set(events.flatMap((event) => event.name === name
      ? [String(event.name === 'DeliveryRedeemed' ? event.orderId : event.claimId)] : []))];
    for (let offset = 0; offset < ids.length; offset += 90) {
      const page = ids.slice(offset, offset + 90);
      const placeholders = page.map(() => '?').join(',');
      statements.push(name === 'DeliveryRedeemed'
        ? context.env.COMMERCE_DB.prepare(`SELECT 'DeliveryRedeemed' AS name, order_id AS id, transaction_hash, block_hash
            FROM ethereum_delivery_quotes WHERE chain_id = ? AND contract_address = ? AND status = 'confirmed'
              AND published_at_ms IS NOT NULL AND order_id IN (${placeholders})`)
          .bind(context.config.chainId, context.config.contractAddress, ...page)
        : context.env.COMMERCE_DB.prepare(`SELECT 'CrateReceiptClaimed' AS name, claim_id AS id, transaction_hash, block_hash
            FROM ethereum_crate_claims AS claim WHERE chain_id = ? AND contract_address = ? AND status = 'claimed'
              AND claim_id IN (${placeholders}) AND EXISTS (
                SELECT 1 FROM commerce_documents AS document, json_each(document.document_json, '$.irlClaims') AS projected
                WHERE document.document_path = ? || CAST(claim.order_id AS TEXT)
                  AND json_extract(projected.value, '$.boxId') = claim.crate_id
                  AND json_extract(projected.value, '$.code') = claim.code
                  AND json_extract(projected.value, '$.status') = 'claimed')`)
          .bind(context.config.chainId, context.config.contractAddress, ...page, `drops/${context.config.dropId}/deliveryOrders/`));
    }
  }
  if (!statements.length) return new Set();
  const results = await context.env.COMMERCE_DB.batch<{ name: string; id: string | number; transaction_hash: string; block_hash: string }>(statements);
  return new Set(results.flatMap((result) => result.results.map((row) => `${row.name}:${row.id}:${row.transaction_hash}:${row.block_hash}`)));
}

async function scanEthereumEvents(context: EthereumContext, start: number, finish: number, scanEnd: number, summary: ReconciliationResult, budget: QueryBudget): Promise<void> {
  const ranges = [{ start, finish }];
  let requests = 0;
  let confirmations = 0;
  let savedNextBlock = start;
  const checkpoint = async (nextBlock: number) => {
    const result = await context.env.COMMERCE_DB.prepare(`UPDATE ethereum_reconciliation_cursor
      SET next_block = ?, scan_end_block = CASE WHEN ? > scan_end_block THEN NULL ELSE scan_end_block END
      WHERE chain_id = ? AND contract_address = ? AND next_block = ? AND scan_end_block = ?`)
      .bind(nextBlock, nextBlock, context.config.chainId, context.config.contractAddress, savedNextBlock, scanEnd).run();
    if (result.meta.changes !== 1) {
      recordReconciliationOutcome(summary, 'deferred');
      return false;
    }
    savedNextBlock = nextBlock;
    return true;
  };
  while (ranges.length && requests < 64) {
    context.signal.throwIfAborted();
    const range = ranges.shift()!;
    const split = () => {
      const middle = Math.floor((range.start + range.finish) / 2);
      ranges.unshift({ start: range.start, finish: middle }, { start: middle + 1, finish: range.finish });
    };
    let raw: unknown;
    requests++;
    try {
      raw = await ethereumRpc(context, 'eth_getLogs', [{ address: context.config.contractAddress,
        fromBlock: ethereumHexQuantity(range.start), toBlock: ethereumHexQuantity(range.finish),
        topics: [[ETHEREUM_EVENT_TOPICS.DeliveryRedeemed, ETHEREUM_EVENT_TOPICS.CrateReceiptClaimed]] }]);
    } catch (error) {
      context.signal.throwIfAborted();
      if (range.start === range.finish) throw error;
      split();
      continue;
    }
    if (!Array.isArray(raw)) throw new Error('Invalid Ethereum reconciliation event page');
    if (raw.length > 1000 && range.start < range.finish) { split(); continue; }
    const events = decodeEventLogs(raw.map(parseEthereumLog), context.config.contractAddress!)
      .filter((event): event is ReconciliationEvent => event.name === 'DeliveryRedeemed' || event.name === 'CrateReceiptClaimed')
      .sort((left, right) => rpcInteger(left.log.blockNumber) - rpcInteger(right.log.blockNumber) ||
        rpcInteger(left.log.logIndex) - rpcInteger(right.log.logIndex));
    const completed = await completedEvents(context, events);
    for (let index = 0; index < events.length; index++) {
      context.signal.throwIfAborted();
      const event = events[index];
      const block = rpcInteger(event.log.blockNumber);
      if (block < range.start || block > range.finish) throw new Error('Ethereum reconciliation event is outside its block range');
      if (!completed.has(eventKey(event))) {
        if (confirmations >= 40) { budget.limited = true; await checkpoint(block); return; }
        const hash = event.log.transactionHash;
        if (!hash) throw new Error('Ethereum reconciliation event is missing its transaction');
        let result;
        try {
          result = event.name === 'DeliveryRedeemed' ? await confirmEthereumDelivery(context, event.orderId, hash) :
            await confirmEthereumClaim(context, event.claimId, hash);
        } catch (error) {
          context.signal.throwIfAborted();
          if (!budget.exhausted) throw error;
          recordReconciliationOutcome(summary, 'deferred');
          return;
        }
        confirmations++;
        recordReconciliationOutcome(summary, result.status === 'confirmed' ? 'completed' : 'deferred');
        if (result.status === 'pending' && result.confirmations === 0) { await checkpoint(block); return; }
      }
    }
    if (!await checkpoint(range.finish + 1)) return;
  }
  if (ranges.length || finish < scanEnd) budget.limited = true;
}

export async function reconcileEthereum111k(env: EthereumEnvironment, signal: AbortSignal, options: ReconciliationOptions & {
  fetch?: typeof fetch; nowMs?: () => number;
} = {}): Promise<ReconciliationResult> {
  const summary = emptyReconciliationResult();
  const failures: unknown[] = [];
  try {
    const config = ethereumConfig(env);
    const budget: QueryBudget = { remaining: 400, exhausted: false, limited: false };
    const context: EthereumContext = { env: { ...env, COMMERCE_DB: budgetedDatabase(env.COMMERCE_DB, budget) },
      config, signal, fetch: options.fetch || fetch, nowMs: (options.nowMs || Date.now)() };
    await cleanupEthereumAuth(env.OPS_DB, context.nowMs);
    if (!config.enabled || !config.contractAddress) return summary;
    const recentScope = createTimedAbortScope(signal, {
      timeoutMs: RECENT_RECONCILIATION_TIMEOUT_MS, timeoutMessage: 'Recent Ethereum reconciliation timed out',
    });
    const recentContext = { ...context, signal: recentScope.signal };
    const recentBudgets: QueryBudget[] = [
      { remaining: 100, exhausted: false, limited: false },
      { remaining: 100, exhausted: false, limited: false },
    ];
    let head: number | undefined;
    let recentTimedOut = false;
    try {
      const headRequest = ethereumRpc(recentContext, 'eth_blockNumber', []).then((value) => { head = rpcInteger(value); });
      const results = await Promise.allSettled([
        headRequest,
        ...[reconcileRecentDeliveries, reconcileRecentClaims].map((reconcile, index) => {
          const phaseBudget = recentBudgets[index];
          return reconcile({ ...recentContext, env: { ...env, COMMERCE_DB: budgetedDatabase(env.COMMERCE_DB, phaseBudget) } },
            summary, failures, phaseBudget);
        }),
      ]);
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      const failure = rejected.find((result) => !isSignalCancellationError(recentScope.signal, result.reason)) ?? rejected[0];
      if (failure) throw failure.reason;
    } catch (error) {
      signal.throwIfAborted();
      recentTimedOut = recentScope.timedOut() && isSignalCancellationError(recentScope.signal, error);
      if (!recentTimedOut) throw error;
      recordReconciliationOutcome(summary, 'deferred');
    } finally {
      recentScope.dispose();
      for (const phaseBudget of recentBudgets) {
        budget.remaining -= 100 - phaseBudget.remaining;
        budget.limited ||= phaseBudget.limited;
      }
    }
    if (head !== undefined) context.chainCheck = recentContext.chainCheck;
    head ??= rpcInteger(await ethereumRpc(context, 'eth_blockNumber', []));
    const saved = await context.env.COMMERCE_DB.prepare(`SELECT next_block, scan_end_block FROM ethereum_reconciliation_cursor WHERE chain_id = ? AND contract_address = ?`)
      .bind(config.chainId, config.contractAddress).first<{ next_block: number; scan_end_block: number | null }>();
    const activeScan = saved?.scan_end_block != null && saved.next_block <= saved.scan_end_block;
    const lastScannedBlock = (saved?.next_block ?? config.deploymentBlock) - 1;
    const start = activeScan ? saved.next_block : Math.max(config.deploymentBlock, lastScannedBlock - REORG_WINDOW_BLOCKS);
    const scanEnd = activeScan ? saved.scan_end_block! : Math.min(head, start + 1999);
    const finish = Math.min(head, scanEnd);
    if (finish >= start) {
      try {
        const begun = activeScan || (await context.env.COMMERCE_DB.prepare(`
          INSERT INTO ethereum_reconciliation_cursor (chain_id, contract_address, next_block, scan_end_block)
          VALUES (?, ?, ?, ?) ON CONFLICT(chain_id, contract_address) DO UPDATE
          SET next_block = excluded.next_block, scan_end_block = excluded.scan_end_block
          WHERE ethereum_reconciliation_cursor.next_block = ? AND ethereum_reconciliation_cursor.scan_end_block IS ?`)
          .bind(config.chainId, config.contractAddress, start, scanEnd, saved?.next_block ?? start, saved?.scan_end_block ?? null).run()).meta.changes === 1;
        if (begun) await scanEthereumEvents(context, start, finish, scanEnd, summary, budget);
        else recordReconciliationOutcome(summary, 'deferred');
      } catch (error) {
        context.signal.throwIfAborted();
        if (!budget.exhausted) throw error;
        recordReconciliationOutcome(summary, 'deferred');
      }
    }
    if (recentTimedOut || budget.limited) Object.assign(summary, {
      stopReason: recentTimedOut ? 'time-limit' : 'item-limit', hasMore: true,
    });
    if (failures.length) throw failures[0];
    return summary;
  } catch (error) {
    if (!failures.includes(error)) recordReconciliationOutcome(summary, 'failed');
    throw error;
  } finally { reportReconciliationResult(summary, options.onResult); }
}
