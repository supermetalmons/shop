import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  deploymentConfiguration, deploymentConstructorArgs, deploymentGas, main, TAROT_SEPOLIA,
  validateDeploymentConfiguration, validateSignedDeployment, readRendererRelease, rendererInterfaceId, validateCollectionMetadata,
  verifyDeploymentState, verifyRendererRelease,
} from './tarot-deployment.mjs';

const quoteSigner = '0x2222222222222222222222222222222222222222';
const rendererAddress = '0x4444444444444444444444444444444444444444';
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const configuration = () => ({ network: 'sepolia', ...deploymentConfiguration('sepolia', quoteSigner, rendererAddress),
  expectedCollectionImage: collectionMetadata.image });
const collectionMetadata = { name: 'divination machina x', symbol: 'DMX', description: '777 Tarot cards and their paired NFC receipts.',
  image: 'https://wip.lil.org/dmx/cards/1.webp', external_link: 'https://mons.shop' };
const collectionURI = 'data:application/json;base64,' + Buffer.from(JSON.stringify(collectionMetadata)).toString('base64');
const historicalMetadata = { ...collectionMetadata, image: 'https://wip.lil.org/tarot/bases/1.webp' };
const historicalURI = 'data:application/json;base64,' + Buffer.from(JSON.stringify(historicalMetadata)).toString('base64');
const project = fileURLToPath(new URL('../', import.meta.url));
const originalReadFileSync = fs.readFileSync;
let build;
let artifacts;

before(async () => {
  build = fs.mkdtempSync(path.join(os.tmpdir(), 'tarot-build-test-'));
  const contracts = ['TarotCards', 'DMXWebpRenderer'];
  execFileSync('forge', ['build', '--offline', ...contracts.map(name => 'src/' + name + '.sol'),
    '--out', path.join(build, 'out'), '--cache-path', path.join(build, 'cache')],
  { cwd: project, stdio: 'pipe', timeout: 30_000 });
  artifacts = Object.fromEntries(await Promise.all(contracts.map(async name => [name,
    JSON.parse(await fs.promises.readFile(path.join(build, 'out', name + '.sol', name + '.json'), 'utf8'))])));
});

after(() => {
  if (build) fs.rmSync(build, { recursive: true, force: true });
  assert.equal(fs.readFileSync, originalReadFileSync, 'Filesystem mock must be restored after tests');
});

test('DMX configuration pins Sepolia, the approved admin and verified renderer', () => {
  const config = deploymentConfiguration('sepolia', quoteSigner.toUpperCase().replace('0X', '0x'), rendererAddress);
  assert.equal(config.chainId, 11155111);
  assert.equal(config.admin, TAROT_SEPOLIA.deployer);
  assert.equal(config.renderer, rendererAddress);
  assert.equal(config.releaseVersion, 2);
  assert.equal(config.quoteSigner, quoteSigner);
  for (const network of ['mainnet', 'devnet', 'local', 'other']) {
    assert.throws(() => deploymentConfiguration(network, quoteSigner), /Sepolia only/);
  }
  for (const signer of [undefined, '', 'wrong', '0x' + '0'.repeat(40)]) {
    assert.throws(() => deploymentConfiguration('sepolia', signer), /quote-signer/);
  }
  assert.throws(() => deploymentConfiguration('sepolia', TAROT_SEPOLIA.deployer), /dedicated/);
});

test('frozen deployment identity rejects changed roles, network and release version', () => {
  const manifest = configuration();
  assert.deepEqual(validateDeploymentConfiguration(manifest), deploymentConfiguration('sepolia', quoteSigner, rendererAddress));
  for (const [key, value] of Object.entries({ chainId: 1, network: 'mainnet', admin: quoteSigner,
    deployer: quoteSigner, releaseVersion: 1, expectedCollectionImage: historicalMetadata.image })) {
    assert.throws(() => validateDeploymentConfiguration({ ...manifest, [key]: value }));
  }
});

