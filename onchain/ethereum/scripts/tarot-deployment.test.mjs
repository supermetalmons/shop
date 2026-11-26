import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  deploymentConfiguration, deploymentConstructorArgs, deploymentGas, main, TAROT_SEPOLIA,
  validateDeploymentConfiguration, validateSignedDeployment, readRendererRelease, rendererInterfaceId, validateCollectionMetadata,
  verifyDeploymentState, verifyRendererRelease, readCollectionRelease, resolveCollectionMetadata,
  OFFCHAIN_COLLECTION_URI, metadataPins, validateMetadataPublication, verifyRendererPublication,
} from './tarot-deployment.mjs';
import { generateDmxMetadata, loadDmxMetadataManifest, dmxMetadataManifestSha256 } from '../../../scripts/tarot/metadata.ts';

const quoteSigner = '0x2222222222222222222222222222222222222222';
const rendererAddress = '0x4444444444444444444444444444444444444444';
const mainnetRoles = { deployer: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  admin: '0x3333333333333333333333333333333333333333', feeCeilingWei: '5000000000000000' };
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const configuration = () => ({ network: 'sepolia', ...deploymentConfiguration('sepolia', quoteSigner, rendererAddress),
  expectedCollectionImage: collectionMetadata.image });
const collectionMetadata = { name: 'divination machina x', symbol: 'DMX', description: '777 Tarot cards and their paired NFC receipts.',
  image: 'https://cdn.lil.org/nft/dmx/cards/1.png', external_link: 'https://mons.shop' };
const collectionURI = 'data:application/json;base64,' + Buffer.from(JSON.stringify(collectionMetadata)).toString('base64');
const historicalMetadata = { ...collectionMetadata, image: 'https://wip.lil.org/tarot/bases/1.webp' };
const historicalURI = 'data:application/json;base64,' + Buffer.from(JSON.stringify(historicalMetadata)).toString('base64');
const pinnedHistoricalMetadata = { ...collectionMetadata, image: 'https://wip.lil.org/dmx/cards/1.webp' };
const pinnedHistoricalURI = 'data:application/json;base64,' + Buffer.from(JSON.stringify(pinnedHistoricalMetadata)).toString('base64');
const project = fileURLToPath(new URL('../', import.meta.url));
const originalReadFileSync = fs.readFileSync;
let build;
let artifacts;

before(async () => {
  build = fs.mkdtempSync(path.join(os.tmpdir(), 'tarot-build-test-'));
  const contracts = ['TarotCards', 'DMXWebpRenderer', 'DMXOffchainRenderer'];
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

async function metadataFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-publication-test-')));
  const directory = path.join(root, '.cache/dmx-metadata/test');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await generateDmxMetadata(directory, { root });
  const publication = await loadDmxMetadataManifest(directory);
  const pins = { expectedCollectionUri: OFFCHAIN_COLLECTION_URI,
    collectionMetadataSha256: publication.objects.find(object => object.file === 'collection.json').sha256,
    metadataManifestSha256: dmxMetadataManifestSha256(publication) };
  const verification = { version: 1, baseURI: publication.baseURI, manifestSha256: pins.metadataManifestSha256,
    objectsSha256: publication.objectsSha256, objectCount: publication.objectCount,
    complete: true, publicVerified: true, storageVerified: true, checkedAt: '2026-11-26T11:00:00.000Z' };
  fs.writeFileSync(path.join(directory, 'verification.json'), json(verification));
  return { directory, publication, pins, verification };
}

function publicMetadataFixture(t, metadata) {
  const previousFetch = globalThis.fetch;
  const state = { unavailable: null, reads: new Set() };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).startsWith(metadata.publication.baseURI)) return previousFetch(url, options);
    const file = String(url).slice(metadata.publication.baseURI.length);
    state.reads.add(file);
    return new Response(file === state.unavailable ? 'missing' : fs.readFileSync(path.join(metadata.directory, file)),
      { status: file === state.unavailable ? 404 : 200, headers: { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
  });
  return state;
}

