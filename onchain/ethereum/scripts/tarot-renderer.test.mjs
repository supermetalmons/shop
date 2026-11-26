import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { encodeAbi, encodeCall } from '../../../shared/ethereum/abi.ts';
import { withMetadataLock } from '../../../scripts/ethereum-metadata/lock.ts';
import { COLLECTION_IMAGE, main, parseArguments, readState, runActivation, validateTransaction, verifyEvents } from './tarot-renderer.mjs';

const owner = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
const collection = '0x2222222222222222222222222222222222222222';
const previous = '0x3333333333333333333333333333333333333333';
const next = '0x4444444444444444444444444444444444444444';
const signer = '0x5555555555555555555555555555555555555555';
const ZERO = '0x' + '0'.repeat(40);
const blockHash = '0x' + 'ab'.repeat(32);
const cap = '200000000000000';
const topic = value => '0x' + Buffer.from(keccak_256(Buffer.from(value))).toString('hex');
const uri = image => 'data:application/json;base64,' + Buffer.from(JSON.stringify({
  name: 'divination machina x', symbol: 'DMX', image, external_link: 'https://mons.shop',
})).toString('base64');
const cast = args => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function events(manifest) {
  return [
    { address: collection, topics: [topic('RendererUpdated(address,address)'), encodeAbi(['address'], [manifest.previousRenderer]),
      encodeAbi(['address'], [manifest.nextRenderer])], data: '0x' },
    { address: collection, topics: [topic('BatchMetadataUpdate(uint256,uint256)')], data: encodeAbi(['uint256', 'uint256'], [1, 2000775]) },
    { address: collection, topics: [topic('ContractURIUpdated()')], data: '0x' },
  ];
}

function fixture() {
  const files = new Map(), writes = [], calls = [];
  let active = false, sent = false, failAfterBroadcast = false, signed = 0;
  const overrides = new Map();
  const state = { owner, pendingOwner: ZERO, renderer: previous, quoteSigner: signer,
    mintingPaused: false, redemptionsPaused: true, blockNumber: 90, blockHash };
  const scope = { network: 'mainnet', chainId: 1, collection, owner, nextRenderer: next,
    collectionReleaseSha256: 'a'.repeat(64), rendererReleaseSha256: 'b'.repeat(64) };
  const decoded = () => {
    const journal = files.get('transactions.private.json');
    let result = JSON.parse(cast(['decode-transaction', journal.raw]));
    if (typeof result === 'string') result = JSON.parse(result);
    return { ...result, from: result.signer, blockHash, blockNumber: '0x64' };
  };
  const deps = {
    scope, now: () => '2026-11-26T11:00:00.000Z',
    read: name => files.has(name) ? structuredClone(files.get(name)) : null,
    save: (name, value, exclusive = false) => {
      if (exclusive && files.has(name)) assert.deepEqual(files.get(name), value);
      files.set(name, structuredClone(value)); writes.push(name);
    },
    guard: async () => {},
    state: async () => ({ ...state, renderer: active ? next : state.renderer,
      uri: uri(active ? COLLECTION_IMAGE : 'https://historical.example/card.webp') }),
    sign: manifest => {
      signed++;
      return cast(['mktx', '--legacy', '--chain', '1', '--nonce', manifest.nonce,
        '--gas-limit', manifest.gasLimit, '--gas-price', manifest.gasPrice, '--value', '0',
        '--private-key', '0x' + '0'.repeat(63) + '1', collection, 'setRenderer(address)', next]);
    },
    decode: raw => { let result = JSON.parse(cast(['decode-transaction', raw])); return typeof result === 'string' ? JSON.parse(result) : result; },
    rpc: async (method, params = []) => {
      calls.push(method);
      if (overrides.has(method)) return overrides.get(method)(params);
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_call') return '0x';
      if (method === 'eth_estimateGas') return '0xea60';
      if (method === 'eth_gasPrice') return '0x3e8';
      if (method === 'eth_getTransactionCount') return '0x7';
      if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
      if (method === 'eth_getBlockByNumber') return { number: params[0] === '0x64' ? '0x64' : '0x66', hash: blockHash, baseFeePerGas: '0x3e8' };
      if (method === 'eth_getTransactionByHash') return sent ? decoded() : null;
      if (method === 'eth_sendRawTransaction') {
        assert.ok(files.has('transactions.private.json'), 'The signed journal must precede broadcast');
        assert.ok(files.get('transactions.private.json').broadcastAttemptedAt);
        sent = true; active = true;
        if (failAfterBroadcast) throw new Error('Response lost after RPC accepted the transaction');
        return files.get('transactions.private.json').transactionHash;
      }
      if (method === 'eth_getTransactionReceipt') return sent ? {
        status: '0x1', transactionHash: files.get('transactions.private.json').transactionHash,
        from: owner, to: collection, blockHash, blockNumber: '0x64', logs: events(files.get('manifest.json')),
        gasUsed: '0xea60', effectiveGasPrice: '0x5dc',
      } : null;
      throw new Error('Unexpected RPC: ' + method);
    },
  };
  return { deps, state, files, calls, writes, overrides, decoded,
    prepare: () => runActivation('prepare', { feeCeilingWei: cap }, deps),
    sign: () => runActivation('sign', {}, deps), broadcast: () => runActivation('broadcast', {}, deps),
    verify: () => runActivation('verify', {}, deps), get signCount() { return signed; },
    set active(value) { active = value; }, set failAfterBroadcast(value) { failAfterBroadcast = value; } };
}