test('constructor encoding supplies owner, independent signer and renderer', () => {
  const config = configuration();
  const encoded = deploymentConstructorArgs(config);
  const values = JSON.parse(execFileSync('cast', ['abi-decode', 'constructor()(address,address,address)', encoded, '--json'], { encoding: 'utf8' }));
  assert.deepEqual(values.map(value => value.startsWith('0x') ? value.toLowerCase() : value),
    [config.admin, config.quoteSigner, config.renderer]);
});

test('journaled signed transaction cannot change chain, nonce, payment, signer, recipient or calldata', () => {
  const manifest = { ...configuration(), nonce: '2', gasPrice: '1000', gasLimit: '2000000', creationCode: '0x60006000f3' };
  const transaction = { signer: manifest.deployer, type: '0x0', chainId: '0xaa36a7', nonce: '0x2',
    gasPrice: '0x3e8', gas: '0x1e8480', to: null, value: '0x0', input: manifest.creationCode, hash: '0x1234' };
  validateSignedDeployment(transaction, manifest, transaction.hash);
  for (const [key, value] of Object.entries({ signer: quoteSigner, type: '0x2', chainId: '0x1', nonce: '0x3',
    gasPrice: '0x3e9', gas: '0x1000', to: quoteSigner, value: '0x1', input: '0x', hash: '0x5678' })) {
    assert.throws(() => validateSignedDeployment({ ...transaction, [key]: value }, manifest, transaction.hash));
  }
  const over = { ...manifest, gasPrice: '3000000000' };
  assert.throws(() => validateSignedDeployment({ ...transaction, gasPrice: '0xb2d05e00' }, over, transaction.hash), /fee ceiling/);
  assert.throws(() => deploymentGas('2000000', '3000000000', TAROT_SEPOLIA.maximumFeeWei), /fee ceiling/);
});

