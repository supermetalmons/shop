import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeAbi, encodeCall } from '../shared/ethereum/abi.ts';
import { tarotCodeHashInput } from '../shared/ethereum/tarot.ts';
import { runTarotOperations } from '../scripts/tarot/cli.ts';
import {
  bindMainnetCredentials, createMainnetClaimLinks, loadMainnetClaimLinks, mainnetBindingConfiguration,
  mainnetBindingRpc, mainnetClaimCsv, mainnetCredentials,
  mainnetCredentialFingerprint, stageMainnetCredentials, verifyMainnetCredentials,
} from '../scripts/tarot/mainnetClaims.ts';

type Manifest = ReturnType<typeof createMainnetClaimLinks>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const manifestName = 'claim-links.private.json';
const csvName = 'claim-links.private.csv';
type RuntimeArtifact = { bytecode: { object: string };
  deployedBytecode: { object: string; immutableReferences: Record<string, { start: number; length: number }[]> } };
let runtimeArtifact: RuntimeArtifact;
let getterOnlyRuntime: string;
let build: string;

before(() => {
  build = mkdtempSync(join(tmpdir(), 'dmx-binding-build-test-'));
  execFileSync('forge', ['build', '--offline', 'src/TarotCards.sol', '--out', join(build, 'out'), '--cache-path', join(build, 'cache')],
    { cwd: fileURLToPath(new URL('../onchain/ethereum/', import.meta.url)), stdio: 'pipe', timeout: 30_000 });
  runtimeArtifact = JSON.parse(readFileSync(join(build, 'out', 'TarotCards.sol', 'TarotCards.json'), 'utf8')) as RuntimeArtifact;
  const getterOnly = join(build, 'getter-only');
  mkdirSync(join(getterOnly, 'src'), { recursive: true });
  writeFileSync(join(getterOnly, 'src', 'GetterOnly.sol'), `pragma solidity 0.8.38;
contract GetterOnly {
  string public constant name = "divination machina x";
  string public constant symbol = "DMX";
  uint256 public constant INITIAL_CARDS = 777;
  uint256 public constant MAX_CARDS = 999999;
  uint256 public constant RECEIPT_OFFSET = 999999;
  address public constant quoteSigner = 0x7878787878787878787878787878787878787878;
  address public constant renderer = 0x5656565656565656565656565656565656565656;
  function eip712Domain() external view returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory) {
    return (0x0f, name, "1", block.chainid, address(this), bytes32(0), new uint256[](0));
  }
}
`);
  execFileSync('forge', ['build', '--offline', '--root', getterOnly, '--use', '0.8.38'], { stdio: 'pipe', timeout: 30_000 });
  const artifact = JSON.parse(readFileSync(join(getterOnly, 'out', 'GetterOnly.sol', 'GetterOnly.json'), 'utf8')) as
    RuntimeArtifact & { abi: { name?: string }[] };
  assert.ok(!artifact.abi.some(entry => entry.name === 'claim' || entry.name === 'claimTo'));
  getterOnlyRuntime = artifact.deployedBytecode.object;
});

after(() => {
  if (build) rmSync(build, { recursive: true, force: true });
});

function repository(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dmx-mainnet-claims-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  writeFileSync(join(root, '.gitignore'), '.operations/\n');
  return { root, directory: join(root, '.operations', 'mainnet-claims') };
}

function bundle(t: TestContext) {
  const fixture = repository(t);
  return { ...fixture, manifest: createMainnetClaimLinks(fixture.directory, fixture.root) };
}

function database(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of ['0014_tarot_claim_codes.sql', '0015_dmx_mainnet_claim_staging.sql', '0016_dmx_mainnet_bound_claim_codes.sql']) {
    db.exec(readFileSync(new URL(`../cloud/workers/api/ops-migrations/${name}`, import.meta.url), 'utf8'));
  }
  db.prepare('INSERT INTO tarot_claim_codes VALUES (11155111, ?, 1, ?, 123, NULL)')
    .run(`0x${'12'.repeat(20)}`, 'a'.repeat(64));
  const queries: string[] = [];
  const commands: string[] = [];
  const adapter = {
    query(sql: string): Record<string, unknown>[] {
      queries.push(sql);
      return db.prepare(sql).all();
    },
    executeCommand(sql: string): Record<string, unknown>[][] {
      commands.push(sql);
      return sql.split(';').map(statement => statement.trim()).filter(Boolean)
        .map(statement => db.prepare(statement).all());
    },
  };
  const batches = () => db.prepare('SELECT * FROM dmx_mainnet_claim_batches ORDER BY batch_id').all();
  const credentials = () => db.prepare('SELECT * FROM dmx_mainnet_claim_codes ORDER BY batch_id, token_id').all();
  const boundCredentials = () => db.prepare('SELECT * FROM dmx_mainnet_bound_claim_codes ORDER BY batch_id, token_id').all();
  const sepolia = () => db.prepare('SELECT * FROM tarot_claim_codes ORDER BY token_id').all();
  return { db, adapter, queries, commands, batches, credentials, boundCredentials, sepolia };
}

function insertPending(fixture: ReturnType<typeof database>, manifest: Manifest, count: number) {
  fixture.db.prepare(`INSERT INTO dmx_mainnet_claim_batches (
    batch_id, chain_id, collection_key, status, contract_address, credential_count,
    credential_set_sha256, created_at_ms, verified_at_ms, bound_at_ms
  ) VALUES (?, 1, 'dmx-mainnet-v1', 'preparing', NULL, 777, ?, ?, NULL, NULL)`)
    .run(manifest.batchId, mainnetCredentialFingerprint(manifest), manifest.createdAtMs);
  const insert = fixture.db.prepare('INSERT INTO dmx_mainnet_claim_codes VALUES (?, ?, ?, ?, NULL)');
  for (const credential of mainnetCredentials(manifest).slice(0, count)) {
    insert.run(manifest.batchId, credential.tokenId, credential.codeHash, manifest.createdAtMs);
  }
}