test('offchain collection metadata requires the pinned URL, exact body hash and JSON response', async t => {
  const f = await metadataFixture(t);
  const bytes = Buffer.from(json(collectionMetadata));
  const manifest = { contractName: 'DMXOffchainRenderer', ...f.pins, collectionMetadataSha256: sha256(bytes) };
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return new Response(bytes, { headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
  assert.deepEqual(await resolveCollectionMetadata(OFFCHAIN_COLLECTION_URI, manifest, collectionMetadata.image, fetcher), collectionMetadata);
  assert.equal(requests[0].url, OFFCHAIN_COLLECTION_URI);
  assert.equal(requests[0].options.redirect, 'error');
  for (const uri of ['https://cdn.mons.shop/dmx/other.json', collectionURI]) {
    await assert.rejects(resolveCollectionMetadata(uri, manifest, collectionMetadata.image, fetcher), /URI differs/);
  }
  await assert.rejects(resolveCollectionMetadata(OFFCHAIN_COLLECTION_URI,
    { ...manifest, collectionMetadataSha256: '0'.repeat(64) }, collectionMetadata.image, fetcher), /content hash differs/);
  for (const [status, contentType, message] of [[404, 'application/json', /HTTP failure/],
    [302, 'application/json', /HTTP failure/], [200, 'text/html', /content type/]]) {
    await assert.rejects(resolveCollectionMetadata(OFFCHAIN_COLLECTION_URI, manifest, collectionMetadata.image,
      async () => new Response(bytes, { status, headers: { 'content-type': contentType } })), message);
  }
  await assert.rejects(resolveCollectionMetadata(OFFCHAIN_COLLECTION_URI, manifest, collectionMetadata.image,
    async () => ({ status: 200, redirected: true })), /redirect/);
  assert.throws(() => metadataPins({ contractName: 'DMXOffchainRenderer' }), /metadata URI/);
});

test('offchain publication evidence binds all objects and the collection document', async t => {
  const f = await metadataFixture(t);
  validateMetadataPublication(f.publication, f.verification, f.pins);
  for (const change of [{ complete: false }, { publicVerified: false }, { objectCount: 1554 },
    { manifestSha256: 'a'.repeat(64) }, { objectsSha256: 'a'.repeat(64) }, { baseURI: 'https://cdn.example/' }]) {
    assert.throws(() => validateMetadataPublication(f.publication, { ...f.verification, ...change }, f.pins));
  }
  assert.throws(() => validateMetadataPublication(f.publication, f.verification,
    { ...f.pins, collectionMetadataSha256: 'b'.repeat(64) }), /Collection metadata hash/);
  await assert.rejects(verifyRendererPublication({ manifest: { contractName: 'DMXOffchainRenderer', ...f.pins },
    publicationManifest: f.publication, publicationVerification: f.verification },
  { fetch: async () => new Response('missing', { status: 404 }) }));
});

test('DMX configuration pins Sepolia, the approved admin and verified renderer', () => {
  const config = deploymentConfiguration('sepolia', quoteSigner.toUpperCase().replace('0X', '0x'), rendererAddress);
  assert.equal(config.chainId, 11155111);
  assert.equal(config.admin, TAROT_SEPOLIA.deployer);
  assert.equal(config.renderer, rendererAddress);
  assert.equal(config.releaseVersion, 2);
  assert.equal(config.quoteSigner, quoteSigner);
  for (const network of ['devnet', 'local', 'other']) {
    assert.throws(() => deploymentConfiguration(network, quoteSigner), /Sepolia or Ethereum mainnet only/);
  }
  for (const signer of [undefined, '', 'wrong', '0x' + '0'.repeat(40)]) {
    assert.throws(() => deploymentConfiguration('sepolia', signer), /quote-signer/);
  }
  assert.throws(() => deploymentConfiguration('sepolia', TAROT_SEPOLIA.deployer), /dedicated/);
});

test('mainnet requires explicit roles and fee ceiling with a dedicated signer', () => {
  const config = deploymentConfiguration('mainnet', quoteSigner, rendererAddress, 'TarotCards', mainnetRoles);
  assert.equal(config.chainId, 1);
  for (const key of ['deployer', 'admin', 'feeCeilingWei']) assert.equal(config[key], mainnetRoles[key]);
  for (const [key, values] of Object.entries({ deployer: [undefined, 'bad', '0x' + '0'.repeat(40)],
    admin: [undefined, 'bad', '0x' + '0'.repeat(40)], feeCeilingWei: [undefined, 1000, '0', '-1', '1.5', '01', (2n ** 256n).toString()] })) {
    for (const value of values) {
      assert.throws(() => deploymentConfiguration('mainnet', quoteSigner, rendererAddress, 'TarotCards', { ...mainnetRoles, [key]: value }));
    }
  }
  for (const signer of [mainnetRoles.deployer, mainnetRoles.admin]) {
    assert.throws(() => deploymentConfiguration('mainnet', signer, rendererAddress, 'TarotCards', mainnetRoles), /dedicated/);
  }
  assert.throws(() => deploymentConfiguration('sepolia', quoteSigner, rendererAddress, 'TarotCards', mainnetRoles), /only to mainnet/);
  const manifest = { network: 'mainnet', ...config };
  assert.deepEqual(validateDeploymentConfiguration(manifest, 'mainnet'), config);
  for (const change of [{ chainId: 11155111 }, { network: 'sepolia' }, { feeCeilingWei: undefined }, { releaseVersion: 1 }]) {
    assert.throws(() => validateDeploymentConfiguration({ ...manifest, ...change }, 'mainnet'));
  }
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

test('mainnet signed deployment binds approved roles, chain and fee ceiling', () => {
  const manifest = { network: 'mainnet', ...deploymentConfiguration('mainnet', quoteSigner, rendererAddress, 'TarotCards', mainnetRoles),
    nonce: '2', gasPrice: '1000', gasLimit: '2000000', maximumFeeWei: '2000000000', creationCode: '0x60006000f3' };
  const transaction = { signer: manifest.deployer, type: '0x0', chainId: '0x1', nonce: '0x2',
    gasPrice: '0x3e8', gas: '0x1e8480', to: null, value: '0x0', input: manifest.creationCode, hash: '0x1234' };
  validateSignedDeployment(transaction, manifest, transaction.hash);
  for (const change of [{ chainId: '0xaa36a7' }, { signer: TAROT_SEPOLIA.deployer }, { value: '0x1' }, { input: '0x' }]) {
    assert.throws(() => validateSignedDeployment({ ...transaction, ...change }, manifest, transaction.hash));
  }
  assert.throws(() => validateSignedDeployment(transaction, { ...manifest, feeCeilingWei: '1999999999' }, transaction.hash), /fee ceiling/);
  assert.throws(() => validateSignedDeployment(transaction, { ...manifest, maximumFeeWei: '2000000001' }, transaction.hash), /maximum deployment fee/);
});

function rendererFixture(directory, network = 'sepolia', metadata) {
  const contractName = metadata ? 'DMXOffchainRenderer' : 'DMXWebpRenderer';
  const artifact = artifacts[contractName];
  const sources = Object.fromEntries(Object.keys(artifact.metadata.sources).map(name => [name, { content: fs.readFileSync(path.join(project, name), 'utf8') }]));
  const { compilationTarget, ...settings } = artifact.metadata.settings;
  const input = { language: 'Solidity', sources, settings };
  const manifest = { network, ...deploymentConfiguration(network, undefined, undefined, contractName, network === 'mainnet' ? mainnetRoles : {}),
    ...metadata?.pins,
    expectedCollectionImage: collectionMetadata.image,
    contractAddress: rendererAddress, constructorArgs: '0x', creationCode: artifact.bytecode.object,
    artifactSha256: sha256(json(artifact)), standardInputSha256: sha256(json(input)),
    deploymentBlockHash: '0x' + 'a'.repeat(64) };
  const deployment = { ...manifest, deploymentBlock: 1, transactionHash: '0x' + 'b'.repeat(64), confirmations: 3,
    collectionMetadata };
  for (const [name, value] of Object.entries({ 'manifest.json': manifest, 'deployment.json': deployment,
    [contractName + '.artifact.json']: artifact, [contractName + '.standard-input.json']: input,
    ...(metadata ? { 'publication-manifest.json': metadata.publication, 'publication-verification.json': metadata.verification } : {}) })) {
    fs.writeFileSync(path.join(directory, name), json(value));
  }
  return { manifest, deployment, artifact, input };
}

function fixture(t, overrides = {}, network = 'sepolia', metadata) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tarot-deployment-test-'));
  const rendererDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-renderer-test-'));
  const renderer = rendererFixture(rendererDirectory, network, metadata);
  const rpcKey = network === 'mainnet' ? 'ETHEREUM_TAROT_MAINNET_RPC_URL' : 'ETHEREUM_TAROT_RPC_URL';
  const previous = process.env[rpcKey];
  process.env[rpcKey] = 'https://tarot-rpc.invalid';
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
    const chainId = network === 'mainnet' ? '0x1' : '0xaa36a7';
    const results = { eth_chainId: chainId, eth_getTransactionCount: '0x0',
      eth_getCode: request.params[0] === rendererAddress ? renderer.artifact.deployedBytecode.object : '0x',
      eth_getTransactionReceipt: { status: '0x1', contractAddress: rendererAddress, blockNumber: '0x1',
        blockHash: renderer.manifest.deploymentBlockHash, from: renderer.manifest.deployer, to: null },
      eth_getBlockByNumber: { number: '0x3', hash: renderer.manifest.deploymentBlockHash },
      eth_getTransactionByHash: { input: renderer.artifact.bytecode.object, from: renderer.manifest.deployer, to: null,
        chainId, value: '0x0' },
      eth_call: request.params[0]?.data?.startsWith('0x01ffc9a7') ? '0x' + '0'.repeat(63) + '1' : execFileSync('cast',
        ['abi-encode', 'value(string)', metadata ? OFFCHAIN_COLLECTION_URI : 'data:application/json;base64,' +
          Buffer.from(JSON.stringify(renderer.deployment.collectionMetadata)).toString('base64')], { encoding: 'utf8' }).trim(),
      eth_estimateGas: '0x1e8480', eth_gasPrice: '0x5f5e100', eth_getBalance: '0x11c37937e08000', ...overrides };
    assert.ok(Object.hasOwn(results, request.method), 'Unexpected RPC operation ' + request.method);
    return Response.json({ jsonrpc: '2.0', id: 1, result: results[request.method] });
  });
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(rendererDirectory, { recursive: true, force: true });
    if (previous === undefined) delete process.env[rpcKey];
    else process.env[rpcKey] = previous;
  });
  return { directory, rendererDirectory, renderer, logs, requests,
    read: name => JSON.parse(read(path.join(directory, name), 'utf8')),
    prepare: () => main(['prepare', '--directory', directory, '--quote-signer', quoteSigner, '--renderer-directory', rendererDirectory,
      ...(network === 'mainnet' ? ['--network', 'mainnet', '--deployer', mainnetRoles.deployer, '--admin', mainnetRoles.admin,
        '--maximum-fee-wei', mainnetRoles.feeCeilingWei] : [])]),
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

test('mainnet preparation freezes explicit roles, chain, renderer and fee ceiling', async t => {
  const f = fixture(t, {}, 'mainnet');
  await f.prepare();
  const manifest = f.read('manifest.json');
  assert.equal(manifest.chainId, 1);
  assert.equal(manifest.network, 'mainnet');
  assert.equal(manifest.deployer, mainnetRoles.deployer);
  assert.equal(manifest.admin, mainnetRoles.admin);
  assert.equal(manifest.quoteSigner, quoteSigner);
  assert.equal(manifest.feeCeilingWei, mainnetRoles.feeCeilingWei);
  assert.equal(BigInt(manifest.maximumFeeWei), BigInt(manifest.gasLimit) * BigInt(manifest.gasPrice));
  assert.ok(BigInt(manifest.maximumFeeWei) <= BigInt(manifest.feeCeilingWei));
  assert.equal(readRendererRelease(path.join(f.directory, 'renderer'), 'mainnet').manifest.chainId, 1);
  assert.equal(f.requests.some(request => request.method === 'eth_sendRawTransaction'), false);
  for (const command of ['sign', 'broadcast', 'verify']) {
    await assert.rejects(main([command, '--directory', f.directory]), /Unexpected deployment chainId|only to mainnet|network/);
    for (const [flag, value] of [['--deployer', mainnetRoles.deployer], ['--admin', mainnetRoles.admin], ['--maximum-fee-wei', '1']]) {
      await assert.rejects(main([command, '--network', 'mainnet', '--directory', f.directory, flag, value]), /only allowed for prepare/);
    }
  }
});

test('mainnet preparation refuses Sepolia renderer evidence and the wrong RPC chain', async t => {
  const f = fixture(t, { eth_chainId: '0xaa36a7' }, 'mainnet');
  await assert.rejects(f.prepare(), /selected deployment network/);
  assert.deepEqual(f.requests.map(request => request.method), ['eth_chainId']);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  fs.writeFileSync(path.join(f.rendererDirectory, 'manifest.json'), json({ ...f.renderer.manifest, chainId: 11155111, network: 'sepolia' }));
  await assert.rejects(f.prepare(), /Unexpected deployment chainId/);
  assert.equal(f.requests.length, 1);
});

test('mainnet renderer preparation uses its own explicit release and mainnet RPC', async t => {
  const f = fixture(t, {}, 'mainnet');
  await main(['prepare', '--network', 'mainnet', '--contract', 'DMXWebpRenderer', '--directory', f.directory,
    '--deployer', mainnetRoles.deployer, '--admin', mainnetRoles.admin, '--maximum-fee-wei', mainnetRoles.feeCeilingWei]);
  const manifest = f.read('manifest.json');
  assert.equal(manifest.chainId, 1);
  assert.equal(manifest.constructorArgs, '0x');
  assert.equal(manifest.creationCode, artifacts.DMXWebpRenderer.bytecode.object);
  assert.equal(manifest.quoteSigner, undefined);
  assert.equal(f.requests.some(request => request.method === 'eth_sendRawTransaction'), false);
});

for (const network of ['sepolia', 'mainnet']) {
  test(`${network} offchain renderer preparation freezes published metadata and its exact URI`, async t => {
    const f = fixture(t, {}, network);
    const m = await metadataFixture(t);
    const cdn = publicMetadataFixture(t, m);
    const args = ['prepare', '--network', network, '--contract', 'DMXOffchainRenderer', '--directory', f.directory,
      '--metadata-directory', m.directory, ...(network === 'mainnet'
        ? ['--deployer', mainnetRoles.deployer, '--admin', mainnetRoles.admin, '--maximum-fee-wei', mainnetRoles.feeCeilingWei] : [])];
    await main(args);
    assert.equal(cdn.reads.size, 1555);
    const manifest = f.read('manifest.json');
    assert.equal(manifest.contractName, 'DMXOffchainRenderer');
    assert.equal(manifest.constructorArgs, '0x');
    assert.deepEqual(metadataPins(manifest), m.pins);
    assert.equal(manifest.creationCode, artifacts.DMXOffchainRenderer.bytecode.object);
    assert.deepEqual(f.read('publication-manifest.json'), m.publication);
    assert.deepEqual(f.read('publication-verification.json'), m.verification);
    assert.equal(f.requests.some(request => request.method === 'eth_sendRawTransaction'), false);
    const deployment = { ...manifest, deploymentBlock: 1, deploymentBlockHash: '0x' + 'a'.repeat(64),
      transactionHash: '0x' + 'b'.repeat(64), confirmations: 3, collectionMetadata };
    fs.writeFileSync(path.join(f.directory, 'deployment.json'), json(deployment));
    const release = readRendererRelease(f.directory, network);
    assert.deepEqual(release.publicationManifest, m.publication);
    fs.writeFileSync(path.join(f.directory, 'publication-verification.json'), json({ ...m.verification, storageVerified: false }));
    assert.throws(() => readRendererRelease(f.directory, network), /storage verification/);
  });
}

for (const contractName of ['DMXOffchainRenderer', 'TarotCards']) {
  test(`${contractName} deployment rejects stale token verification during preparation and later stages`, async t => {
    const metadata = await metadataFixture(t);
    const f = fixture(t, {}, 'mainnet', metadata);
    const cdn = publicMetadataFixture(t, metadata);
    const prepare = contractName === 'TarotCards' ? f.prepare : () => main(['prepare', '--network', 'mainnet',
      '--contract', contractName, '--directory', f.directory, '--metadata-directory', metadata.directory,
      '--deployer', mainnetRoles.deployer, '--admin', mainnetRoles.admin, '--maximum-fee-wei', mainnetRoles.feeCeilingWei]);
    cdn.unavailable = '1.json';
    await assert.rejects(prepare(), /DMX public metadata headers failed/);
    assert.equal(fs.existsSync(path.join(f.directory, 'manifest.json')), false);
    cdn.unavailable = null;
    await prepare();
    assert.equal(cdn.reads.size, 1555);
    const frozen = fs.readFileSync(path.join(f.directory, 'manifest.json'), 'utf8');
    cdn.unavailable = '1000000.json';
    for (const command of ['sign', 'broadcast', 'verify']) {
      await assert.rejects(main([command, '--network', 'mainnet', '--directory', f.directory]), /DMX public metadata headers failed/);
    }
    assert.equal(fs.readFileSync(path.join(f.directory, 'manifest.json'), 'utf8'), frozen);
    assert.equal(f.requests.some(request => request.method === 'eth_sendRawTransaction'), false);
  });
}

test('offchain preparation refuses unpublished metadata before RPC or a frozen manifest', async t => {
  const f = fixture(t);
  const m = await metadataFixture(t);
  fs.writeFileSync(path.join(m.directory, 'verification.json'), json({ ...m.verification, storageVerified: false }));
  await assert.rejects(main(['prepare', '--contract', 'DMXOffchainRenderer', '--directory', f.directory,
    '--metadata-directory', m.directory]), /storage verification/);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(path.join(f.directory, 'manifest.json')), false);
  await assert.rejects(main(['prepare', '--contract', 'DMXOffchainRenderer', '--directory', f.directory]), /metadata-directory/);
});