test('CLI requires explicit network, release paths and positive cap; later stages cannot override frozen options', () => {
  const args = ['prepare', '--network', 'mainnet', '--directory', '/tmp/activate', '--collection-directory', '/tmp/collection',
    '--renderer-directory', '/tmp/renderer', '--maximum-fee-wei', cap];
  assert.equal(parseArguments(args).network, 'mainnet');
  for (const name of ['--network', '--directory', '--collection-directory', '--renderer-directory', '--maximum-fee-wei']) {
    const index = args.indexOf(name), missing = [...args]; missing.splice(index, 2);
    assert.throws(() => parseArguments(missing));
  }
  for (const bad of ['0', '-1', '01', '1.5', (2n ** 256n).toString()]) assert.throws(() => parseArguments([...args.slice(0, -1), bad]));
  assert.throws(() => parseArguments(['broadcast', '--network', 'mainnet', '--directory', '/tmp/activate', '--maximum-fee-wei', cap]));
  assert.throws(() => parseArguments(['sign', '--network', 'mainnet', '--directory', '/tmp/activate']));
  assert.throws(() => parseArguments([...args, '--network', 'mainnet']));
});

test('prepare freezes the exact collection, old/new renderer, state, calldata, nonce and cap without signing', async () => {
  const f = fixture(), result = await f.prepare(), m = f.files.get('manifest.json');
  assert.equal(result.prepared, true);
  assert.equal(m.previousRenderer, previous);
  assert.equal(m.nextRenderer, next);
  assert.equal(m.data, encodeCall('setRenderer(address)', ['address'], [next]));
  assert.equal(m.nonce, '7');
  assert.equal(m.feeCeilingWei, cap);
  assert.equal(m.quoteSigner, signer);
  assert.equal(m.mintingPaused, false);
  assert.equal(m.redemptionsPaused, true);
  assert.equal(f.signCount, 0);
  assert.equal(f.calls.includes('eth_sendRawTransaction'), false);
  assert.deepEqual(await f.prepare(), result);
  await assert.rejects(runActivation('prepare', { feeCeilingWei: '1' }, f.deps), /fee ceiling changed/);
});

test('prepare rejects unauthorized owners, pending ownership, already active renderer and insufficient fee cap', async () => {
  for (const [field, value] of [['owner', signer], ['pendingOwner', signer], ['renderer', next]]) {
    const f = fixture(); f.state[field] = value;
    await assert.rejects(f.prepare());
    assert.equal(f.files.has('manifest.json'), false);
  }
  const f = fixture();
  await assert.rejects(runActivation('prepare', { feeCeilingWei: '1' }, f.deps), /fee ceiling/);
});