test('mainnet bundles contain 777 unique canonical links with private JSON and CSV files', t => {
  const before = Date.now();
  const { root, directory, manifest } = bundle(t);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.chainId, 1);
  assert.equal(manifest.collectionKey, 'dmx-mainnet-v1');
  assert.equal(manifest.contractAddress, null);
  assert.match(manifest.batchId, uuid);
  assert.ok(Number.isSafeInteger(manifest.createdAtMs) && manifest.createdAtMs >= before && manifest.createdAtMs <= Date.now());
  assert.equal(manifest.links.length, 777);
  assert.equal(new Set(manifest.links.map(link => link.code)).size, 777);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const name of [manifestName, csvName]) assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, manifestName), 'utf8')), manifest);
  const csv = mainnetClaimCsv(manifest);
  assert.equal(readFileSync(join(directory, csvName), 'utf8'), csv);
  const rows = csv.trimEnd().split(/\r?\n/).map(row => row.split(','));
  assert.equal(rows.length, 777);
  for (const [index, link] of manifest.links.entries()) {
    assert.equal(link.tokenId, index + 1);
    assert.match(link.code, uuid);
    assert.equal(link.url, `https://mons.shop/nfc?code=${link.code}&tokenId=${index + 1}`);
    assert.deepEqual(rows[index], [link.url]);
    assert.equal(new URL(rows[index][0]).searchParams.get('code'), link.code);
  }
  assert.equal(execFileSync('git', ['ls-files', '--', '.operations'], { cwd: root, encoding: 'utf8' }), '');
});

test('create and load resume the exact existing private files without regenerating codes', t => {
  const { root, directory, manifest } = bundle(t);
  const original = [manifestName, csvName].map(name => readFileSync(join(directory, name), 'utf8'));
  assert.deepEqual(createMainnetClaimLinks(directory, root), manifest);
  assert.deepEqual(loadMainnetClaimLinks(directory, root), manifest);
  assert.deepEqual([manifestName, csvName].map(name => readFileSync(join(directory, name), 'utf8')), original);
  writeFileSync(join(directory, csvName), `${original[1]}conflict\n`);
  assert.throws(() => createMainnetClaimLinks(directory, root));
  assert.throws(() => loadMainnetClaimLinks(directory, root));
  assert.equal(readFileSync(join(directory, manifestName), 'utf8'), original[0]);
});

test('creation recovers a missing CSV from the durable manifest but refuses a CSV without its manifest', t => {
  const { root, directory, manifest } = bundle(t);
  const json = readFileSync(join(directory, manifestName), 'utf8');
  const csv = readFileSync(join(directory, csvName), 'utf8');
  rmSync(join(directory, csvName));
  assert.throws(() => loadMainnetClaimLinks(directory, root));
  assert.deepEqual(createMainnetClaimLinks(directory, root), manifest);
  assert.equal(readFileSync(join(directory, manifestName), 'utf8'), json);
  assert.equal(readFileSync(join(directory, csvName), 'utf8'), csv);
  rmSync(join(directory, manifestName));
  assert.throws(() => createMainnetClaimLinks(directory, root));
  assert.equal(existsSync(join(directory, manifestName)), false);
  assert.equal(readFileSync(join(directory, csvName), 'utf8'), csv);
});

test('private bundles refuse public, unignored, and tracked paths', t => {
  const { root, directory } = repository(t);
  assert.throws(() => createMainnetClaimLinks(join(root, 'public'), root));
  assert.throws(() => createMainnetClaimLinks(join(root, '.operations'), root));
  writeFileSync(join(root, '.gitignore'), '');
  assert.throws(() => createMainnetClaimLinks(directory, root));
  assert.equal(existsSync(join(directory, manifestName)), false);
  writeFileSync(join(root, '.gitignore'), '.operations/\n');
  createMainnetClaimLinks(directory, root);
  execFileSync('git', ['add', '-f', '--', join(directory, manifestName)], { cwd: root });
  assert.throws(() => createMainnetClaimLinks(directory, root));
  assert.throws(() => loadMainnetClaimLinks(directory, root));
});

test('private bundles reject insecure directory and file permissions without repairing them silently', t => {
  const { root, directory } = bundle(t);
  for (const [path, invalid, valid] of [
    [directory, 0o755, 0o700], [join(directory, manifestName), 0o644, 0o600], [join(directory, csvName), 0o644, 0o600],
  ] as const) {
    chmodSync(path, invalid);
    assert.throws(() => createMainnetClaimLinks(directory, root));
    assert.throws(() => loadMainnetClaimLinks(directory, root));
    assert.equal(statSync(path).mode & 0o777, invalid);
    chmodSync(path, valid);
  }
});

test('private bundles reject symlinked directories and either symlinked artifact', t => {
  const { root, directory } = bundle(t);
  const shortcut = join(root, '.operations', 'shortcut');
  symlinkSync(directory, shortcut);
  assert.throws(() => createMainnetClaimLinks(shortcut, root));
  assert.throws(() => loadMainnetClaimLinks(shortcut, root));
  for (const name of [manifestName, csvName]) {
    const filename = join(directory, name);
    const bytes = readFileSync(filename);
    const target = join(root, `${name}.target`);
    writeFileSync(target, bytes, { mode: 0o600 });
    rmSync(filename);
    symlinkSync(target, filename);
    assert.throws(() => createMainnetClaimLinks(directory, root));
    assert.throws(() => loadMainnetClaimLinks(directory, root));
    assert.deepEqual(readFileSync(target), bytes);
    rmSync(filename);
    writeFileSync(filename, bytes, { mode: 0o600 });
  }
  const other = repository(t);
  const target = join(other.root, 'outside');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, join(other.root, '.operations'));
  assert.throws(() => createMainnetClaimLinks(other.directory, other.root));
});