test('mainnet collection reader rejects altered roles, constructor and frozen renderer evidence', async t => {
  const f = fixture(t, {}, 'mainnet');
  await f.prepare();
  const manifest = f.read('manifest.json');
  const deployment = { ...manifest, deploymentBlock: 5, deploymentBlockHash: '0x' + 'c'.repeat(64),
    transactionHash: '0x' + 'd'.repeat(64), confirmations: 3, collectionMetadata };
  fs.writeFileSync(path.join(f.directory, 'deployment.json'), json(deployment));
  const release = readCollectionRelease(f.directory, 'mainnet');
  assert.equal(release.manifest.admin, mainnetRoles.admin);
  assert.equal(release.rendererRelease.manifest.chainId, 1);
  const cases = [
    ['deployment.json', { ...deployment, admin: quoteSigner }, /differs from manifest/],
    ['deployment.json', { ...deployment, confirmations: 2 }, /three confirmations/],
    ['manifest.json', { ...manifest, admin: rendererAddress }, /Constructor configuration changed/],
    ['manifest.json', { ...manifest, constructorArgs: '0x' }, /Constructor configuration changed/],
    ['manifest.json', { ...manifest, contractAddress: rendererAddress }, /Predicted CREATE address/],
    ['manifest.json', { ...manifest, rendererReleaseSha256: 'changed' }, /Frozen renderer release changed/],
    ['TarotCards.standard-input.json', { ...release.input, sources: {} }, /Frozen .* sources changed/],
    ['renderer/deployment.json', { ...release.rendererRelease.deployment, deployer: quoteSigner }, /differs from manifest/],
  ];
  for (const [name, value, error] of cases) {
    const filename = path.join(f.directory, name);
    const original = fs.readFileSync(filename, 'utf8');
    fs.writeFileSync(filename, json(value));
    assert.throws(() => readCollectionRelease(f.directory, 'mainnet'), error);
    fs.writeFileSync(filename, original);
  }
});