test('every stage verifies the collection and renderer releases before proceeding', async () => {
  for (const command of ['prepare', 'sign', 'broadcast', 'verify']) {
    const f = fixture(); f.deps.guard = async () => { throw new Error('Renderer runtime mismatch'); };
    await assert.rejects(runActivation(command, { feeCeilingWei: cap }, f.deps), /runtime mismatch/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.calls.length, 0);
  }
});

test('sign rejects every protected state change and a different network', async () => {
  for (const [field, value] of [['owner', signer], ['pendingOwner', signer], ['renderer', signer], ['quoteSigner', owner],
    ['mintingPaused', true], ['redemptionsPaused', false]]) {
    const f = fixture(); await f.prepare(); f.state[field] = value;
    await assert.rejects(f.sign(), /state changed|renderer changed/);
    assert.equal(f.signCount, 0);
  }
  const f = fixture(); await f.prepare(); f.overrides.set('eth_chainId', () => '0xaa36a7');
  await assert.rejects(f.sign(), /Wrong activation chain/);
});

test('sign rejects consumed/pending nonce, increased gas, insufficient funds and failed simulation', async () => {
  for (const [method, value, message] of [
    ['eth_getTransactionCount', '0x8', /nonce changed/], ['eth_estimateGas', '0xfffff', /estimate increased/],
    ['eth_getBalance', '0x1', /Insufficient/], ['eth_call', '0x01', /simulation failed/],
    ['eth_gasPrice', '0xffff', /Gas price increased/],
  ]) {
    const f = fixture(); await f.prepare(); f.overrides.set(method, () => value);
    await assert.rejects(f.sign(), message);
    assert.equal(f.files.has('transactions.private.json'), false);
  }
  const f = fixture(); await f.prepare(); f.overrides.set('eth_getTransactionCount', params => params[1] === 'pending' ? '0x8' : '0x7');
  await assert.rejects(f.sign(), /nonce changed/);
});

test('a real offline signature is journaled, repeat signing is idempotent, and wrong signed intent is rejected', async () => {
  const f = fixture(); await f.prepare(); const result = await f.sign();
  assert.equal(result.signedAndJournaled, true);
  assert.deepEqual(await f.sign(), result);
  assert.equal(f.signCount, 1);
  assert.equal(f.calls.includes('eth_sendRawTransaction'), false);
  const manifest = f.files.get('manifest.json'), journal = f.files.get('transactions.private.json'), tx = f.decoded();
  validateTransaction(tx, journal, manifest);
  for (const patch of [{ signer }, { to: signer }, { chainId: '0xaa36a7' }, { value: '0x1' }, { input: '0x' },
    { nonce: '0x8' }, { gasPrice: '0x1' }, { gas: '0x1' }, { type: '0x2' }]) {
    assert.throws(() => validateTransaction({ ...tx, ...patch }, journal, manifest));
  }
});

test('manifest, frozen release hashes and journal tampering are rejected', async () => {
  const f = fixture(); await f.prepare(); await f.sign();
  f.files.get('manifest.json').quoteSigner = owner;
  await assert.rejects(f.broadcast(), /manifest changed after signing/);
  const g = fixture(); await g.prepare(); g.deps.scope.rendererReleaseSha256 = 'c'.repeat(64);
  await assert.rejects(g.sign(), /identity changed/);
  const h = fixture(); await h.prepare(); await h.sign(); h.files.get('transactions.private.json').raw = '0x1234';
  await assert.rejects(h.broadcast());
});

test('broadcast requires a journal and rechecks identity/state/nonce after signing', async () => {
  const f = fixture(); await f.prepare(); await assert.rejects(f.broadcast(), /Sign and journal/);
  await f.sign(); f.state.quoteSigner = owner;
  await assert.rejects(f.broadcast(), /state changed/);
  assert.equal(f.calls.includes('eth_sendRawTransaction'), false);
});