test('malformed manifests, duplicate codes, incorrect scope, and noncanonical URLs are rejected', t => {
  const { root, directory, manifest } = bundle(t);
  const changes: Array<(value: Manifest) => void> = [
    value => { Object.assign(value, { chainId: 11155111 }); },
    value => { Object.assign(value, { collectionKey: 'other' }); },
    value => { Object.assign(value, { contractAddress: `0x${'12'.repeat(20)}` }); },
    value => { value.batchId = '00000000-0000-0000-0000-000000000000'; },
    value => { value.createdAtMs = -1; },
    value => { value.links.pop(); },
    value => { value.links[0].tokenId = 2; },
    value => { value.links[0].code = value.links[0].code.toUpperCase(); },
    value => {
      value.links[1].code = value.links[0].code;
      value.links[1].url = `https://mons.shop/nfc?code=${value.links[1].code}&tokenId=2`;
    },
    value => { value.links[0].url += '&testnet=true'; },
    value => { value.links[0].url = value.links[0].url.replace('mons.shop', 'example.test'); },
  ];
  for (const change of changes) {
    const malformed = structuredClone(manifest);
    change(malformed);
    assert.throws(() => mainnetCredentials(malformed));
    assert.throws(() => mainnetClaimCsv(malformed));
    writeFileSync(join(directory, manifestName), JSON.stringify(malformed));
    assert.throws(() => loadMainnetClaimLinks(directory, root));
    assert.throws(() => createMainnetClaimLinks(directory, root));
  }
  writeFileSync(join(directory, manifestName), '{');
  assert.throws(() => loadMainnetClaimLinks(directory, root));
  assert.throws(() => createMainnetClaimLinks(directory, root));
});

test('credential hashes bind the mainnet staging domain, batch, token, and code', t => {
  const { manifest } = bundle(t);
  const credentials = mainnetCredentials(manifest);
  assert.equal(credentials.length, 777);
  assert.equal(new Set(credentials.map(credential => credential.codeHash)).size, 777);
  for (const [index, link] of manifest.links.entries()) {
    assert.deepEqual(credentials[index], {
      tokenId: index + 1,
      codeHash: createHash('sha256').update(`mons:dmx:mainnet-staging:v1:1:${manifest.batchId}:${link.tokenId}:${link.code}`).digest('hex'),
    });
  }
  assert.match(mainnetCredentialFingerprint(manifest), /^[0-9a-f]{64}$/);
  assert.equal(mainnetCredentialFingerprint(structuredClone(manifest)), mainnetCredentialFingerprint(manifest));
  const alternate = structuredClone(manifest);
  alternate.batchId = randomUUID();
  assert.notEqual(mainnetCredentials(alternate)[0].codeHash, credentials[0].codeHash);
  assert.notEqual(mainnetCredentialFingerprint(alternate), mainnetCredentialFingerprint(manifest));
  const changed = structuredClone(manifest);
  changed.links[0].code = randomUUID();
  changed.links[0].url = `https://mons.shop/nfc?code=${changed.links[0].code}&tokenId=1`;
  assert.notEqual(mainnetCredentials(changed)[0].codeHash, credentials[0].codeHash);
  assert.notEqual(mainnetCredentialFingerprint(changed), mainnetCredentialFingerprint(manifest));
});

test('staging stores all hashes idempotently without touching Sepolia or activating a contract binding', async t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  const sepolia = fixture.sepolia();
  await assert.rejects(async () => verifyMainnetCredentials(manifest, fixture.adapter));
  assert.equal(fixture.commands.length, 0);
  const staged = await stageMainnetCredentials(manifest, fixture.adapter);
  assert.deepEqual(staged, {
    batchId: manifest.batchId, chainId: 1, collectionKey: 'dmx-mainnet-v1', credentialCount: 777,
    credentialSetSha256: mainnetCredentialFingerprint(manifest), status: 'staged', contractAddress: null, verified: true,
  });
  assert.equal(fixture.batches().length, 1);
  const batch = fixture.batches()[0];
  assert.equal(batch.batch_id, manifest.batchId);
  assert.equal(batch.chain_id, 1);
  assert.equal(batch.collection_key, 'dmx-mainnet-v1');
  assert.equal(batch.status, 'staged');
  assert.equal(batch.contract_address, null);
  assert.equal(batch.bound_at_ms, null);
  assert.equal(batch.credential_count, 777);
  assert.equal(batch.credential_set_sha256, mainnetCredentialFingerprint(manifest));
  assert.ok(Number(batch.verified_at_ms) >= manifest.createdAtMs);
  const rows = fixture.credentials();
  assert.equal(rows.length, 777);
  for (const [index, credential] of mainnetCredentials(manifest).entries()) {
    assert.equal(rows[index].batch_id, manifest.batchId);
    assert.equal(rows[index].token_id, credential.tokenId);
    assert.equal(rows[index].code_hash, credential.codeHash);
    assert.equal(rows[index].created_at_ms, manifest.createdAtMs);
    assert.equal(rows[index].revoked_at_ms, null);
  }
  await stageMainnetCredentials(manifest, fixture.adapter);
  assert.deepEqual(fixture.credentials(), rows);
  const writes = fixture.commands.length;
  const verified = await verifyMainnetCredentials(manifest, fixture.adapter);
  assert.deepEqual(verified, staged);
  assert.equal(fixture.commands.length, writes);
  assert.deepEqual(fixture.sepolia(), sepolia);
  const emitted = [...fixture.queries, ...fixture.commands, JSON.stringify(staged), JSON.stringify(verified)].join('\n');
  for (const link of manifest.links) {
    assert.equal(emitted.includes(link.code), false);
    assert.equal(emitted.includes(link.url), false);
  }
});