function rendererFixture(directory) {
  const artifact = artifacts.DMXWebpRenderer;
  const sources = Object.fromEntries(Object.keys(artifact.metadata.sources).map(name => [name, { content: fs.readFileSync(path.join(project, name), 'utf8') }]));
  const { compilationTarget, ...settings } = artifact.metadata.settings;
  const input = { language: 'Solidity', sources, settings };
  const manifest = { network: 'sepolia', ...deploymentConfiguration('sepolia', undefined, undefined, 'DMXWebpRenderer'),
    expectedCollectionImage: collectionMetadata.image,
    contractAddress: rendererAddress, constructorArgs: '0x', creationCode: artifact.bytecode.object,
    artifactSha256: sha256(json(artifact)), standardInputSha256: sha256(json(input)),
    deploymentBlockHash: '0x' + 'a'.repeat(64) };
  const deployment = { ...manifest, deploymentBlock: 1, transactionHash: '0x' + 'b'.repeat(64), confirmations: 3,
    collectionMetadata };
  for (const [name, value] of Object.entries({ 'manifest.json': manifest, 'deployment.json': deployment,
    'DMXWebpRenderer.artifact.json': artifact, 'DMXWebpRenderer.standard-input.json': input })) {
    fs.writeFileSync(path.join(directory, name), json(value));
  }
  return { manifest, deployment, artifact, input };
}

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tarot-deployment-test-'));
  const rendererDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-renderer-test-'));
  const renderer = rendererFixture(rendererDirectory);
  const previous = process.env.ETHEREUM_TAROT_RPC_URL;
  process.env.ETHEREUM_TAROT_RPC_URL = 'https://tarot-rpc.invalid';
  const read = fs.readFileSync.bind(fs);
  const artifactFiles = new Map(Object.entries(artifacts).map(([name, artifact]) => [
    path.join(project, 'out', name + '.sol', name + '.json'), json(artifact),
  ]));
  t.mock.method(fs, 'readFileSync', (filename, ...args) => {
    const name = filename instanceof URL ? fileURLToPath(filename) : String(filename);
    const artifact = artifactFiles.get(name);
    if (artifact !== undefined) return artifact;
    assert.ok(!name.startsWith(path.join(project, 'out') + path.sep), 'Tests must not read cached build artifacts');
    return read(filename, ...args);
  });
  const logs = [];
  const requests = [];
  let beforeRequest;
  t.mock.method(console, 'log', value => logs.push(JSON.parse(value)));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    await beforeRequest?.(request);
    const results = { eth_chainId: '0xaa36a7', eth_getTransactionCount: '0x0',
      eth_getCode: request.params[0] === rendererAddress ? renderer.artifact.deployedBytecode.object : '0x',
      eth_getTransactionReceipt: { status: '0x1', contractAddress: rendererAddress, blockNumber: '0x1',
        blockHash: renderer.manifest.deploymentBlockHash, from: TAROT_SEPOLIA.deployer, to: null },
      eth_getBlockByNumber: { number: '0x3', hash: renderer.manifest.deploymentBlockHash },
      eth_getTransactionByHash: { input: renderer.artifact.bytecode.object, from: TAROT_SEPOLIA.deployer, to: null,
        chainId: '0xaa36a7', value: '0x0' },
      eth_call: request.params[0]?.data?.startsWith('0x01ffc9a7') ? '0x' + '0'.repeat(63) + '1' : execFileSync('cast',
        ['abi-encode', 'value(string)', 'data:application/json;base64,' +
          Buffer.from(JSON.stringify(renderer.deployment.collectionMetadata)).toString('base64')], { encoding: 'utf8' }).trim(),
      eth_estimateGas: '0x1e8480', eth_gasPrice: '0x5f5e100', eth_getBalance: '0x11c37937e08000', ...overrides };
    assert.ok(Object.hasOwn(results, request.method), 'Unexpected RPC operation ' + request.method);
    return Response.json({ jsonrpc: '2.0', id: 1, result: results[request.method] });
  });
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(rendererDirectory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ETHEREUM_TAROT_RPC_URL;
    else process.env.ETHEREUM_TAROT_RPC_URL = previous;
  });
  return { directory, rendererDirectory, renderer, logs, requests,
    read: name => JSON.parse(read(path.join(directory, name), 'utf8')),
    prepare: () => main(['prepare', '--directory', directory, '--quote-signer', quoteSigner, '--renderer-directory', rendererDirectory]),
    beforeRequest: callback => { beforeRequest = callback; },
  };
}

