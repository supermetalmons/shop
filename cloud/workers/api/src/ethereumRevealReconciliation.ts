import { ETHEREUM_REVEAL_CATALOG_VERSION, ETHEREUM_REVEAL_DEPLOYMENTS_SQL,
  parseEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { emptyReconciliationResult, recordReconciliationOutcome, reportReconciliationResult,
  type ReconciliationOptions, type ReconciliationResult } from './reconciliationResult.js';

type RevealReconciliationEnvironment = {
  OPS_DB: { prepare(sql: string): {
    bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> };
  } };
  ETHEREUM_REVEAL?: { getByName(name: string): { watchdog(deployment: EthereumRevealDeployment): Promise<void> } };
};

export async function reconcileEthereumReveals(env: RevealReconciliationEnvironment, signal: AbortSignal,
  options: ReconciliationOptions = {}): Promise<ReconciliationResult> {
  const summary = emptyReconciliationResult();
  try {
    const namespace = env.ETHEREUM_REVEAL;
    if (!namespace) return summary;
    const rows = await env.OPS_DB.prepare(`${ETHEREUM_REVEAL_DEPLOYMENTS_SQL} WHERE catalog_version=? AND retired_at_ms IS NULL ORDER BY updated_at_ms ASC LIMIT 100`)
      .bind(ETHEREUM_REVEAL_CATALOG_VERSION).all<Record<string, unknown>>();
    let failed = false;
    for (let offset = 0; offset < rows.results.length; offset += 4) {
      signal.throwIfAborted();
      const results = await Promise.allSettled(rows.results.slice(offset, offset + 4).map(async row => {
        const deployment = parseEthereumRevealDeployment(row);
        try {
          await namespace.getByName(`${deployment.chainId}:${deployment.contractAddress}`).watchdog(deployment);
        } finally {
          await env.OPS_DB.prepare('UPDATE ethereum_reveal_deployments SET updated_at_ms=? WHERE deployment_id=? AND retired_at_ms IS NULL')
            .bind(Date.now(), deployment.deploymentId).run();
        }
      }));
      for (const result of results) recordReconciliationOutcome(summary, result.status === 'fulfilled' ? 'completed' : 'failed');
      failed ||= results.some(result => result.status === 'rejected');
    }
    if (rows.results.length === 100) Object.assign(summary, { hasMore: true, stopReason: 'item-limit' });
    if (failed) throw new Error('Ethereum reveal reconciliation needs retry.');
    return summary;
  } finally { reportReconciliationResult(summary, options.onResult); }
}