test('staging resumes a pending partial credential set without changing its existing rows', async t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  insertPending(fixture, manifest, 37);
  const existing = fixture.credentials();
  await assert.rejects(async () => verifyMainnetCredentials(manifest, fixture.adapter));
  assert.equal(fixture.commands.length, 0);
  await stageMainnetCredentials(manifest, fixture.adapter);
  assert.equal(fixture.credentials().length, 777);
  assert.deepEqual(fixture.credentials().slice(0, existing.length), existing);
  assert.equal(fixture.batches()[0].status, 'staged');
  assert.equal(fixture.batches()[0].contract_address, null);
  await verifyMainnetCredentials(manifest, fixture.adapter);
});

test('staging refuses conflicting and revoked credentials without overwriting or clearing them', async t => {
  const { manifest } = bundle(t);
  for (const corruption of ["code_hash='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'", 'revoked_at_ms=created_at_ms']) {
    const fixture = database(t);
    insertPending(fixture, manifest, 37);
    fixture.db.exec(`UPDATE dmx_mainnet_claim_codes SET ${corruption} WHERE token_id=1`);
    const before = { batches: fixture.batches(), credentials: fixture.credentials(), sepolia: fixture.sepolia() };
    await assert.rejects(async () => stageMainnetCredentials(manifest, fixture.adapter));
    await assert.rejects(async () => verifyMainnetCredentials(manifest, fixture.adapter));
    assert.deepEqual({ batches: fixture.batches(), credentials: fixture.credentials(), sepolia: fixture.sepolia() }, before);
  }
});

test('another batch cannot replace the collection staging identity', async t => {
  const original = bundle(t);
  const alternate = bundle(t);
  const fixture = database(t);
  await stageMainnetCredentials(original.manifest, fixture.adapter);
  const before = { batches: fixture.batches(), credentials: fixture.credentials() };
  await assert.rejects(async () => stageMainnetCredentials(alternate.manifest, fixture.adapter));
  await assert.rejects(async () => verifyMainnetCredentials(alternate.manifest, fixture.adapter));
  assert.deepEqual({ batches: fixture.batches(), credentials: fixture.credentials() }, before);
});

test('completed staging cannot silently repair deleted, changed, or revoked credentials', async t => {
  const { manifest } = bundle(t);
  for (const corruption of [
    'DELETE FROM dmx_mainnet_claim_codes WHERE token_id=777',
    "UPDATE dmx_mainnet_claim_codes SET code_hash='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE token_id=777",
    'UPDATE dmx_mainnet_claim_codes SET revoked_at_ms=created_at_ms WHERE token_id=777',
  ]) {
    const fixture = database(t);
    await stageMainnetCredentials(manifest, fixture.adapter);
    fixture.db.exec(corruption);
    const before = { batches: fixture.batches(), credentials: fixture.credentials() };
    const writes = fixture.commands.length;
    await assert.rejects(async () => stageMainnetCredentials(manifest, fixture.adapter));
    await assert.rejects(async () => verifyMainnetCredentials(manifest, fixture.adapter));
    assert.equal(fixture.commands.length, writes);
    assert.deepEqual({ batches: fixture.batches(), credentials: fixture.credentials() }, before);
  }
});

test('a bound batch cannot be staged again or reported as unbound staging', async t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  await stageMainnetCredentials(manifest, fixture.adapter);
  fixture.db.prepare("UPDATE dmx_mainnet_claim_batches SET status='bound', contract_address=?, bound_at_ms=verified_at_ms")
    .run(`0x${'34'.repeat(20)}`);
  const before = { batches: fixture.batches(), credentials: fixture.credentials() };
  const writes = fixture.commands.length;
  await assert.rejects(async () => stageMainnetCredentials(manifest, fixture.adapter));
  await assert.rejects(async () => verifyMainnetCredentials(manifest, fixture.adapter));
  assert.equal(fixture.commands.length, writes);
  assert.deepEqual({ batches: fixture.batches(), credentials: fixture.credentials() }, before);
});

const binding = { contractAddress: '0x' + '34'.repeat(20), deploymentBlock: 100, transactionHash: '0x' + 'c'.repeat(64) };
const rendererAddress = '0x' + '56'.repeat(20);
const signerAddress = '0x' + '78'.repeat(20);
const deployerAddress = '0x' + '9a'.repeat(20);
const deploymentHash = '0x' + 'a'.repeat(64);
const currentHash = '0x' + 'b'.repeat(64);