test('mainnet journal lifecycle signs offline, resumes one broadcast and verifies exact deployment', async t => {
  const f = fixture(t, {}, 'mainnet');
  await f.prepare();
  const manifest = f.read('manifest.json');
  const chainState = stateRpc(manifest);
  const blockHash = '0x' + 'c'.repeat(64);
  const rpc = globalThis.fetch;
  let chainId = '0x1';
  let broadcasted = false;
  let sends = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = JSON.parse(options.body);
    const { method, params } = request;
    const respond = result => Response.json({ jsonrpc: '2.0', id: 1, result });
    if (method === 'eth_chainId') return respond(chainId);
    if (method === 'eth_getBlockByNumber' && params[0] !== '0x1') {
      return respond({ number: params[0] === '0x5' ? '0x5' : '0x7', hash: blockHash, baseFeePerGas: '0x1' });
    }
    if (method === 'eth_getTransactionByHash' && params[0] !== f.renderer.deployment.transactionHash) {
      return respond(broadcasted ? { input: manifest.creationCode, from: manifest.deployer, to: null,
        value: '0x0', nonce: '0x0', chainId: '0x1' } : null);
    }
    if (method === 'eth_sendRawTransaction') {
      const journal = f.read('transactions.private.json');
      assert.equal(journal.raw, params[0]);
      assert.ok(journal.broadcastAttemptedAt);
      sends += 1;
      broadcasted = true;
      return respond(journal.transactionHash);
    }
    if (method === 'eth_getTransactionReceipt' && params[0] !== f.renderer.deployment.transactionHash) {
      return respond({ status: '0x1', contractAddress: manifest.contractAddress, from: manifest.deployer, to: null,
        blockNumber: '0x5', blockHash });
    }
    if (method === 'eth_getCode' && params[0] === manifest.contractAddress) return respond(artifacts.TarotCards.deployedBytecode.object);
    if (method === 'eth_getBalance' && params[0] === manifest.contractAddress) return respond('0x0');
    if (method === 'eth_call' && params[0].to === manifest.contractAddress) return respond(await chainState(method, params));
    return rpc(url, options);
  });
  const execute = childProcess.execFileSync;
  let walletAddress = mainnetRoles.deployer;
  const castMock = t.mock.method(childProcess, 'execFileSync', (program, args, options) => {
    if (program === 'cast' && args[0] === 'wallet' && args[1] === 'address') return walletAddress + '\n';
    if (program === 'cast' && args[0] === 'mktx') {
      assert.equal(args[args.indexOf('--chain') + 1], '1');
      const offlineArgs = args.filter((value, index) => !['--keystore', '--password-file'].includes(value)
        && !['--keystore', '--password-file'].includes(args[index - 1]));
      offlineArgs.splice(offlineArgs.indexOf('--create'), 0, '--private-key',
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
      return execute(program, offlineArgs, options);
    }
    return execute(program, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { castMock.mock.restore(); syncBuiltinESMExports(); });
  const invoke = command => main([command, '--network', 'mainnet', '--directory', f.directory,
    ...(command === 'sign' ? ['--keystore', 'offline-test-wallet', '--password-file', 'offline-test-password'] : [])]);
  chainId = '0xaa36a7';
  await assert.rejects(invoke('sign'), /selected deployment network/);
  assert.equal(fs.existsSync(path.join(f.directory, 'transactions.private.json')), false);
  chainId = '0x1';
  walletAddress = quoteSigner;
  await assert.rejects(invoke('sign'), /Wrong deployer keystore/);
  walletAddress = mainnetRoles.deployer;
  await invoke('sign');
  const originalJournal = f.read('transactions.private.json');
  assert.equal(originalJournal.manifestSha256, sha256(json(manifest)));
  assert.equal(fs.statSync(path.join(f.directory, 'transactions.private.json')).mode & 0o777, 0o600);
  await assert.rejects(invoke('sign'), /already journaled/);
  fs.writeFileSync(path.join(f.directory, 'manifest.json'), json({ ...manifest, feeCeilingWei: '6000000000000000' }));
  await assert.rejects(invoke('broadcast'), /Manifest changed after signing/);
  fs.writeFileSync(path.join(f.directory, 'manifest.json'), json(manifest));
  fs.writeFileSync(path.join(f.directory, 'transactions.private.json'), json({ ...originalJournal, raw: '0x00' }));
  await assert.rejects(invoke('broadcast'), /Journaled transaction changed/);
  fs.writeFileSync(path.join(f.directory, 'transactions.private.json'), json(originalJournal));
  chainId = '0xaa36a7';
  await assert.rejects(invoke('broadcast'), /selected deployment network/);
  assert.equal(sends, 0);
  chainId = '0x1';
  await invoke('broadcast');
  await invoke('broadcast');
  assert.equal(sends, 1);
  chainId = '0xaa36a7';
  await assert.rejects(invoke('verify'), /selected deployment network/);
  assert.equal(fs.existsSync(path.join(f.directory, 'deployment.json')), false);
  chainId = '0x1';
  await invoke('verify');
  const release = readCollectionRelease(f.directory, 'mainnet');
  assert.equal(release.deployment.transactionHash, originalJournal.transactionHash);
  assert.equal(release.deployment.chainId, 1);
  assert.equal(release.deployment.admin, mainnetRoles.admin);
  assert.equal(release.deployment.quoteSigner, quoteSigner);
  assert.equal(f.read('transactions.private.json').raw, originalJournal.raw);
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

test('mainnet without approved roles and unsafe credential arguments fail before any RPC operation', async t => {
  const f = fixture(t);
  await assert.rejects(main(['prepare', '--network', 'mainnet', '--directory', f.directory, '--quote-signer', quoteSigner]), /--deployer/);
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

function useHistoricalRenderer(f, pinned = false) {
  if (pinned) {
    f.renderer.manifest.expectedCollectionImage = pinnedHistoricalMetadata.image;
    f.renderer.deployment.expectedCollectionImage = pinnedHistoricalMetadata.image;
  } else {
    delete f.renderer.manifest.expectedCollectionImage;
    delete f.renderer.deployment.expectedCollectionImage;
  }
  f.renderer.deployment.collectionMetadata = pinned ? pinnedHistoricalMetadata : historicalMetadata;
  fs.writeFileSync(path.join(f.rendererDirectory, 'manifest.json'), json(f.renderer.manifest));
  fs.writeFileSync(path.join(f.rendererDirectory, 'deployment.json'), json(f.renderer.deployment));
}

for (const network of ['sepolia', 'mainnet']) {
  test(`${network} frozen renderer with an explicit WIP image pin stays verifiable and cannot seed a new collection`, async t => {
    const f = fixture(t, {}, network);
    useHistoricalRenderer(f, true);
    const before = fs.readdirSync(f.rendererDirectory).map(name => [name, fs.readFileSync(path.join(f.rendererDirectory, name), 'utf8')]);
    const release = readRendererRelease(f.rendererDirectory, network);
    await verifyRendererRelease(release, async (method, params) => {
      const response = await fetch('https://tarot-rpc.invalid', { body: JSON.stringify({ method, params }) });
      return (await response.json()).result;
    });
    await assert.rejects(f.prepare(), /current DMX renderer media/);
    assert.deepEqual(fs.readdirSync(f.directory), []);
    assert.deepEqual(fs.readdirSync(f.rendererDirectory).map(name => [name, fs.readFileSync(path.join(f.rendererDirectory, name), 'utf8')]), before);
    assert.equal(f.requests.some(request => request.method === 'eth_sendRawTransaction'), false);
  });
}

test('historical explicit image pins reject mismatched evidence and rewritten metadata against the chain', async t => {
  const f = fixture(t);
  useHistoricalRenderer(f, true);
  const manifestPath = path.join(f.rendererDirectory, 'manifest.json');
  const deploymentPath = path.join(f.rendererDirectory, 'deployment.json');
  for (const change of [{ expectedCollectionImage: collectionMetadata.image }, { collectionMetadata },
    { artifactSha256: 'changed' }, { contractAddress: quoteSigner }]) {
    fs.writeFileSync(deploymentPath, json({ ...f.renderer.deployment, ...change }));
    assert.throws(() => readRendererRelease(f.rendererDirectory), /differs from manifest/);
  }
  fs.writeFileSync(manifestPath, json({ ...f.renderer.manifest, expectedCollectionImage: collectionMetadata.image }));
  fs.writeFileSync(deploymentPath, json({ ...f.renderer.deployment, expectedCollectionImage: collectionMetadata.image, collectionMetadata }));
  await assert.rejects(verifyRendererRelease(readRendererRelease(f.rendererDirectory), async (method, params) => {
    const response = await fetch('https://tarot-rpc.invalid', { body: JSON.stringify({ method, params }) });
    return (await response.json()).result;
  }));
});

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

test('historical collection verification retains its explicit WIP image pin', async () => {
  const manifest = { ...configuration(), contractAddress: '0x3333333333333333333333333333333333333333',
    expectedCollectionImage: pinnedHistoricalMetadata.image };
  validateDeploymentConfiguration(manifest);
  assert.deepEqual(await verifyDeploymentState(manifest,
    stateRpc(manifest, { 'contractURI()': pinnedHistoricalURI }), '0x5'), pinnedHistoricalMetadata);
  await assert.rejects(verifyDeploymentState(manifest, stateRpc(manifest), '0x5'));
});
