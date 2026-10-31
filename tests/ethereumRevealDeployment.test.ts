import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { S3Client } from '@aws-sdk/client-s3';
import test, { type TestContext } from 'node:test';
import { encodeAbi } from '../shared/ethereum/abi.ts';
import { checksumEthereumAddress } from '../shared/ethereum/crypto.ts';
import { ethereumMetadataBaseUri } from '../shared/ethereum/config.ts';
import { parseEthereumRevealDeployment, readEthereumRevealDeployment } from '../shared/ethereum/revealDeployment.ts';
import { buildEthereumRevealRegistration, buildEthereumRevealTransition, ethereumRevealRegistrationRpcKey, loadEthereumRevealRegistration, parseEthereumRevealControlArgs, runEthereumRevealControl } from '../scripts/ops/ethereumRevealControl.ts';
import { acquireMetadataPublicationLease } from '../scripts/ethereum-metadata/publicationLease.ts';
import { parseMetadataCliArgs } from '../scripts/ethereum-metadata/cli.ts';
import { metadataPrefix, metadataMd5, S3MetadataStorage, type MetadataStorage } from '../scripts/ethereum-metadata/storage.ts';
import { publishObjects } from '../scripts/ethereum-metadata/remote.ts';
import { createAsyncD1MaintenanceQuery } from '../scripts/shared/asyncD1MaintenanceQuery.ts';