function bindingRpcFixture(overrides: {
  chainId?: unknown; currentBlock?: number; previousCode?: unknown; deployedCode?: unknown;
  currentCode?: unknown; rendererCode?: unknown; getters?: Record<string, unknown>;
  domain?: unknown[]; reorgAfterDeploymentRead?: number;
  transaction?: Record<string, unknown> | null; receipt?: Record<string, unknown> | null;
} = {}) {
  const getters: Array<[string, string, unknown]> = [
    ['name()', 'string', 'divination machina x'], ['symbol()', 'string', 'DMX'],
    ['INITIAL_CARDS()', 'uint256', 777], ['MAX_CARDS()', 'uint256', 999999], ['RECEIPT_OFFSET()', 'uint256', 999999],
    ['quoteSigner()', 'address', signerAddress], ['renderer()', 'address', rendererAddress],
  ];
  const responses = new Map(getters.map(([signature, type, value]) => [encodeCall(signature, [], []),
    encodeAbi([type], [overrides.getters?.[signature] ?? value])]));
  responses.set(encodeCall('eip712Domain()', [], []), encodeAbi(
    ['bytes1', 'string', 'string', 'uint256', 'address', 'bytes32', 'uint256[]'],
    overrides.domain ?? ['0x0f', 'divination machina x', '1', 1, binding.contractAddress, '0x' + '0'.repeat(64), []],
  ));
  const requests: { method: string; params: unknown[] }[] = [];
  let deploymentReads = 0;
  const currentBlock = overrides.currentBlock ?? 102;
  const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
    requests.push({ method, params });
    if (method === 'eth_chainId') return overrides.chainId ?? '0x1';
    if (method === 'eth_getTransactionByHash') {
      assert.deepEqual(params, [binding.transactionHash]);
      return overrides.transaction === null ? null : {
        hash: binding.transactionHash, from: deployerAddress, to: null, blockNumber: '0x64', blockHash: deploymentHash,
        chainId: '0x1', value: '0x0', nonce: '0x2', input: runtimeArtifact.bytecode.object +
          encodeAbi(['address', 'address', 'address'], [deployerAddress, signerAddress, rendererAddress]).slice(2),
        ...overrides.transaction,
      };
    }
    if (method === 'eth_getTransactionReceipt') {
      assert.deepEqual(params, [binding.transactionHash]);
      return overrides.receipt === null ? null : {
        transactionHash: binding.transactionHash, from: deployerAddress, to: null, status: '0x1',
        contractAddress: binding.contractAddress, blockNumber: '0x64', blockHash: deploymentHash, ...overrides.receipt,
      };
    }
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === '0x64') {
        deploymentReads++;
        return { number: '0x64', hash: deploymentReads > (overrides.reorgAfterDeploymentRead ?? Infinity) ? currentHash : deploymentHash };
      }
      assert.ok(params[0] === 'latest' || params[0] === '0x' + currentBlock.toString(16));
      return { number: '0x' + currentBlock.toString(16), hash: currentHash };
    }
    if (method === 'eth_getCode') {
      if (params[0] === rendererAddress) return overrides.rendererCode ?? '0x6001';
      assert.equal(params[0], binding.contractAddress);
      if (params[1] === '0x63') return overrides.previousCode ?? '0x';
      if (params[1] === '0x64') return overrides.deployedCode ?? runtimeArtifact.deployedBytecode.object;
      assert.equal(params[1], '0x' + currentBlock.toString(16));
      return overrides.currentCode ?? runtimeArtifact.deployedBytecode.object;
    }
    if (method === 'eth_call') {
      const call = params[0] as { to: string; data: `0x${string}` };
      assert.equal(call.to, binding.contractAddress);
      assert.equal(params[1], '0x' + currentBlock.toString(16));
      assert.ok(responses.has(call.data));
      return responses.get(call.data);
    }
    throw new Error('Unexpected mock RPC method: ' + method);
  };
  return { rpc, requests };
}

test('mainnet binding requires explicit deployment scope and HTTPS read-only RPC configuration', async t => {
  for (const [contract, block] of [[undefined, undefined], [binding.contractAddress, undefined],
    [undefined, 100], ['0x' + '0'.repeat(40), 100], [binding.contractAddress, '1e2'], [binding.contractAddress, 0]]) {
    assert.throws(() => mainnetBindingConfiguration(contract, block, binding.transactionHash));
  }
  for (const transactionHash of [undefined, '', '0x1234', '0x' + 'g'.repeat(64)]) {
    assert.throws(() => mainnetBindingConfiguration(binding.contractAddress, 100, transactionHash));
  }
  assert.deepEqual(mainnetBindingConfiguration(binding.contractAddress.toUpperCase().replace('0X', '0x'), '100', binding.transactionHash), binding);
  for (const args of [['mainnet-bind'], ['mainnet-bind', '--contract', binding.contractAddress],
    ['mainnet-bind', '--deployment-block', '100'],
    ['mainnet-bind', '--contract', binding.contractAddress, '--deployment-block', '100'],
    ['mainnet-bind', '--deployment-transaction', binding.transactionHash]]) {
    await assert.rejects(runTarotOperations(args), /Mainnet binding requires/);
  }
  await assert.rejects(runTarotOperations(['mainnet-verify', '--deployment-block', '100']), /only allowed for mainnet-bind/);
  await assert.rejects(runTarotOperations(['mainnet-verify', '--deployment-transaction', binding.transactionHash]), /only allowed for mainnet-bind/);
  assert.throws(() => mainnetBindingRpc({ ETHEREUM_TAROT_MAINNET_RPC_URL: 'http://rpc.example' }), /HTTPS/);
  const calls: { url: string; method: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), method: JSON.parse(String(options?.body)).method });
    return Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' });
  });
  const rpc = mainnetBindingRpc({});
  assert.equal(await rpc('eth_chainId'), '0x1');
  assert.equal(await rpc('eth_getTransactionByHash', [binding.transactionHash]), '0x1');
  assert.equal(await rpc('eth_getTransactionReceipt', [binding.transactionHash]), '0x1');
  await assert.rejects(rpc('eth_sendRawTransaction', ['0x']), /read-only/);
  assert.deepEqual(calls, ['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']
    .map(method => ({ url: 'https://ethereum-rpc.publicnode.com/', method })));
});

test('bound credential storage enforces strict scope, hashes, token range, timestamps, and references', t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  stageMainnetCredentials(manifest, fixture.adapter);
  const columns = fixture.db.prepare('PRAGMA table_info(dmx_mainnet_bound_claim_codes)').all().map(row => row.name);
  assert.deepEqual(columns, ['batch_id', 'chain_id', 'contract_address', 'token_id', 'code_hash', 'created_at_ms', 'revoked_at_ms']);
  assert.equal(fixture.db.prepare("SELECT strict FROM pragma_table_list WHERE name='dmx_mainnet_bound_claim_codes'").get()?.strict, 1);
  const reference = fixture.db.prepare('PRAGMA foreign_key_list(dmx_mainnet_bound_claim_codes)').get();
  assert.equal(reference?.table, 'dmx_mainnet_claim_batches');
  assert.equal(reference?.on_delete, 'NO ACTION');
  const row = [manifest.batchId, 1, binding.contractAddress, 1, 'a'.repeat(64), manifest.createdAtMs, null] as const;
  const insert = fixture.db.prepare('INSERT INTO dmx_mainnet_bound_claim_codes VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [index, invalid] of [[0, randomUUID()], [1, 11155111], [2, '0x' + '0'.repeat(40)],
    [2, '0x' + 'AB'.repeat(20)], [3, 0], [3, 778], [4, 'a'.repeat(63)], [4, 'A'.repeat(64)], [5, -1],
    [6, manifest.createdAtMs - 1]] as const) {
    const values = [...row];
    values[index] = invalid;
    assert.throws(() => insert.run(...values));
  }
  insert.run(...row);
  assert.throws(() => insert.run(manifest.batchId, 1, binding.contractAddress, 2, 'a'.repeat(64), manifest.createdAtMs, null));
});

