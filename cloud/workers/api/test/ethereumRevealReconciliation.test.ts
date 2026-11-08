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
    deployment_block: 100, catalog_version: '111k-v5',
    template_json: JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://cdn.lil.org/nft/111k/placeholder.png', attributes: [] }),
    template_sha256: 'a'.repeat(64), state: 'active', revision: 3, created_at_ms: index,
    updated_at_ms: index, provisioned_at_ms: 1, activated_at_ms: 2, last_error: null,
    retired_at_ms: null as number | null, replacement_deployment_id: null as string | null,
  }));
  const visited: string[] = [];
  const names: string[] = [];
  let concurrency = 0;
  let peak = 0;
  const env = {
    OPS_DB: { prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all<T>() {
              assert.match(sql, /WHERE catalog_version=\? AND retired_at_ms IS NULL ORDER BY updated_at_ms ASC LIMIT 100/);
              assert.deepEqual(values, ['111k-v5']);
              return { results: rows.filter(row => row.catalog_version === values[0] && row.retired_at_ms === null)
                .sort((a, b) => a.updated_at_ms - b.updated_at_ms).slice(0, 100).map(row => ({ ...row })) as T[] };
            },
            async run() {
              assert.equal(sql, 'UPDATE ethereum_reveal_deployments SET updated_at_ms=? WHERE deployment_id=? AND retired_at_ms IS NULL');
              assert.equal(typeof values[0], 'number');
              const row = rows.find(value => value.deployment_id === values[1]);
              assert.ok(row);
              row.updated_at_ms = Number(values[0]);
            },
          };
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

test('watchdog excludes explicitly retired deployments even when their catalog is current', async () => {
  const { env, visited, rows } = fixture(130);
  for (const row of rows.slice(0, 125)) {
    row.state = 'paused';
    row.retired_at_ms = 100;
    row.replacement_deployment_id = 'test-129';
  }
  const retired = structuredClone(rows.slice(0, 125));
  const result = await reconcileEthereumReveals(env, new AbortController().signal);
  assert.equal(result.attempted, 5);
  assert.deepEqual(visited, ['test-125', 'test-126', 'test-127', 'test-128', 'test-129']);
  assert.deepEqual(rows.slice(0, 125), retired);
});

for (const catalogVersion of ['111k-v1', '111k-v2', '111k-v3']) test(`watchdog excludes retired catalog ${catalogVersion} before its bounded page without changing historical rows`, async () => {
  const { env, visited, rows } = fixture(130);
  for (const row of rows.slice(0, 125)) row.catalog_version = catalogVersion;
  const historical = structuredClone(rows.slice(0, 125));
  const summary = await reconcileEthereumReveals(env, new AbortController().signal);
  assert.deepEqual(summary, { attempted: 5, completed: 5, deferred: 0, skipped: 0, failed: 0 });
  assert.deepEqual(visited, ['test-125', 'test-126', 'test-127', 'test-128', 'test-129']);
  assert.deepEqual(rows.slice(0, 125), historical);
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
