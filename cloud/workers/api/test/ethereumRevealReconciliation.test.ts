import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileEthereumReveals } from '../src/ethereumRevealReconciliation.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import type { ReconciliationResult } from '../src/reconciliationResult.ts';

function fixture(count: number, failId?: string) {
  const rows = Array.from({ length: count }, (_, index) => ({
    deployment_id: `test-${index.toString().padStart(3, '0')}`, drop_id: '111k_devnet', chain_id: 11155111,
    contract_address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
    metadata_base_uri: `https://cdn.mons.shop/111k-sepolia/test-${index.toString().padStart(3, '0')}/`,
    deployment_block: 100, catalog_version: '111k-v1',
    template_json: JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://wip.lil.org/111k/artwork_placeholder.png', attributes: [] }),
    template_sha256: 'a'.repeat(64), state: 'active', revision: 3, created_at_ms: index,
    updated_at_ms: index, provisioned_at_ms: 1, activated_at_ms: 2, last_error: null,
  }));
  const visited: string[] = [];
  const names: string[] = [];
  let concurrency = 0;
  let peak = 0;
  const env = {
    OPS_DB: { prepare(sql: string) {
      return {
        async all<T>() {
          assert.match(sql, /ORDER BY updated_at_ms ASC LIMIT 100/);
          return { results: [...rows].sort((a, b) => a.updated_at_ms - b.updated_at_ms).slice(0, 100).map(row => ({ ...row })) as T[] };
        },
        bind(...values: unknown[]) {
          return { async run() {
            assert.equal(sql, 'UPDATE ethereum_reveal_deployments SET updated_at_ms=? WHERE deployment_id=?');
            assert.equal(typeof values[0], 'number');
            const row = rows.find(value => value.deployment_id === values[1]);
            assert.ok(row);
            row.updated_at_ms = Number(values[0]);
          } };
        },
      };
    } },
    ETHEREUM_REVEAL: { getByName(name: string) {
      names.push(name);
      return { async watchdog(deployment: EthereumRevealDeployment) {
        concurrency++;
        peak = Math.max(peak, concurrency);
        visited.push(deployment.deploymentId);
        try {
          await new Promise<void>(resolve => setImmediate(resolve));
          if (deployment.deploymentId === failId) throw new Error('RPC unavailable');
        } finally { concurrency--; }
      } };
    } },
  };
  return { env, visited, names, rows, peak: () => peak };
}

test('watchdog rotates a bounded page so later deployments are not starved', async () => {
  const { env, visited, names, rows, peak } = fixture(105);
  const first = await reconcileEthereumReveals(env, new AbortController().signal);
  assert.deepEqual(first, { attempted: 100, completed: 100, deferred: 0, skipped: 0, failed: 0, hasMore: true, stopReason: 'item-limit' });
  assert.equal(visited.length, 100);
  assert.ok(rows.slice(0, 100).every(row => row.updated_at_ms > 105));
  assert.equal(rows[104].updated_at_ms, 104);
  await reconcileEthereumReveals(env, new AbortController().signal);
  assert.equal(new Set(visited).size, 105);
  assert.deepEqual(visited.slice(100, 105), ['test-100', 'test-101', 'test-102', 'test-103', 'test-104']);
  assert.equal(names[0], `11155111:0x${'1'.padStart(40, '0')}`);
  assert.equal(peak(), 4);
});

test('one failed deployment rotates and does not prevent subsequent watchdog groups', async () => {
  const { env, visited, rows } = fixture(105, 'test-000');
  let summary: ReconciliationResult | undefined;
  await assert.rejects(reconcileEthereumReveals(env, new AbortController().signal, { onResult: value => { summary = value; } }), /needs retry/);
  assert.equal(visited.length, 100);
  assert.ok(visited.includes('test-099'));
  assert.ok(rows[0].updated_at_ms > 105);
  assert.equal(summary?.attempted, 100);
  assert.equal(summary?.completed, 99);
  assert.equal(summary?.failed, 1);
  await assert.rejects(reconcileEthereumReveals(env, new AbortController().signal), /needs retry/);
  assert.equal(new Set(visited).size, 105);
});

test('watchdog honors cancellation before starting work and reports an empty summary', async () => {
  const { env, visited } = fixture(8);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  let summary: ReconciliationResult | undefined;
  await assert.rejects(reconcileEthereumReveals(env, controller.signal, { onResult: value => { summary = value; } }), /cancelled/);
  assert.deepEqual(visited, []);
  assert.deepEqual(summary, { attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 });
});