test('binding verifies Ethereum deployment and all credentials before making the staged batch bound', async t => {
  const { root, directory, manifest } = bundle(t);
  const fixture = database(t);
  stageMainnetCredentials(manifest, fixture.adapter);
  const before = { staged: fixture.credentials(), sepolia: fixture.sepolia(), verifiedAt: fixture.batches()[0].verified_at_ms,
    files: [manifestName, csvName].map(name => readFileSync(join(directory, name), 'utf8')) };
  const rpc = bindingRpcFixture();
  const result = await bindMainnetCredentials(manifest, fixture.adapter, binding, rpc.rpc);
  assert.equal(result.status, 'bound');
  assert.equal(result.contractAddress, binding.contractAddress);
  assert.equal(result.deploymentBlock, binding.deploymentBlock);
  assert.equal(result.deploymentBlockHash, deploymentHash);
  assert.equal(result.quoteSigner, signerAddress);
  assert.equal(result.renderer, rendererAddress);
  assert.equal(fixture.batches()[0].status, 'bound');
  assert.equal(fixture.batches()[0].verified_at_ms, before.verifiedAt);
  assert.ok(Number(fixture.batches()[0].bound_at_ms) >= Number(before.verifiedAt));
  const rows = fixture.boundCredentials();
  assert.equal(rows.length, 777);
  for (const [index, link] of manifest.links.entries()) {
    assert.equal(rows[index].batch_id, manifest.batchId);
    assert.equal(rows[index].chain_id, 1);
    assert.equal(rows[index].contract_address, binding.contractAddress);
    assert.equal(rows[index].token_id, link.tokenId);
    assert.equal(rows[index].code_hash, createHash('sha256').update(tarotCodeHashInput({
      chainId: 1, contractAddress: binding.contractAddress, tokenId: link.tokenId, code: link.code,
    })).digest('hex'));
    assert.notEqual(rows[index].code_hash, before.staged[index].code_hash);
    assert.equal(rows[index].created_at_ms, manifest.createdAtMs);
    assert.equal(rows[index].revoked_at_ms, null);
  }
  const chunks = fixture.commands.filter(sql => sql.includes('INSERT INTO dmx_mainnet_bound_claim_codes'));
  assert.equal(chunks.length, 16);
  assert.ok(chunks.every(sql => Buffer.byteLength(sql) < 10_000));
  assert.deepEqual(fixture.credentials(), before.staged);
  assert.deepEqual(fixture.sepolia(), before.sepolia);
  assert.deepEqual(loadMainnetClaimLinks(directory, root), manifest);
  assert.deepEqual([manifestName, csvName].map(name => readFileSync(join(directory, name), 'utf8')), before.files);
  const emitted = [...fixture.queries, ...fixture.commands, JSON.stringify(result), JSON.stringify(rpc.requests)].join('\n');
  for (const link of manifest.links) assert.ok(!emitted.includes(link.code) && !emitted.includes(link.url));
  const writes = fixture.commands.length;
  const boundAt = fixture.batches()[0].bound_at_ms;
  assert.deepEqual(await bindMainnetCredentials(manifest, fixture.adapter, binding, bindingRpcFixture().rpc), result);
  assert.equal(fixture.commands.length, writes);
  assert.equal(fixture.batches()[0].bound_at_ms, boundAt);
  assert.throws(() => verifyMainnetCredentials(manifest, fixture.adapter));
});

test('missing or inconsistent deployment transactions and receipts cannot bind or write final credentials', async t => {
  const { manifest } = bundle(t);
  const constructorArgs = encodeAbi(['address', 'address', 'address'], [deployerAddress, signerAddress, rendererAddress]);
  const creationCode = runtimeArtifact.bytecode.object;
  const zeroAddress = '0x' + '0'.repeat(40);
  const invalidArguments = [
    '0x', encodeAbi(['address', 'address'], [deployerAddress, signerAddress]), constructorArgs + '00',
    '0x01' + constructorArgs.slice(4),
    ...[0, 1, 2].map(index => encodeAbi(['address', 'address', 'address'],
      [deployerAddress, signerAddress, rendererAddress].map((address, position) => position === index ? zeroAddress : address))),
  ];
  const cases: Array<{ label: string; transaction?: Record<string, unknown> | null; receipt?: Record<string, unknown> | null }> = [
    { label: 'missing transaction', transaction: null },
    { label: 'missing receipt', receipt: null },
    { label: 'wrong transaction hash', transaction: { hash: currentHash } },
    { label: 'wrong receipt transaction hash', receipt: { transactionHash: currentHash } },
    { label: 'failed receipt', receipt: { status: '0x0' } },
    { label: 'factory transaction', transaction: { to: rendererAddress } },
    { label: 'factory receipt', receipt: { to: rendererAddress } },
    { label: 'missing creation destination', transaction: { to: undefined } },
    { label: 'wrong transaction block', transaction: { blockNumber: '0x65' } },
    { label: 'wrong receipt block', receipt: { blockNumber: '0x65' } },
    { label: 'wrong transaction block hash', transaction: { blockHash: currentHash } },
    { label: 'wrong receipt block hash', receipt: { blockHash: currentHash } },
    { label: 'wrong deployed address', receipt: { contractAddress: rendererAddress } },
    { label: 'inconsistent transaction sender', transaction: { from: rendererAddress } },
    { label: 'inconsistent receipt sender', receipt: { from: rendererAddress } },
    { label: 'missing sender', transaction: { from: undefined } },
    { label: 'wrong transaction chain', transaction: { chainId: '0xaa36a7' } },
    { label: 'nonzero creation value', transaction: { value: '0x1' } },
    { label: 'missing creation input', transaction: { input: undefined } },
    { label: 'different creation bytecode', transaction: { input: '0x00' + creationCode.slice(4) + constructorArgs.slice(2) } },
    ...invalidArguments.map((args, index) => ({ label: `invalid constructor arguments ${index}`,
      transaction: { input: creationCode + args.slice(2) } })),
  ];
  for (const { label, ...overrides } of cases) {
    const fixture = database(t);
    stageMainnetCredentials(manifest, fixture.adapter);
    const before = { batches: fixture.batches(), credentials: fixture.credentials(), sepolia: fixture.sepolia() };
    const writes = fixture.commands.length;
    await assert.rejects(bindMainnetCredentials(manifest, fixture.adapter, binding, bindingRpcFixture(overrides).rpc), label);
    assert.equal(fixture.commands.length, writes, label);
    assert.deepEqual({ batches: fixture.batches(), credentials: fixture.credentials(), sepolia: fixture.sepolia() }, before, label);
    assert.equal(fixture.boundCredentials().length, 0, label);
  }
});