test('lost broadcast response resumes the identical journal without another signature or broadcast', async () => {
  const f = fixture(); await f.prepare(); await f.sign();
  const raw = f.files.get('transactions.private.json').raw;
  f.failAfterBroadcast = true;
  await assert.rejects(f.broadcast(), /Response lost/);
  assert.ok(f.files.get('transactions.private.json').broadcastAttemptedAt);
  assert.equal((await f.broadcast()).broadcast, true);
  assert.equal(f.files.get('transactions.private.json').raw, raw);
  assert.equal(f.calls.filter(method => method === 'eth_sendRawTransaction').length, 1);
  assert.equal(f.signCount, 1);
  assert.equal((await f.verify()).verified, true);
});

test('confirmed activation verifies collection PNG metadata, preserved state and all refresh events', async () => {
  const f = fixture(); await f.prepare(); await f.sign(); await f.broadcast();
  const result = await f.verify();
  assert.equal(result.confirmations, 3);
  assert.equal(result.collectionImage, COLLECTION_IMAGE);
  assert.equal(result.collectionStateUnchanged, true);
  assert.equal(result.refreshEventsVerified, true);
  assert.equal(result.actualFeeWei, '90000000');
  assert.deepEqual(await f.verify(), result);
});

test('verify rejects pending, failed, insufficiently confirmed and noncanonical activations', async () => {
  const f = fixture(); await f.prepare(); await f.sign(); await assert.rejects(f.verify(), /has not succeeded/);
  await f.broadcast();
  f.overrides.set('eth_getTransactionReceipt', () => ({ status: '0x0' }));
  await assert.rejects(f.verify(), /has not succeeded/);
  f.overrides.delete('eth_getTransactionReceipt');
  f.overrides.set('eth_getBlockByNumber', () => ({ number: '0x65', hash: blockHash }));
  await assert.rejects(f.verify(), /three canonical/);
  f.overrides.set('eth_getBlockByNumber', params => ({ number: params[0] === 'latest' ? '0x66' : '0x64', hash: '0x' + 'cd'.repeat(32) }));
  await assert.rejects(f.verify(), /no longer canonical/);
});

test('refresh verification rejects missing/duplicate events, wrong source, wrong renderer, and wrong NFT range', async () => {
  const f = fixture(); await f.prepare(); const manifest = f.files.get('manifest.json');
  verifyEvents(events(manifest), manifest);
  for (const mutate of [logs => logs.pop(), logs => logs.push(logs[0]), logs => { logs[0].address = signer; },
    logs => { logs[0].topics[2] = encodeAbi(['address'], [signer]); }, logs => { logs[1].data = encodeAbi(['uint256', 'uint256'], [1, 777]); },
    logs => { logs[2].removed = true; }]) {
    const logs = events(manifest); mutate(logs);
    assert.throws(() => verifyEvents(logs, manifest));
  }
});

test('verify rejects renderer rollback, signer changes, and incorrect collection image', async () => {
  const f = fixture(); await f.prepare(); await f.sign(); await f.broadcast();
  f.active = false; await assert.rejects(f.verify(), /renderer changed/);
  f.active = true; f.state.quoteSigner = owner; await assert.rejects(f.verify(), /state changed/);
  f.state.quoteSigner = signer;
  const original = f.deps.state;
  f.deps.state = async () => ({ ...await original(), uri: uri('https://example.com/wrong.png') });
  await assert.rejects(f.verify());
});

test('readState pins one canonical block, validates collection identity, and decodes real ABI returns', async () => {
  const values = { 'owner()': ['address', owner], 'pendingOwner()': ['address', ZERO], 'renderer()': ['address', previous],
    'quoteSigner()': ['address', signer], 'mintingPaused()': ['bool', false], 'redemptionsPaused()': ['bool', true],
    'name()': ['string', 'divination machina x'], 'symbol()': ['string', 'DMX'], 'MAX_TOKEN_ID()': ['uint256', 2000775],
    'contractURI()': ['string', uri(COLLECTION_IMAGE)] };
  const encoded = Object.fromEntries(Object.entries(values).map(([sig, [type, value]]) => [encodeCall(sig, [], []), encodeAbi([type], [value])]));
  let blockReads = 0, reorg = false;
  const rpc = async (method, params) => {
    if (method === 'eth_getBlockByNumber') { blockReads++; return { number: '0x64', hash: reorg && blockReads > 1 ? '0x' + 'cd'.repeat(32) : blockHash }; }
    assert.equal(method, 'eth_call'); assert.equal(params[1], '0x64'); assert.equal(params[0].to, collection);
    return encoded[params[0].data];
  };
  const state = await readState(rpc, collection);
  assert.equal(state.renderer, previous); assert.equal(state.blockNumber, 100); assert.equal(state.mintingPaused, false);
  encoded[encodeCall('name()', [], [])] = encodeAbi(['string'], ['Wrong collection']);
  await assert.rejects(readState(rpc, collection), /Wrong collection name/);
  encoded[encodeCall('name()', [], [])] = encodeAbi(['string'], ['divination machina x']);
  reorg = true; blockReads = 0;
  await assert.rejects(readState(rpc, collection), /reorg/);
});

