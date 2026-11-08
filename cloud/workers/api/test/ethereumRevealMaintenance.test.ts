import assert from 'node:assert/strict';
import test from 'node:test';
import { requireRetiredRevealDeployment } from '../src/ethereumRevealMaintenanceSupport.ts';
import { loadCloudflareWorkersModule } from './cloudflareWorkersTestLoader.ts';
import { createDeferredWorkCollector } from './deferredWork.ts';

const { EthereumRevealMaintenance } = await loadCloudflareWorkersModule(() => import('../src/ethereumRevealMaintenance.ts'));
const { EthereumRevealObject } = await loadCloudflareWorkersModule(() => import('../src/ethereumRevealObject.ts'));
const oldContract = `0x${'11'.repeat(20)}`;
const currentContract = `0x${'22'.repeat(20)}`;
const request = { deploymentId: 'old-sepolia', expectedRevision: 4 };
const row = {
  deployment_id: request.deploymentId, drop_id: '111k_devnet', chain_id: 11155111, contract_address: oldContract,
  metadata_base_uri: 'https://cdn.mons.shop/111k-sepolia/old-sepolia/', deployment_block: 100, catalog_version: '111k-v4',
  template_json: '{"name":"artwork","description":"","image":"placeholder","attributes":[]}', template_sha256: 'a'.repeat(64),
  state: 'paused', revision: 4, created_at_ms: 1, updated_at_ms: 4, activated_at_ms: 3, provisioned_at_ms: 2, last_error: null,
};
const identity = { deploymentId: request.deploymentId, chainId: 11155111, contractAddress: oldContract,
  metadataBaseUri: row.metadata_base_uri, revision: 4 };

function fixture() {
  const registry = { row: { ...row } as Record<string, unknown> | null };
  const control = { paused: 0, revision: 46, paused_at_ms: null, chain_id: 11155111, contract_address: currentContract,
    reset_guard_id: null as string | null, last_reset_id: null, updated_at_ms: 1 };
  const calls: Array<{ operation: string; value: unknown }> = [];
  const object = {
    async purgeRetired(value: unknown) {
      calls.push({ operation: 'purge', value });
      return { ...identity, purged: true as const, storageEmpty: true as const, alarmCleared: true as const };
    },
    async inspectRetired(value: unknown) {
      calls.push({ operation: 'inspect', value });
      return { ...identity, storageEmpty: true, alarmCleared: true };
    },
  };
  const database = { prepare(sql: string) {
    let bound: unknown[] = [];
    const statement = { bind(...values: unknown[]) { bound = values; return statement; }, async first() {
      return sql.includes('ethereum_111k_control') ? { ...control }
        : bound[0] === request.deploymentId ? registry.row && { ...registry.row } : null;
    } };
    return statement;
  } };
  const env = { OPS_DB: database, COMMERCE_DB: database, ETHEREUM_111K_CHAIN_ID: '11155111',
    ETHEREUM_111K_CONTRACT_ADDRESS: currentContract,
    ETHEREUM_REVEAL: { getByName(name: string) { assert.equal(name, `11155111:${oldContract}`); return object; },
      idFromName: (name: string) => ({ toString: () => name }) },
    ETHEREUM_REVEAL_PUBLISHER: { getByName: () => ({ drainRetired: async () => ({ drained: true }) }) },
  } as unknown as Env;
  const deferred = createDeferredWorkCollector();
  const maintenance = new EthereumRevealMaintenance({ waitUntil: deferred.defer } as ExecutionContext, env);
  return { maintenance, registry, control, calls, object, env, deferred };
}

test('private reveal maintenance accepts only explicit identities and revisions', async () => {
  const f = fixture();
  assert.deepEqual(Object.getOwnPropertyNames(EthereumRevealMaintenance.prototype).sort(),
    ['cancelRetirement', 'constructor', 'inspectReplacement', 'inspectRetired', 'purgeRetired', 'retireForReplacement']);
  for (const value of [null, {}, { ...request, expectedRevision: 0 }, { ...request, expectedRevision: '4' },
    { ...request, deploymentId: '../old' }, { ...request, contractAddress: currentContract }]) {
    await assert.rejects(f.maintenance.purgeRetired(value), /Invalid reveal maintenance/);
    await assert.rejects(f.maintenance.inspectRetired(value), /Invalid reveal maintenance/);
  }
  assert.deepEqual(f.calls, []);
});