test('verified constructor evidence still permits legitimate quote signer rotation', async t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  stageMainnetCredentials(manifest, fixture.adapter);
  const rotatedSigner = '0x' + 'ab'.repeat(20);
  const result = await bindMainnetCredentials(manifest, fixture.adapter, binding,
    bindingRpcFixture({ getters: { 'quoteSigner()': rotatedSigner } }).rpc);
  assert.equal(result.status, 'bound');
  assert.equal(result.quoteSigner, rotatedSigner);
  assert.equal(fixture.boundCredentials().length, 777);
});

test('matching DMX getters cannot bind a getter-only contract without the approved runtime', async t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  stageMainnetCredentials(manifest, fixture.adapter);
  const before = { batches: fixture.batches(), credentials: fixture.credentials(), writes: fixture.commands.length };
  const rpc = bindingRpcFixture({ deployedCode: getterOnlyRuntime, currentCode: getterOnlyRuntime });
  await assert.rejects(bindMainnetCredentials(manifest, fixture.adapter, binding, rpc.rpc));
  assert.equal(fixture.commands.length, before.writes);
  assert.deepEqual(fixture.batches(), before.batches);
  assert.deepEqual(fixture.credentials(), before.credentials);
  assert.equal(fixture.boundCredentials().length, 0);
  assert.equal(fixture.batches()[0].status, 'staged');
});

test('binding rejects a changed runtime byte outside compiler-declared immutable slots', async t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  stageMainnetCredentials(manifest, fixture.adapter);
  const bytes = Buffer.from(runtimeArtifact.deployedBytecode.object.slice(2), 'hex');
  const references = Object.values(runtimeArtifact.deployedBytecode.immutableReferences).flat();
  const offset = bytes.findIndex((_, index) => !references.some(reference => index >= reference.start && index < reference.start + reference.length));
  assert.ok(offset >= 0);
  bytes[offset] ^= 1;
  const modifiedRuntime = '0x' + bytes.toString('hex');
  const writes = fixture.commands.length;
  await assert.rejects(bindMainnetCredentials(manifest, fixture.adapter, binding,
    bindingRpcFixture({ deployedCode: modifiedRuntime, currentCode: modifiedRuntime }).rpc));
  assert.equal(fixture.commands.length, writes);
  assert.equal(fixture.boundCredentials().length, 0);
  assert.equal(fixture.batches()[0].status, 'staged');
});

test('binding accepts matching runtime with compiler-declared immutable differences', async t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  stageMainnetCredentials(manifest, fixture.adapter);
  const bytes = Buffer.from(runtimeArtifact.deployedBytecode.object.slice(2), 'hex');
  const references = Object.values(runtimeArtifact.deployedBytecode.immutableReferences).flat();
  assert.ok(references.length > 0);
  for (const { start, length } of references) bytes.fill(0x5a, start, start + length);
  const deployedRuntime = '0x' + bytes.toString('hex');
  assert.notEqual(deployedRuntime, runtimeArtifact.deployedBytecode.object);
  const bound = await bindMainnetCredentials(manifest, fixture.adapter, binding,
    bindingRpcFixture({ deployedCode: deployedRuntime, currentCode: deployedRuntime }).rpc);
  assert.equal(bound.status, 'bound');
  assert.equal(fixture.boundCredentials().length, 777);
});

test('interrupted binding leaves the batch staged and resumes the exact partial hashes', async t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  stageMainnetCredentials(manifest, fixture.adapter);
  let inserts = 0;
  const interrupted = { ...fixture.adapter, executeCommand(sql: string) {
    if (sql.includes('INSERT INTO dmx_mainnet_bound_claim_codes') && ++inserts === 4) throw new Error('Synthetic interruption');
    return fixture.adapter.executeCommand(sql);
  } };
  await assert.rejects(bindMainnetCredentials(manifest, interrupted, binding, bindingRpcFixture().rpc), /Synthetic interruption/);
  const partial = fixture.boundCredentials();
  assert.equal(partial.length, 150);
  assert.equal(fixture.batches()[0].status, 'staged');
  assert.equal(fixture.batches()[0].contract_address, null);
  await bindMainnetCredentials(manifest, fixture.adapter, binding, bindingRpcFixture().rpc);
  assert.deepEqual(fixture.boundCredentials().slice(0, 150), partial);
  assert.equal(fixture.boundCredentials().length, 777);
  assert.equal(fixture.batches()[0].status, 'bound');
});

test('a canonicality failure after all final inserts leaves binding inactive and can be retried', async t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  stageMainnetCredentials(manifest, fixture.adapter);
  await assert.rejects(bindMainnetCredentials(manifest, fixture.adapter, binding,
    bindingRpcFixture({ reorgAfterDeploymentRead: 3 }).rpc), /no longer canonical/);
  assert.equal(fixture.boundCredentials().length, 777);
  assert.equal(fixture.batches()[0].status, 'staged');
  assert.equal(fixture.batches()[0].contract_address, null);
  await bindMainnetCredentials(manifest, fixture.adapter, binding, bindingRpcFixture().rpc);
  assert.equal(fixture.batches()[0].status, 'bound');
});