const scope = { chainId: 11155111, contractAddress: `0x${'ab'.repeat(20)}` };
const templateJson = JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://wip.lil.org/111k/artwork_placeholder.png', attributes: [{ trait_type: 'type', value: 'painting' }] });
const registration = { deploymentId: 'sepolia-test-2', dropId: '111k_devnet', ...scope,
  metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/sepolia-test-2/', deploymentBlock: 12005467,
  catalogVersion: '111k-v1', templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex') };

async function fixture(t: TestContext) {
  const database = new DatabaseSync(':memory:');
  database.exec(await readFile(new URL('../cloud/workers/api/ops-migrations/0009_ethereum_reveal_deployments.sql', import.meta.url), 'utf8'));
  t.after(() => database.close());
  const query = (sql: string) => database.prepare(sql).all();
  return { database, query, register: () => parseEthereumRevealDeployment(query(buildEthereumRevealRegistration(registration))[0]) };
}

function registrationIdentity(value = registration) {
  const { templateJson: _template, templateSha256: _hash, ...identity } = value;
  return identity;
}

async function controlManifest(t: TestContext, value: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'reveal-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = join(directory, 'deployment.json');
  await writeFile(manifest, JSON.stringify(value));
  return manifest;
}

test('reveal registration permanently binds deployment, scope, prefix and template', async t => {
  const { database, query, register } = await fixture(t);
  const row = register();
  assert.equal(row.state, 'provisioning');
  for (const assignment of ["metadata_base_uri = 'https://cdn.mons.shop/111k-sepolia/other/'", "template_json = '{}'", "chain_id = 1", "deployment_block = 5"]) {
    assert.throws(() => database.exec(`UPDATE ethereum_reveal_deployments SET ${assignment}`), /immutable/);
  }
  assert.throws(() => database.exec('DELETE FROM ethereum_reveal_deployments'), /permanent/);
  assert.throws(() => query(buildEthereumRevealRegistration({ ...registration, deploymentId: 'another' })), /UNIQUE/);
  database.exec("UPDATE ethereum_reveal_deployments SET state = 'ready', provisioned_at_ms = 1, revision = revision + 1");
  const ready = parseEthereumRevealDeployment(query('SELECT * FROM ethereum_reveal_deployments')[0]);
  assert.throws(() => buildEthereumRevealTransition('activate', ready, 1), /revision/);
  const active = parseEthereumRevealDeployment(query(buildEthereumRevealTransition('activate', ready, ready.revision))[0]);
  assert.equal(active.state, 'active');
  assert.notEqual(active.activatedAtMs, null);
  assert.equal(parseEthereumRevealDeployment(query(buildEthereumRevealTransition('pause', active, active.revision))[0]).state, 'paused');
});

test('registry lookup is scoped to chain and normalized contract', async t => {
  const { database, register } = await fixture(t);
  register();
  const db = { prepare(sql: string) { let bindings: unknown[] = []; return {
    bind(...values: unknown[]) { bindings = values; return this; },
    async first<T>() { return (database.prepare(sql).get(...bindings as string[]) ?? null) as T | null; },
  }; } };
  assert.equal((await readEthereumRevealDeployment(db, { ...scope, contractAddress: scope.contractAddress.toUpperCase().replace('0X', '0x') }))?.deploymentId, registration.deploymentId);
  assert.equal(await readEthereumRevealDeployment(db, { ...scope, chainId: 1 }), null);
});

test('publication lease blocks reveal registration until every writer drains and protects all registered states', async t => {
  const { database, query, register } = await fixture(t);
  const lease = await acquireMetadataPublicationLease(registration.metadataBaseUri, { query });
  assert.throws(register, /publication is still active/);
  await assert.rejects(acquireMetadataPublicationLease(registration.metadataBaseUri, { query }), /another publication/);
  await lease.beforePut();
  await assert.rejects(lease.retireForRegistration(), /must drain/);
  await lease.close();
  await assert.rejects(lease.beforePut(), /closed/);
  assert.throws(register, /publication is still active/);
  await assert.rejects(acquireMetadataPublicationLease(registration.metadataBaseUri, { query }), /another publication/);
  database.exec("UPDATE ethereum_metadata_publication_leases SET expires_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) - 66000");
  register();
  for (const state of ['provisioning', 'ready', 'active', 'paused']) {
    database.prepare('UPDATE ethereum_reveal_deployments SET state = ?').run(state);
    await assert.rejects(acquireMetadataPublicationLease(registration.metadataBaseUri, { query }), /reveal-managed/);
  }
});

test('lease expiry includes an in-flight PUT drain period and stale publishers cannot resume', async t => {
  const { database, query, register } = await fixture(t);
  let time = 0;
  const lease = await acquireMetadataPublicationLease(registration.metadataBaseUri, { query, now: () => time });
  database.exec("UPDATE ethereum_metadata_publication_leases SET expires_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) - 1000");
  assert.throws(register, /still active/);
  database.exec('UPDATE ethereum_metadata_publication_leases SET expires_at_ms = 0');
  register();
  time = 31_000;
  await assert.rejects(lease.beforePut(), /lost|reveal-managed|owned/);
  await lease.close();
});

test('publication fails closed when registry access is unavailable', async () => {
  await assert.rejects(acquireMetadataPublicationLease(registration.metadataBaseUri, { query() { throw new Error('D1 unavailable'); } }), /unavailable/);
});

test('deployment metadata prefixes match chain and reject unsafe or cross-network paths', () => {
  for (const [chain, root] of [[1, '111k'], [11155111, '111k-sepolia']] as const) {
    assert.equal(ethereumMetadataBaseUri(`https://cdn.mons.shop/${root}/revision-2/`, chain), `https://cdn.mons.shop/${root}/revision-2/`);
    for (const suffix of ['../x/', 'a/b/', 'Upper/', 'a/?q=x', 'a/#x', 'a//', '%61/']) {
      assert.throws(() => ethereumMetadataBaseUri(`https://cdn.mons.shop/${root}/${suffix}`, chain), /Invalid/);
    }
  }
  assert.throws(() => ethereumMetadataBaseUri('https://cdn.mons.shop/111k/new/', 11155111), /Invalid/);
  assert.equal(metadataPrefix('sepolia', '111k-sepolia/new/'), '111k-sepolia/new/');
  assert.throws(() => metadataPrefix('mainnet', '111k-sepolia/new/'), /Invalid/);
  assert.equal(parseMetadataCliArgs(['upload', '--network', 'sepolia', '--prefix', '111k-sepolia/new/'])?.prefix, '111k-sepolia/new/');
  assert.throws(() => parseMetadataCliArgs(['upload', '--network', 'all', '--prefix', '111k-sepolia/new/']), /one explicit network/);
});

test('registration reads an unrevealed immutable template and control arguments are explicit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reveal-registration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = join(directory, 'deployment.json');
  await writeFile(manifest, JSON.stringify(registration));
  assert.equal((await loadEthereumRevealRegistration(manifest)).templateJson, templateJson);
  await writeFile(join(directory, 'template.json'), JSON.stringify({ ...JSON.parse(templateJson), animation_url: 'https://wip.lil.org/111k/videos/1.mp4' }));
  await writeFile(manifest, JSON.stringify({ ...registration, templateFile: 'template.json' }));
  await assert.rejects(loadEthereumRevealRegistration(manifest), /unrevealed/);
  assert.equal(parseEthereumRevealControlArgs(['register', '--manifest', manifest]).write, false);
  assert.throws(() => parseEthereumRevealControlArgs(['activate', '--deployment-id', registration.deploymentId]), /expected-revision/);
  assert.throws(() => parseEthereumRevealControlArgs(['status', '--write']), /only accepts/);
});

test('control arguments accept exactly one manifest or deployment ID target', () => {
  assert.equal(parseEthereumRevealControlArgs(['status']).deploymentId, undefined);
  assert.equal(parseEthereumRevealControlArgs(['status', '--manifest', 'deployment.json']).manifest, 'deployment.json');
  assert.equal(parseEthereumRevealControlArgs(['status', '--deployment-id', 'v9']).deploymentId, 'v9');
  for (const command of ['activate', 'pause']) {
    for (const target of [['--manifest', 'deployment.json'], ['--deployment-id', 'v9']]) {
      const parsed = parseEthereumRevealControlArgs([command, ...target, '--expected-revision', '2']);
      assert.equal(parsed.expectedRevision, 2);
      assert.equal(parsed.write, false);
      assert.throws(() => parseEthereumRevealControlArgs([command, ...target]), /expected-revision/);
      for (const revision of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
        assert.throws(() => parseEthereumRevealControlArgs([command, ...target, '--expected-revision', revision]), /expected-revision/);
      }
    }
    assert.throws(() => parseEthereumRevealControlArgs([command, '--expected-revision', '2']), /requires/);
  }
  for (const command of ['status', 'register', 'activate', 'pause']) {
    assert.throws(() => parseEthereumRevealControlArgs([command, '--manifest', 'deployment.json', '--deployment-id', 'v8']), /either|both/);
    for (const path of ['', '   ']) assert.throws(() => parseEthereumRevealControlArgs([command, '--manifest', path]), /manifest path/);
  }
  assert.throws(() => parseEthereumRevealControlArgs(['status', '--manifest', 'deployment.json', '--write']), /only accepts/);
  assert.throws(() => parseEthereumRevealControlArgs(['status', '--manifest', 'deployment.json', '--expected-revision', '2']), /only accepts/);
  assert.throws(() => parseEthereumRevealControlArgs(['register', '--manifest', 'deployment.json', '--expected-revision', '2']), /requires only/);
  for (const argv of [
    ['status', '--manifest', 'old.json', '--manifest', 'new.json'],
    ['status', '--deployment-id', 'v8', '--deployment-id', 'v9'],
    ['register', '--manifest', 'deployment.json', '--write', '--write'],
    ['activate', '--manifest', 'deployment.json', '--expected-revision', '2', '--expected-revision', '3'],
  ]) assert.throws(() => parseEthereumRevealControlArgs(argv), /Duplicate option/);
});