for (const invalid of ['missing', 'revision', 'active', 'catalog', 'future-catalog', 'mainnet', 'drop', 'configured', 'commerce', 'reset'] as const) {
  test(`maintenance rejects ${invalid} targets without contacting a Durable Object`, async () => {
    const f = fixture();
    if (invalid === 'missing') f.registry.row = null;
    if (invalid === 'revision') f.registry.row!.revision = 5;
    if (invalid === 'active') f.registry.row!.state = 'active';
    if (invalid === 'catalog') f.registry.row!.catalog_version = '111k-v5';
    if (invalid === 'future-catalog') f.registry.row!.catalog_version = '111k-v6';
    if (invalid === 'drop') f.registry.row!.drop_id = 'other';
    if (invalid === 'mainnet') {
      f.registry.row!.chain_id = 1;
      f.registry.row!.metadata_base_uri = 'https://cdn.mons.shop/111k/old-sepolia/';
    }
    if (invalid === 'configured') f.env.ETHEREUM_111K_CONTRACT_ADDRESS = oldContract;
    if (invalid === 'commerce') f.control.contract_address = oldContract;
    if (invalid === 'reset') f.control.reset_guard_id = 'unfinished';
    await assert.rejects(f.maintenance.purgeRetired(request));
    await assert.rejects(f.maintenance.inspectRetired(request));
    assert.deepEqual(f.calls, []);
  });
}

test('maintenance keeps registry and commerce control unchanged and exposes verified purge receipts', async () => {
  const f = fixture();
  const before = JSON.stringify([f.registry, f.control]);
  assert.deepEqual(await f.maintenance.purgeRetired(request), { ...identity, purged: true, storageEmpty: true, alarmCleared: true });
  assert.deepEqual(await f.maintenance.inspectRetired(request), { ...identity, storageEmpty: true, alarmCleared: true });
  await f.deferred.drain();
  assert.equal(JSON.stringify([f.registry, f.control]), before);
  assert.deepEqual(f.calls, [{ operation: 'purge', value: request }, { operation: 'inspect', value: request }]);
});

test('the coordinator checks the fresh registry and receiving object before touching storage', async () => {
  const f = fixture();
  let reads = 0;
  const context = { id: { equals: () => false }, storage: { get sql() { reads++; throw new Error('Unexpected storage access'); } } };
  const object = new EthereumRevealObject(context as unknown as DurableObjectState, f.env);
  await assert.rejects(object.purgeRetired(request), /object does not match/);
  await assert.rejects(object.inspectRetired(request), /object does not match/);
  f.registry.row!.revision = 5;
  await assert.rejects(object.purgeRetired(request), /expected retired/);
  assert.equal(reads, 0);
});

test('a failed storage purge can retry without changing the permanent registration', async () => {
  const f = fixture();
  let tables = 1, alarm: number | null = 1, deletes = 0;
  const context = { id: { equals: () => true }, waitUntil: f.deferred.defer,
    blockConcurrencyWhile: async <T>(operation: () => Promise<T>) => operation(),
    storage: {
      sql: { exec: () => ({ toArray: () => [{ count: tables }] }) }, list: async () => new Map(),
      getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; },
      deleteAll: async () => { if (++deletes === 1) throw new Error('Transient storage failure'); tables = 0; },
    },
  };
  const object = new EthereumRevealObject(context as unknown as DurableObjectState, f.env);
  await assert.rejects(object.purgeRetired(request), /Transient storage failure/);
  assert.equal(tables, 1);
  assert.deepEqual(await object.purgeRetired(request), { ...identity, purged: true, storageEmpty: true, alarmCleared: true });
  assert.equal(deletes, 2);
  assert.deepEqual(await requireRetiredRevealDeployment(f.env, request), {
    ...identity, dropId: '111k_devnet', deploymentBlock: 100, catalogVersion: '111k-v4', templateJson: row.template_json,
    templateSha256: row.template_sha256, state: 'paused', createdAtMs: 1, updatedAtMs: 4,
    activatedAtMs: 3, provisionedAtMs: 2, lastError: null,
  });
  await f.deferred.drain();
});