test('wrong chain, deployment code, getters, domain, signer, renderer, or confirmations cannot bind', async t => {
  const { manifest } = bundle(t);
  const domain = ['0x0f', 'divination machina x', '1', 1, binding.contractAddress, '0x' + '0'.repeat(64), []];
  for (const overrides of [
    { chainId: '0xaa36a7' }, { currentBlock: 101 }, { previousCode: '0x6002' }, { deployedCode: '0x' },
    { currentCode: '0x6003' }, { rendererCode: '0x' }, { reorgAfterDeploymentRead: 1 },
    { getters: { 'name()': 'Tarot Cards' } }, { getters: { 'symbol()': 'TAROT' } },
    { getters: { 'INITIAL_CARDS()': 778 } }, { getters: { 'MAX_CARDS()': 777 } },
    { getters: { 'RECEIPT_OFFSET()': 777 } }, { getters: { 'quoteSigner()': '0x' + '0'.repeat(40) } },
    { getters: { 'renderer()': binding.contractAddress } },
    ...[0, 1, 2, 3, 4].map(index => ({ domain: domain.map((value, position) => position === index
      ? ['0x00', 'Tarot Cards', '2', 11155111, rendererAddress][index] : value) })),
  ]) {
    const fixture = database(t);
    stageMainnetCredentials(manifest, fixture.adapter);
    const writes = fixture.commands.length;
    await assert.rejects(bindMainnetCredentials(manifest, fixture.adapter, binding, bindingRpcFixture(overrides).rpc));
    assert.equal(fixture.commands.length, writes);
    assert.equal(fixture.boundCredentials().length, 0);
    assert.equal(fixture.batches()[0].status, 'staged');
  }
});

test('binding refuses incomplete or revoked staged credentials before RPC and final writes', async t => {
  const { manifest } = bundle(t);
  for (const corruption of ['DELETE FROM dmx_mainnet_claim_codes WHERE token_id=777',
    'UPDATE dmx_mainnet_claim_codes SET revoked_at_ms=created_at_ms WHERE token_id=1']) {
    const fixture = database(t);
    stageMainnetCredentials(manifest, fixture.adapter);
    fixture.db.exec(corruption);
    const rpc = bindingRpcFixture();
    const writes = fixture.commands.length;
    await assert.rejects(bindMainnetCredentials(manifest, fixture.adapter, binding, rpc.rpc));
    assert.equal(fixture.commands.length, writes);
    assert.equal(rpc.requests.length, 0);
    assert.equal(fixture.boundCredentials().length, 0);
  }
});

test('binding refuses conflicting partial rows and revoked final rows without overwriting them', async t => {
  const { manifest } = bundle(t);
  const codeHash = createHash('sha256').update(tarotCodeHashInput({
    chainId: 1, contractAddress: binding.contractAddress, tokenId: 1, code: manifest.links[0].code,
  })).digest('hex');
  for (const [address, value, revoked] of [[rendererAddress, codeHash, null],
    [binding.contractAddress, 'f'.repeat(64), null], [binding.contractAddress, codeHash, manifest.createdAtMs]] as const) {
    const fixture = database(t);
    stageMainnetCredentials(manifest, fixture.adapter);
    fixture.db.prepare('INSERT INTO dmx_mainnet_bound_claim_codes VALUES (?, 1, ?, 1, ?, ?, ?)')
      .run(manifest.batchId, address, value, manifest.createdAtMs, revoked);
    const before = fixture.boundCredentials();
    const writes = fixture.commands.length;
    await assert.rejects(bindMainnetCredentials(manifest, fixture.adapter, binding, bindingRpcFixture().rpc));
    assert.equal(fixture.commands.length, writes);
    assert.deepEqual(fixture.boundCredentials(), before);
    assert.equal(fixture.batches()[0].status, 'staged');
  }
});

test('a completed binding cannot change contract or silently repair missing or revoked final credentials', async t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  stageMainnetCredentials(manifest, fixture.adapter);
  await bindMainnetCredentials(manifest, fixture.adapter, binding, bindingRpcFixture().rpc);
  const writes = fixture.commands.length;
  await assert.rejects(bindMainnetCredentials(manifest, fixture.adapter,
    { ...binding, contractAddress: rendererAddress }, bindingRpcFixture().rpc));
  fixture.db.exec('UPDATE dmx_mainnet_bound_claim_codes SET revoked_at_ms=created_at_ms WHERE token_id=1');
  await assert.rejects(bindMainnetCredentials(manifest, fixture.adapter, binding, bindingRpcFixture().rpc));
  fixture.db.exec('DELETE FROM dmx_mainnet_bound_claim_codes WHERE token_id=1');
  await assert.rejects(bindMainnetCredentials(manifest, fixture.adapter, binding, bindingRpcFixture().rpc));
  assert.equal(fixture.commands.length, writes);
});

test('revocation during final chain verification prevents marking the batch bound', async t => {
  const { manifest } = bundle(t);
  const fixture = database(t);
  stageMainnetCredentials(manifest, fixture.adapter);
  const mock = bindingRpcFixture();
  let chainReads = 0;
  const rpc = async (method: string, params?: unknown[]) => {
    if (method === 'eth_chainId' && ++chainReads === 2) {
      fixture.db.exec('UPDATE dmx_mainnet_bound_claim_codes SET revoked_at_ms=created_at_ms WHERE token_id=1');
    }
    return mock.rpc(method, params);
  };
  await assert.rejects(bindMainnetCredentials(manifest, fixture.adapter, binding, rpc));
  assert.equal(fixture.batches()[0].status, 'staged');
  assert.equal(fixture.batches()[0].contract_address, null);
});