test('preparation freezes real compiler sources and artifacts and never sends a transaction', async t => {
  const artifact = artifacts.TarotCards;
  const f = fixture(t);
  await f.prepare();
  const manifest = f.read('manifest.json');
  assert.equal(manifest.chainId, 11155111);
  assert.equal(manifest.quoteSigner, quoteSigner);
  assert.equal(manifest.network, 'sepolia');
  assert.equal(manifest.expectedCollectionImage, collectionMetadata.image);
  assert.equal(manifest.creationCode, artifact.bytecode.object + manifest.constructorArgs.slice(2));
  assert.deepEqual(f.read('TarotCards.artifact.json'), artifact);
  assert.equal(f.read('TarotCards.standard-input.json').sources['src/TarotCards.sol'].content,
    fs.readFileSync(new URL('../src/TarotCards.sol', import.meta.url), 'utf8'));
  assert.equal(fs.statSync(path.join(f.directory, 'manifest.json')).mode & 0o777, 0o600);
  assert.equal(f.requests.some(request => request.method === 'eth_sendRawTransaction'), false);
  assert.equal(f.logs[0].prepared, true);
  await assert.rejects(f.prepare(), /already contains a release/);
  manifest.renderer = quoteSigner;
  fs.writeFileSync(path.join(f.directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(main(['verify', '--directory', f.directory]), /Renderer prerequisite address changed/);
});

test('every deployment command requires an explicit release directory before any RPC operation', async t => {
  const f = fixture(t);
  for (const command of ['prepare', 'sign', 'broadcast', 'verify']) {
    await assert.rejects(main([command]), /explicit --directory is required/);
    await assert.rejects(main([command, '--directory', '   ']), /explicit --directory is required/);
  }
  await assert.rejects(main(['prepare', '--contract', 'DMXWebpRenderer']), /explicit --directory is required/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('mainnet and unsafe credential arguments fail before any RPC operation', async t => {
  const f = fixture(t);
  await assert.rejects(main(['prepare', '--network', 'mainnet', '--directory', f.directory, '--quote-signer', quoteSigner]), /Sepolia only/);
  for (const option of ['--private-key', '--password', '--rpc-url']) {
    await assert.rejects(main(['sign', '--directory', f.directory, option, 'never-accepted']), /Invalid or repeated option/);
  }
  assert.equal(f.requests.length, 0);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

for (const chainId of ['0x1', true, 11155111, null]) {
  test(`wrong or malformed RPC chain ${JSON.stringify(chainId)} cannot prepare files`, async t => {
    const f = fixture(t, { eth_chainId: chainId });
    await assert.rejects(f.prepare(), /selected deployment network|Invalid RPC chain ID/);
    assert.deepEqual(f.requests.map(request => request.method), ['eth_chainId']);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  });
}

test('insufficient deployment funds cannot create a frozen release', async t => {
  const f = fixture(t, { eth_getBalance: '0x0' });
  await assert.rejects(f.prepare(), /Insufficient deployer funds/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('one preparation owns the release before RPC and excludes preparation, signing, broadcasting and verification', async t => {
  const f = fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.beforeRequest(async request => {
    if (request.method === 'eth_estimateGas') { entered.resolve(); await release.promise; }
  });
  const first = f.prepare();
  try {
    await entered.promise;
    const count = f.requests.length;
    for (const command of ['prepare', 'sign', 'broadcast', 'verify']) {
      await assert.rejects(main([command, '--directory', f.directory,
        ...(command === 'prepare' ? ['--quote-signer', '0x3333333333333333333333333333333333333333', '--renderer-directory', f.rendererDirectory] : [])]),
      /Another metadata operation owns/);
      assert.equal(f.requests.length, count);
      assert.deepEqual(fs.readdirSync(f.directory), ['operation.lock']);
    }
  } finally { release.resolve(); await first; }
  assert.equal(f.read('manifest.json').quoteSigner, quoteSigner);
  assert.equal(fs.existsSync(path.join(f.directory, 'operation.lock')), false);
  assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('.operation.lock-')), false);
  assert.equal(f.logs.filter(log => log.prepared).length, 1);
});

test('an existing journal prevents preparation before RPC without replacing any release evidence', async t => {
  const f = fixture(t);
  const journal = '{"existing":"journal must remain unchanged"}\n';
  const artifact = '{"existing":"artifact must remain unchanged"}\n';
  fs.writeFileSync(path.join(f.directory, 'transactions.private.json'), journal, { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, 'TarotCards.artifact.json'), artifact, { mode: 0o600 });
  await assert.rejects(f.prepare(), /already contains a release/);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.readFileSync(path.join(f.directory, 'transactions.private.json'), 'utf8'), journal);
  assert.equal(fs.readFileSync(path.join(f.directory, 'TarotCards.artifact.json'), 'utf8'), artifact);
  assert.equal(fs.existsSync(path.join(f.directory, 'operation.lock')), false);
});

for (const command of ['sign', 'broadcast', 'verify']) {
  test(`${command} holds exclusive ownership before loading the rest of the release and releases it after failure`, async t => {
    const f = fixture(t);
    await f.prepare();
    const files = new Map(fs.readdirSync(f.directory, { recursive: true }).filter(name => fs.statSync(path.join(f.directory, name)).isFile()).map(name => [name, fs.readFileSync(path.join(f.directory, name), 'utf8')]));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    f.beforeRequest(async request => {
      assert.equal(request.method, 'eth_chainId');
      entered.resolve();
      await release.promise;
      throw new Error('Fixture stops inside protected operation');
    });
    const first = main([command, '--directory', f.directory]).catch(error => error);
    try {
      await entered.promise;
      const count = f.requests.length;
      for (const contender of ['sign', 'broadcast', 'verify']) {
        await assert.rejects(main([contender, '--directory', f.directory]), /Another metadata operation owns/);
        assert.equal(f.requests.length, count);
      }
    } finally { release.resolve(); }
    assert.match((await first).message, /Fixture stops inside protected operation/);
    assert.deepEqual(fs.readdirSync(f.directory, { recursive: true }).filter(name => fs.statSync(path.join(f.directory, name)).isFile()).sort(), [...files.keys()].sort());
    for (const [name, content] of files) assert.equal(fs.readFileSync(path.join(f.directory, name), 'utf8'), content);
    f.beforeRequest(undefined);
    await assert.rejects(main(['sign', '--directory', f.directory]), /Signing requires/);
    assert.equal(fs.existsSync(path.join(f.directory, 'operation.lock')), false);
  });
}

function ownerLock(directory, owner) {
  const lock = path.join(directory, 'operation.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  const marker = path.join(lock, `${owner.id}.json`);
  fs.writeFileSync(marker, JSON.stringify(owner), { mode: 0o600 });
  return { lock, marker, body: fs.readFileSync(marker, 'utf8') };
}

test('a crashed local owner can be recovered without changing existing signed state', async t => {
  const f = fixture(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  ownerLock(f.directory, { id: randomUUID(), pid: exited.pid, host: os.hostname() });
  const journal = '{"existing":"signed release"}\n';
  fs.writeFileSync(path.join(f.directory, 'transactions.private.json'), journal, { mode: 0o600 });
  await assert.rejects(f.prepare(), /already contains a release/);
  assert.equal(fs.readFileSync(path.join(f.directory, 'transactions.private.json'), 'utf8'), journal);
  assert.deepEqual(fs.readdirSync(f.directory), ['transactions.private.json']);
  assert.equal(f.requests.length, 0);
});

test('a crashed local preparation recovers its lock and completes using a fresh owner', async t => {
  const f = fixture(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  const owner = { id: randomUUID(), pid: exited.pid, host: os.hostname() };
  const lock = ownerLock(f.directory, owner);
  f.beforeRequest(() => {
    const markers = fs.readdirSync(lock.lock);
    assert.equal(markers.length, 1);
    assert.notEqual(markers[0], `${owner.id}.json`);
    const current = JSON.parse(fs.readFileSync(path.join(lock.lock, markers[0]), 'utf8'));
    assert.equal(current.pid, process.pid);
    assert.equal(current.host, os.hostname());
  });
  await f.prepare();
  assert.equal(f.read('manifest.json').quoteSigner, quoteSigner);
  assert.equal(fs.existsSync(lock.lock), false);
});

for (const kind of ['live', 'foreign-host', 'invalid-pid', 'mismatched-marker']) {
  test(`a ${kind} release owner cannot be stolen or deleted`, async t => {
    const f = fixture(t);
    const owner = { id: randomUUID(), pid: process.pid, host: os.hostname() };
    if (kind === 'foreign-host') owner.host += '-other';
    if (kind === 'invalid-pid') owner.pid = 0;
    const lock = ownerLock(f.directory, owner);
    if (kind === 'mismatched-marker') {
      fs.writeFileSync(lock.marker, JSON.stringify({ ...owner, id: randomUUID() }));
      lock.body = fs.readFileSync(lock.marker, 'utf8');
    }
    await assert.rejects(f.prepare(), /Another metadata operation owns/);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(fs.readdirSync(f.directory), ['operation.lock']);
    assert.equal(fs.readFileSync(lock.marker, 'utf8'), lock.body);
  });
}

test('legacy or unreadable locks fail closed without deleting their contents', async t => {
  const f = fixture(t);
  const filename = path.join(f.directory, 'operation.lock');
  fs.writeFileSync(filename, 'unknown owner');
  await assert.rejects(f.prepare(), /Legacy or invalid metadata lock/);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'unknown owner');
  fs.unlinkSync(filename);
  fs.mkdirSync(filename);
  const marker = path.join(filename, `${randomUUID()}.json`);
  fs.writeFileSync(marker, '{incomplete');
  await assert.rejects(f.prepare(), /Unreadable metadata lock/);
  assert.equal(fs.readFileSync(marker, 'utf8'), '{incomplete');
  assert.equal(f.requests.length, 0);
});

test('release locks stay inside private release directories', async t => {
  const f = fixture(t);
  fs.chmodSync(f.directory, 0o755);
  await assert.rejects(f.prepare(), /Release directory must be private/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.equal(f.requests.length, 0);
  const trackedDirectory = fileURLToPath(new URL('../scripts', import.meta.url));
  await assert.rejects(main(['prepare', '--directory', trackedDirectory, '--quote-signer', quoteSigner, '--renderer-directory', f.rendererDirectory]), /private ignored directory/);
  assert.equal(fs.existsSync(path.join(trackedDirectory, 'operation.lock')), false);
});

test('renderer preparation freezes its own artifact and has no collection constructor arguments', async t => {
  const f = fixture(t);
  await main(['prepare', '--contract', 'DMXWebpRenderer', '--directory', f.directory]);
  const manifest = f.read('manifest.json');
  assert.equal(manifest.contractName, 'DMXWebpRenderer');
  assert.equal(manifest.expectedCollectionImage, collectionMetadata.image);
  assert.equal(manifest.constructorArgs, '0x');
  assert.equal(manifest.creationCode, f.renderer.artifact.bytecode.object);
  assert.equal(Object.hasOwn(manifest, 'renderer'), false);
  assert.deepEqual(f.read('DMXWebpRenderer.artifact.json'), f.renderer.artifact);
  assert.equal(f.requests.some(request => request.method === 'eth_sendRawTransaction'), false);
});

test('collection preparation requires a confirmed renderer release instead of a blind address', async t => {
  const f = fixture(t);
  await assert.rejects(main(['prepare', '--directory', f.directory, '--quote-signer', quoteSigner]), /verified renderer release/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  const reportPath = path.join(f.rendererDirectory, 'deployment.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  fs.writeFileSync(reportPath, json({ ...report, confirmations: 2 }));
  await assert.rejects(f.prepare(), /three confirmations/);
  assert.equal(f.requests.length, 0);
});

test('collection preparation freezes and independently checks renderer evidence', async t => {
  const f = fixture(t);
  await f.prepare();
  const manifest = f.read('manifest.json');
  assert.equal(manifest.renderer, rendererAddress);
  const frozen = readRendererRelease(path.join(f.directory, 'renderer'));
  assert.equal(manifest.rendererReleaseSha256, sha256(json(frozen.files)));
  assert.equal(frozen.manifest.contractAddress, rendererAddress);
  assert.ok(f.requests.some(request => request.method === 'eth_getCode' && request.params[0] === rendererAddress));
  const artifactPath = path.join(f.directory, 'renderer/DMXWebpRenderer.artifact.json');
  fs.writeFileSync(artifactPath, json({ ...frozen.artifact, bytecode: { object: '0x00' } }));
  await assert.rejects(main(['sign', '--directory', f.directory]), /Frozen renderer artifact changed|strictly equal/);
});

test('changed renderer runtime prevents collection preparation', async t => {
  const f = fixture(t, { eth_getCode: '0x00' });
  await assert.rejects(f.prepare(), /Renderer runtime mismatch/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('noncanonical renderer deployment prevents collection preparation', async t => {
  const f = fixture(t, { eth_getBlockByNumber: { number: '0x3', hash: '0x' + 'c'.repeat(64) } });
  await assert.rejects(f.prepare(), /no longer canonical/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('legacy release directories cannot be silently repurposed', () => {
  assert.throws(() => validateDeploymentConfiguration({ ...configuration(), releaseVersion: undefined }), /Legacy release is frozen/);
});

test('renderer metadata validation decodes JSON and checks collection identity', () => {
  assert.deepEqual(validateCollectionMetadata(collectionURI), collectionMetadata);
  assert.throws(() => validateCollectionMetadata(historicalURI));
  assert.throws(() => validateCollectionMetadata('https://cdn.mons.shop/tarot-sepolia/v1/collection.json'), /inline JSON/);
  for (const change of [{ name: 'Tarot Cards' }, { symbol: 'TAROT' }, { image: 'https://example.com/art.webp' }]) {
    const uri = 'data:application/json;base64,' + Buffer.from(JSON.stringify({ ...collectionMetadata, ...change })).toString('base64');
    assert.throws(() => validateCollectionMetadata(uri));
  }
  assert.match(rendererInterfaceId(), /^0x[0-9a-f]{8}$/);
});

function useHistoricalRenderer(f) {
  delete f.renderer.manifest.expectedCollectionImage;
  delete f.renderer.deployment.expectedCollectionImage;
  f.renderer.deployment.collectionMetadata = historicalMetadata;
  fs.writeFileSync(path.join(f.rendererDirectory, 'manifest.json'), json(f.renderer.manifest));
  fs.writeFileSync(path.join(f.rendererDirectory, 'deployment.json'), json(f.renderer.deployment));
}

test('historical renderer verification uses original deployment image evidence without changing frozen files', async t => {
  const f = fixture(t);
  useHistoricalRenderer(f);
  const before = fs.readdirSync(f.rendererDirectory).map(name => [name, fs.readFileSync(path.join(f.rendererDirectory, name), 'utf8')]);
  await verifyRendererRelease(readRendererRelease(f.rendererDirectory), async (method, params) => {
    const response = await fetch('https://tarot-rpc.invalid', { body: JSON.stringify({ method, params }) });
    return (await response.json()).result;
  });
  assert.deepEqual(fs.readdirSync(f.rendererDirectory).map(name => [name, fs.readFileSync(path.join(f.rendererDirectory, name), 'utf8')]), before);
  assert.equal(f.requests.some(request => request.method === 'eth_sendRawTransaction'), false);
});

test('new collection preparation rejects a historically valid renderer with old media', async t => {
  const f = fixture(t);
  useHistoricalRenderer(f);
  await assert.rejects(f.prepare(), /current DMX renderer media/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('historical renderer metadata fallback requires matching original deployment evidence', t => {
  const f = fixture(t);
  useHistoricalRenderer(f);
  const reportPath = path.join(f.rendererDirectory, 'deployment.json');
  for (const change of [{ collectionMetadata: undefined }, { standardInputSha256: 'changed' }, { contractAddress: quoteSigner }]) {
    fs.writeFileSync(reportPath, json({ ...f.renderer.deployment, ...change }));
    assert.throws(() => readRendererRelease(f.rendererDirectory), /collection image evidence|differs from manifest/);
  }
});

test('current renderer release cannot substitute historical media evidence', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.rendererDirectory, 'deployment.json'), json({ ...f.renderer.deployment, collectionMetadata: historicalMetadata }));
  assert.throws(() => readRendererRelease(f.rendererDirectory), /collection image differs from manifest/);
});


function stateRpc(manifest, changes = {}) {
  const encode = (type, ...args) => execFileSync('cast', ['abi-encode', 'value(' + type + ')', ...args.map(String)], { encoding: 'utf8' }).trim();
  const values = [
    ['owner()', 'address', manifest.admin], ['quoteSigner()', 'address', manifest.quoteSigner],
    ['renderer()', 'address', manifest.renderer], ['INITIAL_CARDS()', 'uint256', 777], ['MAX_CARDS()', 'uint256', 999999],
    ['RECEIPT_OFFSET()', 'uint256', 999999], ['REDEMPTION_RECEIPT_OFFSET()', 'uint256', 1000776],
    ['MAX_TOKEN_ID()', 'uint256', 2000775], ['MAX_AUTHORIZATION_LIFETIME()', 'uint256', 600],
    ['redemptionsPaused()', 'bool', true], ['mintingPaused()', 'bool', false],
    ['name()', 'string', 'divination machina x'], ['symbol()', 'string', 'DMX'],
    ['contractURI()', 'string', collectionURI], ['supportsInterface(bytes4)', 'bool', true, '0x49064906'],
    ['receiptTokenId(uint256)', 'uint256', 1000000, '1'], ['receiptTokenId(uint256)', 'uint256', 1000776, '777'],
    ['redemptionReceiptTokenId(uint256)', 'uint256', 1000777, '1'], ['redemptionReceiptTokenId(uint256)', 'uint256', 2000775, '999999'],
  ];
  const responses = new Map(values.map(([signature, type, value, ...args]) => [
    execFileSync('cast', ['calldata', signature, ...args], { encoding: 'utf8' }).trim(), encode(type, changes[signature] ?? value),
  ]));
  responses.set(execFileSync('cast', ['calldata', 'eip712Domain()'], { encoding: 'utf8' }).trim(),
    encode('bytes1,string,string,uint256,address,bytes32,uint256[]', '0x0f', changes.domainName ?? 'divination machina x',
      '1', manifest.chainId, manifest.contractAddress, '0x' + '0'.repeat(64), '[]'));
  return async (method, params) => {
    assert.equal(method, 'eth_call');
    assert.equal(params[0].to, manifest.contractAddress);
    assert.equal(params[1], '0x5');
    assert.ok(responses.has(params[0].data), 'Unexpected contract read');
    return responses.get(params[0].data);
  };
}

test('collection verification checks new ranges, renderer, paused redemption, EIP-712 domain and decoded metadata', async () => {
  const manifest = { ...configuration(), contractAddress: '0x3333333333333333333333333333333333333333' };
  assert.deepEqual(await verifyDeploymentState(manifest, stateRpc(manifest), '0x5'), collectionMetadata);
  for (const change of [{ 'MAX_CARDS()': 777 }, { 'RECEIPT_OFFSET()': 777 }, { 'renderer()': quoteSigner },
    { 'redemptionsPaused()': false }, { 'mintingPaused()': true }, { domainName: 'Tarot Cards' }, { 'symbol()': 'TAROT' }]) {
    await assert.rejects(verifyDeploymentState(manifest, stateRpc(manifest, change), '0x5'));
  }
});

test('historical collection verification pins the image recorded by its original deployment', async () => {
  const manifest = { ...configuration(), contractAddress: '0x3333333333333333333333333333333333333333',
    artifactSha256: 'a'.repeat(64), standardInputSha256: 'b'.repeat(64) };
  delete manifest.expectedCollectionImage;
  const deployment = { ...manifest, collectionMetadata: historicalMetadata };
  assert.deepEqual(await verifyDeploymentState(manifest, stateRpc(manifest, { 'contractURI()': historicalURI }), '0x5', deployment), historicalMetadata);
  await assert.rejects(verifyDeploymentState(manifest, stateRpc(manifest), '0x5', deployment));
  await assert.rejects(verifyDeploymentState(manifest, stateRpc(manifest), '0x5'), /original deployment metadata evidence/);
  await assert.rejects(verifyDeploymentState(manifest, stateRpc(manifest), '0x5', { ...deployment, artifactSha256: 'changed' }),
    /differs from manifest: artifactSha256/);
});
