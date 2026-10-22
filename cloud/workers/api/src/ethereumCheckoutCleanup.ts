import type { EthereumContext } from './ethereumRuntime.js';

export async function cleanupExpiredEthereumCheckouts(context: EthereumContext): Promise<number> {
  context.signal.throwIfAborted();
  const result = await context.env.COMMERCE_DB.prepare(`DELETE FROM ethereum_delivery_checkouts
    WHERE checkout_id IN (
      SELECT checkout.checkout_id FROM ethereum_delivery_checkouts AS checkout
      WHERE checkout.chain_id = ? AND checkout.contract_address = ? AND checkout.expires_at_ms <= ?
        AND EXISTS (SELECT 1 FROM ethereum_111k_control AS control WHERE control.singleton = 1
          AND control.paused = 0 AND control.reset_guard_id IS NULL
          AND control.chain_id = checkout.chain_id AND control.contract_address = checkout.contract_address)
        AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_quotes AS quote WHERE quote.checkout_id = checkout.checkout_id)
        AND NOT EXISTS (SELECT 1 FROM ethereum_delivery_checkout_attempts AS attempt WHERE attempt.checkout_id = checkout.checkout_id)
      ORDER BY checkout.expires_at_ms, checkout.checkout_id LIMIT 100
    )`).bind(context.config.chainId, context.config.contractAddress, context.nowMs).run();
  context.signal.throwIfAborted();
  return result.meta.changes;
}