test('one manifest targets status and transitions without loading registration resources or touching the older deployment', async t => {
  const { database, query } = await fixture(t);
  const older = { ...registration, deploymentId: 'v8', contractAddress: `0x${'cd'.repeat(20)}`,
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v8/' };
  const newer = { ...registration, deploymentId: 'v9', metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v9/' };
  for (const value of [older, newer]) query(buildEthereumRevealRegistration(value));
  database.exec("UPDATE ethereum_reveal_deployments SET state = CASE deployment_id WHEN 'v8' THEN 'paused' ELSE 'ready' END, provisioned_at_ms = 1, revision = 3");
  const oldRow = query("SELECT * FROM ethereum_reveal_deployments WHERE deployment_id = 'v8'")[0];
  const manifest = await controlManifest(t, { ...registrationIdentity(newer),
    publicationDirectory: './missing-publication', templateFile: './missing-template.json' });
  const statements: string[] = [];
  const overrides = { query: (sql: string) => { statements.push(sql); return query(sql); },
    verifyPublication: async () => assert.fail('Targeting must not verify a publication'),
    verifyDeployment: async () => assert.fail('Targeting must not verify the chain') };
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Targeting must not make network requests'));
  const status = await runEthereumRevealControl(['status', '--manifest', manifest], overrides);
  assert.ok('deployments' in status);
  assert.deepEqual(status.deployments.map(value => [value.deploymentId, value.state, value.revision]), [['v9', 'ready', 3]]);
  const preview = await runEthereumRevealControl(['activate', '--manifest', manifest, '--expected-revision', '3'], overrides);
  assert.ok('dryRun' in preview && preview.dryRun);
  assert.ok(statements.every(sql => sql.startsWith('SELECT ')));
  assert.equal(query("SELECT state FROM ethereum_reveal_deployments WHERE deployment_id = 'v9'")[0].state, 'ready');
  for (const [command, revision, expectedState] of [['activate', 3, 'active'], ['pause', 4, 'paused'], ['activate', 5, 'active']] as const) {
    const result = await runEthereumRevealControl([command, '--manifest', manifest, '--expected-revision', String(revision), '--write'], overrides);
    assert.ok('deployment' in result && 'state' in result.deployment && 'revision' in result.deployment);
    assert.equal(result.deployment.deploymentId, 'v9');
    assert.equal(result.deployment.state, expectedState);
    assert.equal(result.deployment.revision, revision + 1);
    assert.deepEqual(query("SELECT * FROM ethereum_reveal_deployments WHERE deployment_id = 'v8'")[0], oldRow);
  }
  const oldStatus = await runEthereumRevealControl(['status', '--deployment-id', 'v8'], overrides);
  assert.ok('deployments' in oldStatus);
  assert.deepEqual(oldStatus.deployments.map(value => value.deploymentId), ['v8']);
  const allStatus = await runEthereumRevealControl(['status'], overrides);
  assert.ok('deployments' in allStatus);
  assert.deepEqual(allStatus.deployments.map(value => value.deploymentId).sort(), ['v8', 'v9']);
  assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases')[0].count, 0);
});

test('manifest identity mismatches are rejected before any transition writes', async t => {
  const { database, query, register } = await fixture(t);
  register();
  const older = { ...registration, deploymentId: 'older', contractAddress: `0x${'cd'.repeat(20)}`,
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/older/' };
  query(buildEthereumRevealRegistration(older));
  database.exec("UPDATE ethereum_reveal_deployments SET state = 'ready', provisioned_at_ms = 1, revision = 2");
  const manifest = await controlManifest(t, registrationIdentity());
  const variants = [
    { deploymentId: older.deploymentId, metadataBaseUri: older.metadataBaseUri },
    { dropId: 'another_drop' },
    { chainId: 1, metadataBaseUri: `https://cdn.mons.shop/111k/${registration.deploymentId}/` },
    { contractAddress: older.contractAddress },
    { metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/' },
    { deploymentBlock: registration.deploymentBlock + 1 },
    { catalogVersion: 'another-catalog' },
  ];
  for (const changed of variants) {
    await writeFile(manifest, JSON.stringify({ ...registrationIdentity(), ...changed }));
    for (const command of ['status', 'activate', 'pause']) {
      const statements: string[] = [];
      await assert.rejects(runEthereumRevealControl([command, '--manifest', manifest,
        ...(command === 'status' ? [] : ['--expected-revision', '2', '--write'])], {
        query: sql => { statements.push(sql); return query(sql); },
      }), 'catalogVersion' in changed ? /Invalid.*identity/ : /manifest.*registered deployment/);
      assert.ok(statements.every(sql => sql.startsWith('SELECT ')));
    }
  }
  assert.deepEqual(query('SELECT state, revision FROM ethereum_reveal_deployments').map(row => [row.state, row.revision]), [['ready', 2], ['ready', 2]]);
});

test('an unregistered manifest returns empty status and cannot transition another deployment', async t => {
  const { query, register } = await fixture(t);
  register();
  const manifest = await controlManifest(t, { ...registrationIdentity(), deploymentId: 'unregistered',
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/unregistered/' });
  const statements: string[] = [];
  const overrides = { query: (sql: string) => { statements.push(sql); return query(sql); } };
  assert.deepEqual(await runEthereumRevealControl(['status', '--manifest', manifest], overrides), { deployments: [] });
  for (const command of ['activate', 'pause']) {
    await assert.rejects(runEthereumRevealControl([command, '--manifest', manifest, '--expected-revision', '1', '--write'], overrides), /not found/);
  }
  assert.ok(statements.every(sql => sql.startsWith('SELECT ') && sql.includes("deployment_id = 'unregistered'")));
});

test('manifest targeting accepts checksum addresses, default catalog versions and registered legacy root prefixes', async t => {
  const { database, query } = await fixture(t);
  for (const [chainId, deploymentId, metadataBaseUri] of [
    [11155111, 'legacy-sepolia', 'https://cdn.mons.shop/111k-sepolia/'],
    [1, 'legacy-mainnet', 'https://cdn.mons.shop/111k/'],
  ] as const) {
    const value = { ...registration, chainId, deploymentId, metadataBaseUri };
    query(buildEthereumRevealRegistration(value));
    database.prepare("UPDATE ethereum_reveal_deployments SET state = 'ready', provisioned_at_ms = 1, revision = 2 WHERE deployment_id = ?").run(deploymentId);
    const { catalogVersion: _catalog, ...identity } = registrationIdentity(value);
    const manifest = await controlManifest(t, { ...identity, contractAddress: checksumEthereumAddress(scope.contractAddress) });
    const status = await runEthereumRevealControl(['status', '--manifest', manifest], { query });
    assert.ok('deployments' in status);
    assert.equal(status.deployments[0].contractAddress, scope.contractAddress);
    assert.equal(status.deployments[0].catalogVersion, registration.catalogVersion);
    const active = await runEthereumRevealControl(['activate', '--manifest', manifest, '--expected-revision', '2', '--write'], { query });
    assert.ok('deployment' in active && 'state' in active.deployment);
    assert.equal(active.deployment.deploymentId, deploymentId);
    assert.equal(active.deployment.state, 'active');
  }
});

test('manifest transitions retain revision validation and reject a concurrent state change', async t => {
  const { database, query, register } = await fixture(t);
  register();
  database.exec("UPDATE ethereum_reveal_deployments SET state = 'ready', provisioned_at_ms = 1, revision = 2");
  const manifest = await controlManifest(t, registrationIdentity());
  await assert.rejects(runEthereumRevealControl(['activate', '--manifest', manifest, '--expected-revision', '1', '--write'], { query }), /state or revision/);
  await assert.rejects(runEthereumRevealControl(['activate', '--manifest', manifest, '--expected-revision', '2', '--write'], {
    query: sql => {
      if (sql.startsWith('UPDATE ethereum_reveal_deployments')) database.exec('UPDATE ethereum_reveal_deployments SET revision = revision + 1');
      return query(sql);
    },
  }), /transition was not confirmed/);
  assert.deepEqual(query('SELECT state, revision FROM ethereum_reveal_deployments').map(row => [row.state, row.revision]), [['ready', 3]]);
});


test('S3 metadata writes enforce the previously observed ETag or absence', async () => {
  const inputs: Record<string, unknown>[] = [];
  const body = Buffer.from('metadata');
  const storage = new S3MetadataStorage({ endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' }, {
    async send(command: { input: Record<string, unknown> }) { inputs.push(command.input); return { ETag: `"${metadataMd5(body)}"` }; },
  } as never);
  await storage.put('111k-sepolia/test/1.json', body, '"previous"');
  await storage.put('111k-sepolia/test/2.json', body, null);
  assert.equal(inputs[0].IfMatch, '"previous"');
  assert.equal(inputs[0].IfNoneMatch, undefined);
  assert.equal(inputs[1].IfNoneMatch, '*');
  assert.equal(inputs[1].IfMatch, undefined);
});

test('fresh prefix initialization is resumable, rejects differing content, and never writes after a failed fence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reveal-prefix-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = Buffer.from('placeholder');
  const object = { file: '1.json', body, bytes: body.length, md5: metadataMd5(body), sha256: createHash('sha256').update(body).digest('hex') };
  const values = new Map<string, Buffer>();
  const conditions: Array<string | null | undefined> = [];
  const storage: MetadataStorage = {
    destination: { endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' },
    async *list() {}, async get(key) { return values.get(key)!; }, close() {},
    async put(key, value, expected) { conditions.push(expected); values.set(key, value); },
  };
  const prefix = '111k-sepolia/test/';
  const inventory = new Map<string, { key: string; bytes: number; md5: string }>();
  const args = { storage, prefix, network: 'sepolia' as const, initializeOnly: true, inventory,
    journal: join(directory, 'upload.jsonl'), sourceHash: object.sha256, concurrency: 1, total: 1 };
  const objects = async function* () { yield object; };
  assert.deepEqual(await publishObjects({ ...args, objects: objects() }), { uploaded: 1, skipped: 0 });
  assert.deepEqual(conditions, [null]);
  assert.ok(values.has(`${prefix}1.json`));
  inventory.set('1.json', { key: `${prefix}1.json`, bytes: body.length, md5: object.md5 });
  assert.deepEqual(await publishObjects({ ...args, objects: objects() }), { uploaded: 0, skipped: 1 });
  inventory.set('1.json', { key: `${prefix}1.json`, bytes: 9, md5: metadataMd5(Buffer.from('different')) });
  await assert.rejects(publishObjects({ ...args, objects: objects() }), /different metadata/);
  inventory.clear();
  await assert.rejects(publishObjects({ ...args, objects: objects(), beforePut: async () => { throw new Error('lease lost'); } }), /lease lost/);
  assert.deepEqual(conditions, [null]);
  await assert.rejects(publishObjects({ ...args, prefix: '111k-sepolia/other/', objects: objects() }), /different destination/);
});


async function registrationFile(t: TestContext, extras: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'verified-reveal-registration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'publication', 'templates'), { recursive: true });
  await writeFile(join(directory, 'publication', 'templates', 'artwork.json'), templateJson);
  const manifest = join(directory, 'deployment.json');
  await writeFile(manifest, JSON.stringify({ ...registration, publicationDirectory: './publication', ...extras }));
  return { directory, manifest };
}

test('registration RPC credentials prefer the environment, then .env.local, then .env without mutating the environment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reveal-rpc-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = join(directory, '.env.local'), fallback = join(directory, '.env');
  await writeFile(local, 'ALCHEMY_MI_NOTE_API_KEY="local-test-key"\nUNRELATED=ignored\n');
  await writeFile(fallback, 'ALCHEMY_MI_NOTE_API_KEY=fallback-test-key\n');
  const env = Object.freeze({ ALCHEMY_MI_NOTE_API_KEY: ' environment-test-key ' });
  assert.equal(await ethereumRevealRegistrationRpcKey(env, [local, fallback]), 'environment-test-key');
  assert.equal(await ethereumRevealRegistrationRpcKey({}, [local, fallback]), 'local-test-key');
  await rm(local);
  assert.equal(await ethereumRevealRegistrationRpcKey({}, [local, fallback]), 'fallback-test-key');
  await writeFile(fallback, 'ALCHEMY_MI_NOTE_API_KEY=" "\n');
  await assert.rejects(ethereumRevealRegistrationRpcKey({}, [local, fallback]), /Set ALCHEMY_MI_NOTE_API_KEY/);
  await assert.rejects(ethereumRevealRegistrationRpcKey({}, [directory]), /Could not read Ethereum RPC credentials/);
  assert.deepEqual(env, { ALCHEMY_MI_NOTE_API_KEY: ' environment-test-key ' });
});

for (const write of [false, true]) {
  for (const failure of ['wrong chain', 'missing code', 'wrong base URI', 'reorg', 'RPC failure'] as const) {
    test(`registration rejects ${failure} before permanent ownership${write ? '' : ' in a dry run'}`, async t => {
      const { query } = await fixture(t);
      const { manifest } = await registrationFile(t);
      const previous = process.env.ALCHEMY_MI_NOTE_API_KEY;
      process.env.ALCHEMY_MI_NOTE_API_KEY = 'registration-test-key';
      t.after(() => {
        if (previous === undefined) delete process.env.ALCHEMY_MI_NOTE_API_KEY;
        else process.env.ALCHEMY_MI_NOTE_API_KEY = previous;
      });
      let calls = 0;
      const blockHash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
      const head = registration.deploymentBlock + 1;
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls++;
        assert.equal(String(url), 'https://eth-sepolia.g.alchemy.com/v2/registration-test-key');
        if (failure === 'RPC failure') throw new Error(`Transport failed at ${url}`);
        const { method, params } = JSON.parse(String(init?.body));
        const number = method === 'eth_getBlockByNumber' ? params[0] === 'latest' ? head : Number(BigInt(params[0])) : 0;
        const result = method === 'eth_chainId' ? failure === 'wrong chain' ? '0x1' : '0xaa36a7'
          : method === 'eth_getBlockByNumber' ? { number: `0x${number.toString(16)}`,
            hash: failure === 'reorg' && params[0] === `0x${head.toString(16)}` ? `0x${'55'.repeat(32)}` : blockHash(number) }
          : method === 'eth_getCode' ? failure === 'missing code' || params[1].blockHash === blockHash(registration.deploymentBlock - 1) ? '0x' : '0x60006000'
          : method === 'eth_call' ? encodeAbi(['string'], [failure === 'wrong base URI' ? 'https://cdn.mons.shop/111k-sepolia/other/' : registration.metadataBaseUri])
          : assert.fail(`Unexpected registration RPC ${method}`);
        return Response.json({ jsonrpc: '2.0', id: 1, result });
      });
      const statements: string[] = [];
      await assert.rejects(runEthereumRevealControl(['register', '--manifest', manifest, ...(write ? ['--write'] : [])], {
        query: sql => { statements.push(sql); return query(sql); }, verifyPublication: async () => [],
      }), error => {
        assert.doesNotMatch(String(error), /registration-test-key/);
        return /unavailable|does not match/.test(String(error));
      });
      assert.ok(calls > 0);
      assert.ok(statements.every(sql => !sql.startsWith('INSERT INTO ethereum_reveal_deployments') && !sql.includes('SET expires_at_ms=0')));
      if (!write) assert.ok(statements.every(sql => sql.startsWith('SELECT ')));
      assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_reveal_deployments')[0].count, 0);
      assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases')[0].count, 0);
      const lease = await acquireMetadataPublicationLease(registration.metadataBaseUri, { query });
      await lease.close();
    });
  }
}

test('registration verifies the creation block before claiming permanent ownership', async t => {
  const { query } = await fixture(t);
  const { manifest } = await registrationFile(t);
  const previous = process.env.ALCHEMY_MI_NOTE_API_KEY;
  process.env.ALCHEMY_MI_NOTE_API_KEY = 'registration-test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.ALCHEMY_MI_NOTE_API_KEY;
    else process.env.ALCHEMY_MI_NOTE_API_KEY = previous;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://eth-sepolia.g.alchemy.com/v2/registration-test-key');
    const { method, params } = JSON.parse(String(init?.body));
    const number = method === 'eth_getBlockByNumber' ? params[0] === 'latest' ? 500 : Number(BigInt(params[0])) : 0;
    const result = method === 'eth_chainId' ? '0xaa36a7'
      : method === 'eth_getBlockByNumber' ? { number: `0x${number.toString(16)}`, hash: `0x${number.toString(16).padStart(64, '0')}` }
      : method === 'eth_getCode' ? BigInt(params[1].blockHash) < 100n ? '0x' : '0x60006000'
      : method === 'eth_call' ? encodeAbi(['string'], [registration.metadataBaseUri])
      : assert.fail(`Unexpected registration RPC ${method}`);
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  const register = (write: boolean) => runEthereumRevealControl(['register', '--manifest', manifest, ...(write ? ['--write'] : [])], {
    query, verifyPublication: async () => [],
  });
  for (const deploymentBlock of [0, 99, 101, 50_000_000]) {
    await writeFile(manifest, JSON.stringify({ ...registration, deploymentBlock, publicationDirectory: './publication' }));
    for (const write of [false, true]) {
      await assert.rejects(register(write), /deployment block/);
      assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_reveal_deployments')[0].count, 0);
      assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases')[0].count, 0);
    }
  }
  await writeFile(manifest, JSON.stringify({ ...registration, deploymentBlock: 100, publicationDirectory: './publication' }));
  assert.equal((await register(false)).deployment.deploymentBlock, 100);
  assert.equal((await register(true)).deployment.deploymentBlock, 100);
  assert.equal(query('SELECT state FROM ethereum_reveal_deployments')[0].state, 'provisioning');
});

test('new registration requires a verified publication while legacy idempotent registration remains unchanged', async t => {
  const { query, register } = await fixture(t);
  const { manifest } = await registrationFile(t, { publicationDirectory: undefined });
  await assert.rejects(runEthereumRevealControl(['register', '--manifest', manifest, '--write'], { query }), /requires publicationDirectory/);
  assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_reveal_deployments')[0].count, 0);
  register();
  const result = await runEthereumRevealControl(['register', '--manifest', manifest, '--write'], { query,
    verifyPublication: async () => assert.fail('Idempotent registration must not reverify changed live metadata'),
    verifyDeployment: async () => assert.fail('Idempotent registration must not require RPC access') });
  assert.equal('unchanged' in result && result.unchanged, true);
});

test('wrong template and failed live verification never claim permanent metadata ownership', async t => {
  const { query } = await fixture(t);
  const { directory, manifest } = await registrationFile(t, { templateFile: './wrong.json' });
  await writeFile(join(directory, 'wrong.json'), JSON.stringify({ ...JSON.parse(templateJson), name: 'Wrong #{{tokenId}}' }));
  await assert.rejects(runEthereumRevealControl(['register', '--manifest', manifest, '--write'], { query,
    verifyPublication: async () => assert.fail('Snapshot mismatch must be rejected before remote verification') }), /does not match the publication snapshot/);
  await writeFile(manifest, JSON.stringify({ ...registration, publicationDirectory: './publication' }));
  await assert.rejects(runEthereumRevealControl(['register', '--manifest', manifest, '--write'], { query,
    verifyPublication: async () => { throw new Error('Remote metadata checksum mismatch'); } }), /checksum mismatch/);
  assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_reveal_deployments')[0].count, 0);
  assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases')[0].count, 0);
});

test('registration verifies the entire publication under its lease and atomically checks the retired lease owner', async t => {
  const { query } = await fixture(t);
  const { directory, manifest } = await registrationFile(t);
  const order: string[] = [];
  const result = await runEthereumRevealControl(['register', '--manifest', manifest, '--write'], { query: sql => {
    if (sql.startsWith('UPDATE ethereum_metadata_publication_leases SET expires_at_ms=0')) order.push('retire');
    if (sql.startsWith('INSERT INTO ethereum_reveal_deployments')) order.push('register');
    return query(sql);
  },
    verifyPublication: async (path, network, options) => {
      assert.equal(path, join(directory, 'publication'));
      assert.equal(network, 'sepolia');
      assert.equal(options.prefix, '111k-sepolia/sepolia-test-2/');
      assert.equal(options.tokenIds, undefined);
      assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_reveal_deployments')[0].count, 0);
      assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases WHERE expires_at_ms > 0')[0].count, 1);
      order.push('publication');
      return [];
    }, verifyDeployment: async value => {
      assert.deepEqual(value, registration);
      assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_reveal_deployments')[0].count, 0);
      assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases WHERE expires_at_ms > 0')[0].count, 1);
      order.push('chain');
    } });
  assert.deepEqual(order, ['publication', 'chain', 'retire', 'register']);
  assert.equal('deployment' in result && 'state' in result.deployment && result.deployment.state, 'provisioning');
  assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases')[0].count, 0);
});

test('a publisher that takes over during registration handoff prevents the permanent INSERT', async t => {
  const { query, database } = await fixture(t);
  const { manifest } = await registrationFile(t);
  const racingQuery = (sql: string) => {
    if (sql.startsWith('INSERT INTO ethereum_reveal_deployments')) {
      database.exec("UPDATE ethereum_metadata_publication_leases SET lease_id='replacement-owner',expires_at_ms=9999999999999");
    }
    return query(sql);
  };
  await assert.rejects(runEthereumRevealControl(['register', '--manifest', manifest, '--write'], { query: racingQuery,
    verifyPublication: async () => [], verifyDeployment: async () => {} }), /lost its publication lease/);
  assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_reveal_deployments')[0].count, 0);
  assert.equal(query('SELECT lease_id FROM ethereum_metadata_publication_leases')[0].lease_id, 'replacement-owner');
});

test('a stale sibling guard cannot dispatch after lease expiry and failed renewal', async t => {
  const { database, query, register } = await fixture(t);
  let now = 0;
  let calls = 0;
  const lease = await acquireMetadataPublicationLease(registration.metadataBaseUri, { now: () => now, query: sql => {
    if (++calls === 2) {
      now = 190_000;
      database.exec('UPDATE ethereum_metadata_publication_leases SET expires_at_ms=0');
      register();
    }
    return query(sql);
  } });
  let sent = 0;
  const storage = new S3MetadataStorage({ endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' }, {
    async send() { sent++; return { ETag: `"${metadataMd5(Buffer.from('placeholder'))}"` }; },
  } as never);
  now = 29_999;
  const sibling = (async () => { await lease.beforePut(); await storage.put('111k-sepolia/test/1.json', Buffer.from('placeholder'), null, lease); })();
  now = 30_001;
  const renewal = lease.beforePut();
  const result = await Promise.allSettled([sibling, renewal]);
  assert.deepEqual(result.map(value => value.status), ['rejected', 'rejected']);
  assert.equal(sent, 0);
  assert.ok(lease.signal.aborted);
  await lease.close();
});

test('wall-clock expiry and a failed renewal poison previously granted write permission', async t => {
  const { query, database } = await fixture(t);
  let wall = 0;
  const lease = await acquireMetadataPublicationLease(registration.metadataBaseUri, { query, now: () => 0, wallNow: () => wall });
  await lease.beforePut();
  wall = 120_000;
  assert.throws(lease.assertWritable, /expired/);
  assert.ok(lease.signal.aborted);
  await assert.rejects(lease.beforePut(), /expired/);
  await lease.close();
  database.exec("UPDATE ethereum_metadata_publication_leases SET expires_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) - 66000");
  let now = 0;
  let calls = 0;
  const failed = await acquireMetadataPublicationLease(registration.metadataBaseUri, { now: () => now, query: sql => {
    if (++calls === 2) throw new Error('D1 unavailable');
    return query(sql);
  } });
  await failed.beforePut();
  now = 31_000;
  await assert.rejects(failed.beforePut(), /renewal failed/);
  assert.throws(failed.assertWritable, /renewal failed/);
  assert.ok(failed.signal.aborted);
  await failed.close();
});

test('an aborted PUT drains before registration can verify and claim its metadata prefix', { timeout: 10_000 }, async t => {
  const { query, database, register } = await fixture(t);
  const { manifest } = await registrationFile(t);
  const baseline = Buffer.from('approved placeholder');
  const replacement = Buffer.from('late replacement placeholder');
  let remote = baseline;
  const received = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      received.resolve();
      await commit.promise;
      assert.equal(request.headers['if-match'], `"${metadataMd5(remote)}"`);
      remote = body;
      response.end();
      completed.resolve();
    } catch (error) { received.reject(error); completed.reject(error); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const client = new S3Client({ endpoint, region: 'auto', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
  t.after(async () => {
    commit.resolve();
    client.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const storage = new S3MetadataStorage({ endpoint, bucket: 'cdn-mons-shop' }, client);
  let now = 0;
  let failRenewal = false;
  const lease = await acquireMetadataPublicationLease(registration.metadataBaseUri, { now: () => now, query: sql => {
    if (failRenewal) { failRenewal = false; throw new Error('D1 unavailable'); }
    return query(sql);
  } });
  const put = assert.rejects(storage.put('111k-sepolia/sepolia-test-2/1.json', replacement, `"${metadataMd5(baseline)}"`, lease), { name: 'AbortError' });
  await received.promise;
  now = 31_000;
  failRenewal = true;
  await assert.rejects(lease.beforePut(), /renewal failed/);
  await put;
  await lease.close();
  assert.deepEqual(remote, baseline);
  assert.throws(register, /publication is still active/);
  await assert.rejects(runEthereumRevealControl(['register', '--manifest', manifest, '--write'], { query,
    verifyPublication: async () => assert.fail('Registration must wait for the writer to drain') }), /another publication/);
  commit.resolve();
  await completed.promise;
  assert.deepEqual(remote, replacement);
  assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_reveal_deployments')[0].count, 0);
  database.exec("UPDATE ethereum_metadata_publication_leases SET expires_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) - 66000");
  await assert.rejects(runEthereumRevealControl(['register', '--manifest', manifest, '--write'], { query,
    verifyPublication: async () => {
      assert.deepEqual(remote, replacement);
      throw new Error('Remote metadata checksum mismatch');
    } }), /checksum mismatch/);
  assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_reveal_deployments')[0].count, 0);
  assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases')[0].count, 0);
});

test('metadata SDK retries recheck the publication fence before another HTTP attempt', async t => {
  let requests = 0;
  let writable = true;
  let checks = 0;
  const server = createServer((_request, response) => {
    requests++;
    writable = false;
    response.writeHead(503, { 'Content-Type': 'application/xml' });
    response.end('<Error><Code>SlowDown</Code><Message>Retry</Message></Error>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const client = new S3Client({ endpoint, region: 'auto', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 3 });
  t.after(() => client.destroy());
  const storage = new S3MetadataStorage({ endpoint, bucket: 'cdn-mons-shop' }, client);
  const fence = { signal: new AbortController().signal, assertWritable() { checks++; if (!writable) throw new Error('publication lease lost'); } };
  await assert.rejects(storage.put('111k-sepolia/test/1.json', Buffer.from('placeholder'), null, fence), /publication lease lost/);
  assert.equal(requests, 1);
  assert.ok(checks >= 3);
});

test('asynchronous D1 queries keep SQL off argv and bound the authenticated Wrangler process', async () => {
  let complete: ((output: string) => void) | undefined;
  const query = createAsyncD1MaintenanceQuery('ops', async execution => {
    assert.equal(execution.timeoutMs, 15_000);
    assert.equal(execution.input, 'SELECT 1 AS count');
    assert.ok(execution.args.includes('MONS_D1_SQL_STDIN'));
    assert.ok(!execution.args.includes(execution.input));
    return new Promise<string>(resolve => { complete = resolve; });
  });
  const pending = query('SELECT 1 AS count');
  await Promise.resolve();
  assert.ok(complete);
  complete('[{"success":true,"results":[{"count":1}]}]');
  assert.deepEqual(await pending, [{ count: 1 }]);
  await assert.rejects(createAsyncD1MaintenanceQuery('ops', async () => '[{"success":false,"results":[]}]')('SELECT 1'), /invalid statement result/);
});

test('registration dry runs verify metadata and the deployment without writing registry or lease state', async t => {
  const { query } = await fixture(t);
  const { manifest } = await registrationFile(t);
  const verified: string[] = [];
  const result = await runEthereumRevealControl(['register', '--manifest', manifest], { query: sql => {
    assert.ok(sql.startsWith('SELECT '));
    return query(sql);
  }, verifyPublication: async () => { verified.push('publication'); return []; },
  verifyDeployment: async () => { verified.push('chain'); } });
  assert.deepEqual(verified, ['publication', 'chain']);
  assert.equal('dryRun' in result && result.dryRun, true);
  assert.equal('deploymentVerified' in result && result.deploymentVerified, true);
  assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_reveal_deployments')[0].count, 0);
  assert.equal(query('SELECT COUNT(*) AS count FROM ethereum_metadata_publication_leases')[0].count, 0);
});

test('a renewal response that arrives past its allowed interval permanently poisons the lease', async t => {
  const { query } = await fixture(t);
  let now = 0;
  let calls = 0;
  const lease = await acquireMetadataPublicationLease(registration.metadataBaseUri, { now: () => now, query: sql => {
    const rows = query(sql);
    if (++calls === 2) now += 30_000;
    return rows;
  } });
  now = 31_000;
  await assert.rejects(lease.beforePut(), /renewal failed/);
  assert.ok(lease.signal.aborted);
  assert.throws(lease.assertWritable, /renewal failed/);
  await lease.close();
});
