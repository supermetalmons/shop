import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { d1Database } from '../cloud/workers/api/test/commerceD1Harness.ts';
import { initializeLocalEthereumReveal, localEthereumRevealBindings } from '../scripts/shared/ethereum111kLocalReveal.ts';

const contract = `0x${'33'.repeat(20)}`;
const input = { contractAddress: contract, metadataBaseUri: 'https://cdn.mons.shop/111k/local-reveal-test/', deploymentBlock: 12 };

test('local reveal bindings override remote storage with a separate local bucket and same-worker SQLite object', () => {
  const config = { durable_objects: { bindings: [{ name: 'ETHEREUM_REVEAL', script_name: 'production', class_name: 'WrongObject' }] },
    r2_buckets: [{ binding: 'ETHEREUM_REVEAL_METADATA', bucket_name: 'cdn-mons-shop', remote: true }],
    ...localEthereumRevealBindings() };
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'ETHEREUM_REVEAL', class_name: 'EthereumRevealObject' }]);
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ['EthereumRevealObject']);
  assert.equal(config.r2_buckets[0].remote, false);
  assert.equal(config.r2_buckets[0].bucket_name, 'local-ethereum-reveal-metadata');
});

test('local reveal initialization refuses nonlocal networks, RPCs and foreign contracts before database access', async () => {
  const env = { ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: contract,
    ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545',
    OPS_DB: { prepare: () => assert.fail('Database must not be accessed') },
    ETHEREUM_REVEAL: { getByName: () => assert.fail('Object must not be accessed') } };
  for (const override of [
    { ETHEREUM_111K_CHAIN_ID: '11155111' }, { ETHEREUM_111K_CHAIN_ID: '1' },
    { ETHEREUM_111K_RPC_URL: 'https://eth-mainnet.g.alchemy.com/v2/test' },
    { ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545?remote=true' },
    { ETHEREUM_111K_RPC_URL: 'http://user:secret@127.0.0.1:8545' },
    { ETHEREUM_111K_CONTRACT_ADDRESS: `0x${'44'.repeat(20)}` },
  ]) await assert.rejects(initializeLocalEthereumReveal({ ...env, ...override }, input), /requires the configured Anvil contract/);
});

test('local initialization registers, completely provisions and activates its immutable local deployment', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readFile(new URL('../cloud/workers/api/ops-migrations/0009_ethereum_reveal_deployments.sql', import.meta.url), 'utf8'));
    let calls = 0;
    const env = { ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: contract,
      ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545', OPS_DB: d1Database(db),
      ETHEREUM_REVEAL: { getByName(name: string) {
        assert.equal(name, `31337:${contract}`);
        return { async initialize(deployment) {
          assert.equal(deployment.state, 'provisioning');
          assert.equal(deployment.chainId, 31337);
          calls++;
          if (calls === 2) db.prepare(`UPDATE ethereum_reveal_deployments SET state='ready', revision=revision+1,
            provisioned_at_ms=100, updated_at_ms=100 WHERE deployment_id=?`).run(deployment.deploymentId);
          return { ready: calls === 2, seeded: calls === 2 ? 111111 : 10000 };
        } };
      } } };
    const deployment = await initializeLocalEthereumReveal(env, input);
    assert.equal(calls, 2);
    assert.equal(deployment.state, 'active');
    assert.equal(deployment.revision, 3);
    assert.equal(deployment.deploymentId, `local-${contract.slice(2)}`);
    assert.equal(deployment.metadataBaseUri, input.metadataBaseUri);
    assert.equal(deployment.provisionedAtMs, 100);
    assert.match(deployment.templateSha256, /^[a-f0-9]{64}$/);
    assert.ok(deployment.templateJson.includes('artwork_placeholder.png'));
    assert.deepEqual(await initializeLocalEthereumReveal(env, input), deployment);
    assert.equal(calls, 2);
    await assert.rejects(initializeLocalEthereumReveal(env, { ...input, deploymentBlock: 99 }), /does not match/);
  } finally { db.close(); }
});
