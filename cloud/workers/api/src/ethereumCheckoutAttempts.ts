import type { EthereumCheckoutAttemptRow } from './ethereumCheckout.js';
import { EthereumApiError } from './ethereumError.js';
import { ethereumReceipt } from './ethereumRead.js';
import type { EthereumContext } from './ethereumRuntime.js';

type CheckoutProofRow = EthereumCheckoutAttemptRow & {
  sequence: number; quote_status: string; quote_transaction_hash: string | null; quote_block_hash: string | null;
  quote_updated_at_ms: number; quote_published_at_ms: number | null;
};

export async function blockingEthereumCheckout(context: EthereumContext, scope: { wallet: string; tokenIdsJson: string }): Promise<string | null> {
  const blocked = await context.env.COMMERCE_DB.prepare(`SELECT other.checkout_id FROM ethereum_delivery_checkout_attempts AS active
    JOIN ethereum_delivery_quotes AS other ON other.order_id = active.order_id
    WHERE active.status IN ('started', 'submitted') AND other.chain_id = ? AND other.contract_address = ? AND other.wallet = ?
      AND (other.status != 'confirmed' OR other.published_at_ms IS NULL)
      AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts AS terminal
        WHERE terminal.checkout_id = other.checkout_id AND terminal.status = 'expired')
      AND EXISTS (SELECT 1 FROM json_each(other.token_ids_json) AS selected JOIN json_each(?) AS requested ON selected.value = requested.value)
    ORDER BY active.created_at_ms ASC LIMIT 1`)
    .bind(context.config.chainId, context.config.contractAddress, scope.wallet, scope.tokenIdsJson).first<{ checkout_id: string }>();
  return blocked?.checkout_id ?? null;
}

export async function inspectEthereumCheckoutFailures(context: EthereumContext,
  scope: { checkoutId: string } | { wallet: string; tokenIdsJson: string }) {
  const selection = 'checkoutId' in scope ? 'failure.checkout_id = ?' : `other.wallet = ? AND EXISTS (
    SELECT 1 FROM json_each(other.token_ids_json) AS selected JOIN json_each(?) AS requested ON selected.value = requested.value)`;
  const values = [context.config.chainId, context.config.contractAddress,
    ...('checkoutId' in scope ? [scope.checkoutId] : [scope.wallet, scope.tokenIdsJson])];
  const matching = `other.chain_id = ? AND other.contract_address = ? AND ${selection}
    AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts AS terminal
      WHERE terminal.checkout_id = failure.checkout_id AND terminal.status = 'expired')`;
  const where = `${matching} AND (failure.status IN ('reverted', 'failed') OR
    failure.status IN ('started', 'submitted') AND other.status = 'confirmed' AND other.published_at_ms IS NOT NULL)`;
  const snapshots: unknown[][] = [];
  let before: number | null = null;
  let unresolved: EthereumCheckoutAttemptRow | null = null;
  while (true) {
    context.signal.throwIfAborted();
    const page: D1Result<CheckoutProofRow> = await context.env.COMMERCE_DB.prepare(`SELECT failure.rowid AS sequence, failure.*,
      other.status AS quote_status, other.transaction_hash AS quote_transaction_hash, other.block_hash AS quote_block_hash,
      other.updated_at_ms AS quote_updated_at_ms, other.published_at_ms AS quote_published_at_ms
      FROM ethereum_delivery_checkout_attempts AS failure JOIN ethereum_delivery_quotes AS other ON other.order_id = failure.order_id
      WHERE ${where} AND (? IS NULL OR failure.rowid < ?) ORDER BY failure.rowid DESC LIMIT 10`)
      .bind(...values, before, before).all<CheckoutProofRow>();
    const checks = await Promise.all(page.results.map(async attempt => {
      const completed = attempt.status === 'started' || attempt.status === 'submitted';
      const hash = completed ? attempt.quote_transaction_hash : attempt.transaction_hash;
      if (!hash) return false;
      const verified = await ethereumReceipt(context, hash, true);
      return verified.receipt?.blockHash === (completed ? attempt.quote_block_hash : attempt.block_hash) &&
        verified.confirmations >= context.config.confirmationBlocks && (!completed || verified.receipt?.status === '0x1');
    }));
    unresolved = page.results.find((_, index) => !checks[index]) ?? null;
    if (unresolved) break;
    snapshots.push(...page.results.map(attempt => [attempt.attempt_id, attempt.status, attempt.transaction_hash,
      attempt.block_hash, attempt.updated_at_ms, attempt.quote_status, attempt.quote_transaction_hash,
      attempt.quote_block_hash, attempt.quote_updated_at_ms, attempt.quote_published_at_ms]));
    if (page.results.length < 10) break;
    before = page.results.at(-1)!.sequence;
  }
  const active = 'checkoutId' in scope ? '' : ` AND NOT EXISTS (
    SELECT 1 FROM ethereum_delivery_checkout_attempts AS failure JOIN ethereum_delivery_quotes AS other ON other.order_id = failure.order_id
    WHERE ${matching} AND failure.status IN ('started', 'submitted') AND (other.status != 'confirmed' OR other.published_at_ms IS NULL))`;
  return { unresolved, values: [...values, JSON.stringify(snapshots), ...('checkoutId' in scope ? [] : values)], sql: `NOT EXISTS (
    SELECT 1 FROM ethereum_delivery_checkout_attempts AS failure JOIN ethereum_delivery_quotes AS other ON other.order_id = failure.order_id
    WHERE ${where} AND NOT EXISTS (SELECT 1 FROM json_each(?) AS checked
      WHERE json_extract(checked.value, '$[0]') = failure.attempt_id AND json_extract(checked.value, '$[1]') = failure.status
        AND json_extract(checked.value, '$[2]') IS failure.transaction_hash AND json_extract(checked.value, '$[3]') IS failure.block_hash
        AND json_extract(checked.value, '$[4]') = failure.updated_at_ms AND (failure.status IN ('reverted', 'failed') OR
          json_extract(checked.value, '$[5]') = other.status AND json_extract(checked.value, '$[6]') IS other.transaction_hash
            AND json_extract(checked.value, '$[7]') IS other.block_hash AND json_extract(checked.value, '$[8]') = other.updated_at_ms
            AND json_extract(checked.value, '$[9]') IS other.published_at_ms)))${active}` };
}

export function requireResolvedEthereumCheckoutFailures(check: Awaited<ReturnType<typeof inspectEthereumCheckoutFailures>>): void {
  if (check.unresolved) throw new EthereumApiError('failed-precondition',
    'An earlier transaction is still being checked. Return to that checkout before starting again.',
    { blockingCheckoutId: check.unresolved.checkout_id });
}