test('main freezes independent release evidence with private permissions and refuses concurrent operations or network changes', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-renderer-activation-test-'));
  const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  const originalFetch = globalThis.fetch, originalRpc = process.env.ETHEREUM_TAROT_MAINNET_RPC_URL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalRpc === undefined) delete process.env.ETHEREUM_TAROT_MAINNET_RPC_URL;
    else process.env.ETHEREUM_TAROT_MAINNET_RPC_URL = originalRpc;
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  execFileSync('forge', ['build', '--offline', 'src/TarotCards.sol', 'src/DMXWebpRenderer.sol',
    '--out', path.join(temporary, 'out'), '--cache-path', path.join(temporary, 'cache')], { cwd: project, stdio: 'pipe', timeout: 30_000 });
  const json = value => JSON.stringify(value, null, 2) + '\n';
  const hash = value => createHash('sha256').update(value).digest('hex');
  const predicted = cast(['compute-address', owner, '--nonce', '7']).match(/0x[0-9a-fA-F]{40}/)[0].toLowerCase();
  const buildRelease = (name, directory, contractAddress, block, image, rendererRelease) => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const artifact = JSON.parse(fs.readFileSync(path.join(temporary, 'out', name + '.sol', name + '.json'), 'utf8'));
    const sources = Object.fromEntries(Object.keys(artifact.metadata.sources).map(source => [source,
      { content: fs.readFileSync(path.join(project, source), 'utf8') }]));
    const { compilationTarget, ...settings } = artifact.metadata.settings;
    const input = { language: 'Solidity', sources, settings: { ...settings,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } } };
    const constructorArgs = name === 'TarotCards' ? encodeAbi(['address', 'address', 'address'], [owner, signer, previous]) : '0x';
    const manifest = { releaseVersion: 2, network: 'mainnet', chainId: 1, contractName: name, deployer: owner, admin: owner,
      contractAddress, expectedCollectionImage: image, constructorArgs, creationCode: artifact.bytecode.object + constructorArgs.slice(2),
      artifactSha256: hash(json(artifact)), standardInputSha256: hash(json(input)), feeCeilingWei: '300000000000000',
      maximumFeeWei: '6000000000', gasPrice: '1000', gasLimit: '6000000', nonce: '7',
      ...(rendererRelease ? { quoteSigner: signer, renderer: previous, rendererReleaseSha256: hash(json(rendererRelease.files)) } : {}) };
    const deployment = { ...manifest, deploymentBlock: block, deploymentBlockHash: '0x' + block.toString(16).padStart(64, '0'),
      transactionHash: '0x' + (block + 100).toString(16).padStart(64, '0'), confirmations: 3,
      collectionMetadata: JSON.parse(Buffer.from(uri(image).split(',')[1], 'base64').toString()) };
    const files = { 'manifest.json': manifest, 'deployment.json': deployment,
      [name + '.artifact.json']: artifact, [name + '.standard-input.json']: input };
    for (const [filename, value] of Object.entries(files)) fs.writeFileSync(path.join(directory, filename), json(value), { mode: 0o600 });
    return { manifest, deployment, artifact, files };
  };
  const originalCollection = path.join(temporary, 'original-collection');
  const old = buildRelease('DMXWebpRenderer', path.join(originalCollection, 'renderer'), previous, 10, 'https://wip.lil.org/dmx/cards/1.webp');
  const original = buildRelease('TarotCards', originalCollection, predicted, 11, 'https://wip.lil.org/dmx/cards/1.webp', old);
  const rendererDirectory = path.join(temporary, 'new-renderer');
  const replacement = buildRelease('DMXWebpRenderer', rendererDirectory, next, 20, COLLECTION_IMAGE);
  const releases = [original, replacement];
  const methods = [];
  process.env.ETHEREUM_TAROT_MAINNET_RPC_URL = 'https://rpc.example.invalid';
  const getters = Object.fromEntries(Object.entries({ 'owner()': ['address', owner], 'pendingOwner()': ['address', ZERO],
    'renderer()': ['address', previous], 'quoteSigner()': ['address', signer], 'mintingPaused()': ['bool', false],
    'redemptionsPaused()': ['bool', true], 'name()': ['string', 'divination machina x'], 'symbol()': ['string', 'DMX'],
    'MAX_TOKEN_ID()': ['uint256', 2000775], 'contractURI()': ['string', uri('https://wip.lil.org/dmx/cards/1.webp')],
  }).map(([signature, [type, value]]) => [encodeCall(signature, [], []), encodeAbi([type], [value])]));
  globalThis.fetch = async (_url, init) => {
    const { method, params } = JSON.parse(init.body); methods.push(method);
    let result;
    if (method === 'eth_chainId') result = '0x1';
    else if (method === 'eth_getTransactionCount') result = '0x7';
    else if (method === 'eth_getBalance') result = '0xde0b6b3a7640000';
    else if (method === 'eth_gasPrice') result = '0x3e8';
    else if (method === 'eth_estimateGas') result = '0xea60';
    else if (method === 'eth_getCode') result = (params[0] === predicted ? original : replacement).artifact.deployedBytecode.object;
    else if (method === 'eth_getBlockByNumber') {
      const release = releases.find(value => '0x' + value.deployment.deploymentBlock.toString(16) === params[0]);
      result = { number: release ? params[0] : '0x64', hash: release?.deployment.deploymentBlockHash ?? blockHash, baseFeePerGas: '0x3e8' };
    } else if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') {
      const release = releases.find(value => value.deployment.transactionHash === params[0]);
      result = { status: '0x1', from: owner, to: null, blockHash: release.deployment.deploymentBlockHash,
        blockNumber: '0x' + release.deployment.deploymentBlock.toString(16), chainId: '0x1', value: '0x0',
        contractAddress: release.manifest.contractAddress, input: release.manifest.creationCode };
    } else if (method === 'eth_call') {
      const request = params[0];
      if (request.to === next) result = request.data.startsWith('0x01ffc9a7') ? encodeAbi(['bool'], [true]) : encodeAbi(['string'], [uri(COLLECTION_IMAGE)]);
      else result = request.data === encodeCall('setRenderer(address)', ['address'], [next]) ? '0x' : getters[request.data];
    } else throw new Error('Unexpected integration RPC: ' + method);
    assert.notEqual(result, undefined, 'A mocked RPC result must exist');
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  };
  const directory = path.join(temporary, 'activation');
  const args = ['prepare', '--network', 'mainnet', '--directory', directory, '--collection-directory', originalCollection,
    '--renderer-directory', rendererDirectory, '--maximum-fee-wei', cap];
  const result = await main(args);
  assert.equal(result.collection, predicted);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.nextRenderer, next);
  assert.equal(manifest.previousRenderer, previous);
  assert.equal(fs.statSync(path.join(directory, 'manifest.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'collection/manifest.json'), 'utf8')), original.manifest);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'renderer/manifest.json'), 'utf8')), replacement.manifest);
  assert.deepEqual(await main(args), result);
  assert.equal(methods.includes('eth_sendRawTransaction'), false);
  await withMetadataLock(path.join(directory, 'operation.lock'), () => assert.rejects(main(args), /Another metadata operation/));
  await assert.rejects(main(['verify', '--network', 'sepolia', '--directory', directory]));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(originalCollection, 'manifest.json'), 'utf8')), original.manifest);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rendererDirectory, 'manifest.json'), 'utf8')), replacement.manifest);
});
