import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { decodeReturn, encodeAbi, encodeCall } from '../../../shared/ethereum/abi.ts';
import { withMetadataLock } from '../../../scripts/ethereum-metadata/lock.ts';
import { deploymentGas, matchingRuntime, readCollectionRelease, readRendererRelease, verifyRendererRelease,
  metadataPins, resolveCollectionMetadata, verifyRendererPublication,
  validateDeploymentBalance, validateDeploymentGasPrice } from './tarot-deployment.mjs';

const repository = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const COLLECTION_IMAGE = 'https://cdn.lil.org/nft/dmx/cards/1.png';
const ZERO = '0x' + '0'.repeat(40);
const NETWORKS = { mainnet: 1, sepolia: 11155111 };
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashHex = value => '0x' + Buffer.from(keccak_256(Buffer.from(value.slice(2), 'hex'))).toString('hex');
const topic = signature => '0x' + Buffer.from(keccak_256(Buffer.from(signature))).toString('hex');
const quantity = value => { assert.match(value, /^0x(?:0|[1-9a-f][0-9a-f]*)$/i, 'Invalid RPC quantity'); return BigInt(value); };
const address = value => { assert.match(value, /^0x[0-9a-f]{40}$/i, 'Invalid address'); return value.toLowerCase(); };
const positive = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && BigInt(value) < 2n ** 256n;
const dataFor = renderer => encodeCall('setRenderer(address)', ['address'], [renderer]);
const requestFor = manifest => ({ from: manifest.owner, to: manifest.collection, data: manifest.data, value: '0x0' });
const cast = args => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function parseArguments(argv) {
  const [command, ...args] = argv;
  assert.ok(['prepare', 'sign', 'broadcast', 'verify'].includes(command), 'Use prepare|sign|broadcast|verify');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    assert.ok(['--network', '--directory', '--collection-directory', '--renderer-directory', '--maximum-fee-wei',
      '--keystore', '--password-file'].includes(name) && args[index + 1] && !options[name], 'Invalid or repeated option');
    options[name] = args[index + 1];
  }
  assert.ok(Object.hasOwn(NETWORKS, options['--network']), 'An explicit mainnet or sepolia network is required');
  assert.ok(options['--directory']?.trim(), 'An explicit private activation directory is required');
  for (const name of ['--collection-directory', '--renderer-directory', '--maximum-fee-wei']) {
    assert.ok(command === 'prepare' ? options[name] : !options[name], name + ' is required only for prepare');
  }
  if (command === 'prepare') assert.ok(positive(options['--maximum-fee-wei']), 'A positive activation fee ceiling is required');
  for (const name of ['--keystore', '--password-file']) {
    assert.ok(command === 'sign' ? options[name] : !options[name], name + ' is required only for sign');
  }
  return { command, options, network: options['--network'] };
}

function privateDirectory(directory) {
  const allowed = candidate => {
    const relative = path.relative(repository, candidate);
    if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      assert.ok(['.operations/', '.cache/', 'onchain/ethereum/.local/'].some(prefix => relative.startsWith(prefix)),
        'Activation evidence must be in a private ignored directory or outside the repository');
    }
  };
  allowed(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'Activation directory must have mode 0700');
  const canonical = fs.realpathSync(directory);
  allowed(canonical);
  return canonical;
}

function privateFiles(directory) {
  const read = name => {
    const filename = path.join(directory, name), stat = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!stat) return null;
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'Activation evidence must be a private regular file');
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  };
  const save = (name, value, exclusive = false) => {
    const previous = read(name);
    if (exclusive && previous) { assert.deepEqual(previous, value, 'Frozen activation evidence changed'); return; }
    const filename = path.join(directory, name), temporary = filename + '.' + randomUUID() + '.tmp';
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      try { fs.writeFileSync(descriptor, json(value)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      if (exclusive) fs.linkSync(temporary, filename); else fs.renameSync(temporary, filename);
    } finally { fs.rmSync(temporary, { force: true }); }
    const parent = fs.openSync(directory, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  };
  return { read, save };
}

function releaseHash(release) {
  return sha256(json({ manifest: release.manifest, deployment: release.deployment, artifact: release.artifact, input: release.input,
    ...(release.publicationManifest ? { publicationManifest: release.publicationManifest,
      publicationVerification: release.publicationVerification } : {}),
    ...(release.rendererRelease ? { rendererRelease: releaseHash(release.rendererRelease) } : {}) }));
}

function freezeRelease(directory, release) {
  const target = privateDirectory(directory), files = privateFiles(target), name = release.manifest.contractName;
  files.save('manifest.json', release.manifest, true);
  files.save('deployment.json', release.deployment, true);
  files.save(name + '.artifact.json', release.artifact, true);
  files.save(name + '.standard-input.json', release.input, true);
  if (release.publicationManifest) {
    files.save('publication-manifest.json', release.publicationManifest, true);
    files.save('publication-verification.json', release.publicationVerification, true);
  }
  if (release.rendererRelease) freezeRelease(path.join(target, 'renderer'), release.rendererRelease);
}

async function collectionProof(release, rpc) {
  const { manifest, deployment, artifact } = release;
  const tag = '0x' + deployment.deploymentBlock.toString(16);
  const [receipt, transaction, block, head] = await Promise.all([
    rpc('eth_getTransactionReceipt', [deployment.transactionHash]), rpc('eth_getTransactionByHash', [deployment.transactionHash]),
    rpc('eth_getBlockByNumber', [tag, false]), rpc('eth_getBlockByNumber', ['latest', false]),
  ]);
  assert.ok(receipt?.status === '0x1' && receipt.contractAddress?.toLowerCase() === manifest.contractAddress &&
    receipt.blockHash === deployment.deploymentBlockHash && receipt.blockNumber === tag && receipt.to === null &&
    receipt.from?.toLowerCase() === manifest.deployer, 'Collection deployment receipt differs from frozen evidence');
  assert.ok(transaction?.input === manifest.creationCode && transaction.to === null &&
    transaction.from?.toLowerCase() === manifest.deployer && transaction.blockHash === deployment.deploymentBlockHash &&
    quantity(transaction.chainId) === BigInt(manifest.chainId) && quantity(transaction.value) === 0n,
  'Collection creation transaction differs from frozen evidence');
  assert.ok(block?.hash === deployment.deploymentBlockHash && quantity(head.number) >= BigInt(deployment.deploymentBlock) + 2n,
    'Collection deployment needs three canonical confirmations');
  for (const at of [tag, 'latest']) {
    assert.ok(matchingRuntime(artifact.deployedBytecode.object, await rpc('eth_getCode', [manifest.contractAddress, at]),
      artifact.deployedBytecode.immutableReferences ?? {}), 'Collection runtime differs from frozen evidence');
  }
}

export async function readState(rpc, collection, block = 'latest') {
  const head = await rpc('eth_getBlockByNumber', [block, false]);
  assert.match(head?.hash, /^0x[0-9a-f]{64}$/i, 'Invalid state block');
  const call = async (signature, type) => decodeReturn([type], await rpc('eth_call', [{ to: collection,
    data: encodeCall(signature, [], []) }, head.number]))[0];
  const fields = { owner: 'address', pendingOwner: 'address', renderer: 'address', quoteSigner: 'address',
    mintingPaused: 'bool', redemptionsPaused: 'bool' };
  const values = await Promise.all(Object.entries(fields).map(([name, type]) => call(name + '()', type)));
  const state = Object.fromEntries(Object.keys(fields).map((name, index) => [name,
    fields[name] === 'address' ? address(values[index]) : values[index]]));
  const [name, symbol, maximum, uri] = await Promise.all([call('name()', 'string'), call('symbol()', 'string'),
    call('MAX_TOKEN_ID()', 'uint256'), call('contractURI()', 'string')]);
  assert.equal(name, 'divination machina x', 'Wrong collection name');
  assert.equal(symbol, 'DMX', 'Wrong collection symbol');
  assert.equal(BigInt(maximum), 2000775n, 'Wrong DMX token range');
  assert.equal((await rpc('eth_getBlockByNumber', [head.number, false]))?.hash, head.hash, 'State read encountered a reorg');
  return { ...state, uri, blockNumber: Number(quantity(head.number)), blockHash: head.hash };
}

function assertState(state, manifest, renderer) {
  for (const field of ['owner', 'pendingOwner', 'quoteSigner', 'mintingPaused', 'redemptionsPaused']) {
    assert.equal(state[field], manifest[field], 'Collection state changed: ' + field);
  }
  assert.equal(state.renderer, renderer, 'Active renderer changed; reconcile the activation journal');
}

function validateManifest(manifest, deps) {
  assert.equal(manifest?.version, 1, 'Missing activation manifest');
  for (const field of ['network', 'chainId', 'collection', 'owner', 'nextRenderer', 'collectionReleaseSha256', 'rendererReleaseSha256']) {
    assert.equal(manifest[field], deps.scope[field], 'Frozen activation identity changed: ' + field);
  }
  assert.equal(manifest.expectedCollectionImage, COLLECTION_IMAGE, 'Unexpected activation collection image');
  assert.deepEqual(metadataPins(manifest), metadataPins(deps.scope), 'Frozen activation metadata pins changed');
  assert.equal(manifest.pendingOwner, ZERO, 'Pending collection ownership transfer');
  assert.notEqual(address(manifest.previousRenderer), manifest.nextRenderer, 'Renderer is already active');
  assert.equal(manifest.data, dataFor(manifest.nextRenderer), 'Frozen activation calldata changed');
  assert.ok(typeof manifest.nonce === 'string' && /^(0|[1-9][0-9]*)$/.test(manifest.nonce), 'Invalid activation nonce');
  assert.ok(['feeCeilingWei', 'gasLimit', 'gasPrice', 'maximumFeeWei'].every(field => positive(manifest[field])), 'Invalid activation fee allowance');
  assert.equal(BigInt(manifest.gasLimit) * BigInt(manifest.gasPrice), BigInt(manifest.maximumFeeWei), 'Frozen activation fee changed');
  assert.ok(BigInt(manifest.maximumFeeWei) <= BigInt(manifest.feeCeilingWei), 'Activation exceeds the fee ceiling');
}

export function validateTransaction(transaction, journal, manifest) {
  assert.equal(journal.manifestSha256, sha256(json(manifest)), 'Activation manifest changed after signing');
  assert.match(journal.raw, /^0x(?:[0-9a-f]{2})+$/i, 'Invalid signed transaction');
  assert.equal(hashHex(journal.raw), journal.transactionHash, 'Activation transaction hash changed');
  assert.equal(transaction.signer?.toLowerCase(), manifest.owner, 'Wrong activation signer');
  assert.equal(transaction.to?.toLowerCase(), manifest.collection, 'Wrong activation target');
  assert.equal(transaction.type, '0x0', 'Expected legacy activation transaction');
  assert.equal(BigInt(transaction.chainId), BigInt(manifest.chainId), 'Wrong activation chain');
  assert.equal(BigInt(transaction.value), 0n, 'Activation cannot transfer ETH');
  assert.equal(transaction.input, manifest.data, 'Wrong activation calldata');
  assert.equal(transaction.hash, journal.transactionHash, 'Wrong signed activation hash');
  for (const [key, expected] of [['nonce', 'nonce'], ['gasPrice', 'gasPrice'], ['gas', 'gasLimit']]) {
    assert.equal(BigInt(transaction[key]).toString(), manifest[expected], 'Signed activation allowance changed: ' + key);
  }
}

export function verifyEvents(logs, manifest) {
  const expected = [
    { topics: [topic('RendererUpdated(address,address)'), encodeAbi(['address'], [manifest.previousRenderer]),
      encodeAbi(['address'], [manifest.nextRenderer])], data: '0x' },
    { topics: [topic('BatchMetadataUpdate(uint256,uint256)')], data: encodeAbi(['uint256', 'uint256'], [1, 2000775]) },
    { topics: [topic('ContractURIUpdated()')], data: '0x' },
  ];
  for (const event of expected) {
    const matching = logs.filter(log => log.address?.toLowerCase() === manifest.collection && log.topics?.[0] === event.topics[0]);
    assert.equal(matching.length, 1, 'Missing or duplicate renderer refresh event');
    assert.deepEqual(matching[0].topics, event.topics, 'Renderer refresh event topics differ');
    assert.equal(matching[0].data, event.data, 'Renderer refresh event data differs');
    assert.ok(!matching[0].removed, 'Renderer refresh event was removed');
  }
}

async function readyToSend(deps, manifest) {
  assert.equal(quantity(await deps.rpc('eth_chainId', [])), BigInt(manifest.chainId), 'Wrong activation chain');
  assertState(await deps.state(), manifest, manifest.previousRenderer);
  for (const tag of ['latest', 'pending']) {
    assert.equal(quantity(await deps.rpc('eth_getTransactionCount', [manifest.owner, tag])).toString(), manifest.nonce,
      'Owner nonce changed; reconcile the frozen activation journal');
    validateDeploymentBalance(await deps.rpc('eth_getBalance', [manifest.owner, tag]), manifest.maximumFeeWei);
  }
  assert.equal(await deps.rpc('eth_call', [requestFor(manifest), 'latest']), '0x', 'Renderer activation simulation failed');
  assert.ok(quantity(await deps.rpc('eth_estimateGas', [requestFor(manifest)])) <= BigInt(manifest.gasLimit), 'Activation gas estimate increased');
  const [price, latest, pending] = await Promise.all([deps.rpc('eth_gasPrice', []),
    deps.rpc('eth_getBlockByNumber', ['latest', false]), deps.rpc('eth_getBlockByNumber', ['pending', false])]);
  validateDeploymentGasPrice(manifest.gasPrice, price, latest.baseFeePerGas, pending.baseFeePerGas);
}

export async function runActivation(command, options, deps) {
  assert.ok(['prepare', 'sign', 'broadcast', 'verify'].includes(command), 'Unknown activation command');
  await deps.guard();
  let manifest = deps.read('manifest.json');
  if (command === 'prepare' && !manifest) {
    assert.equal(deps.read('transactions.private.json'), null, 'Recover the original activation manifest');
    const state = await deps.state();
    assert.equal(state.owner, deps.scope.owner, 'Collection owner differs from approved release');
    assert.equal(state.pendingOwner, ZERO, 'Pending collection ownership transfer');
    assert.notEqual(state.renderer, deps.scope.nextRenderer, 'Renderer is already active; recover its activation evidence');
    assert.ok(positive(options.feeCeilingWei), 'A positive activation fee ceiling is required');
    const request = { from: state.owner, to: deps.scope.collection, data: dataFor(deps.scope.nextRenderer), value: '0x0' };
    assert.equal(await deps.rpc('eth_call', [request, 'latest']), '0x', 'Renderer activation simulation failed');
    const allowance = deploymentGas(await deps.rpc('eth_estimateGas', [request]), await deps.rpc('eth_gasPrice', []), options.feeCeilingWei);
    manifest = { version: 1, ...deps.scope, previousRenderer: state.renderer, pendingOwner: state.pendingOwner,
      quoteSigner: state.quoteSigner, mintingPaused: state.mintingPaused, redemptionsPaused: state.redemptionsPaused,
      expectedCollectionImage: COLLECTION_IMAGE, data: request.data, feeCeilingWei: options.feeCeilingWei,
      nonce: quantity(await deps.rpc('eth_getTransactionCount', [state.owner, 'latest'])).toString(), ...allowance,
      observedBlock: state.blockNumber, observedBlockHash: state.blockHash, preparedAt: deps.now() };
    validateManifest(manifest, deps);
    await readyToSend(deps, manifest);
    deps.save('manifest.json', manifest, true);
  }
  validateManifest(manifest, deps);
  if (command === 'prepare') {
    assert.equal(manifest.feeCeilingWei, options.feeCeilingWei, 'Frozen activation fee ceiling changed');
    return { prepared: true, collection: manifest.collection, nextRenderer: manifest.nextRenderer,
      nonce: manifest.nonce, maximumFeeWei: manifest.maximumFeeWei, feeCeilingWei: manifest.feeCeilingWei };
  }
  let journal = deps.read('transactions.private.json');
  if (command === 'sign' && !journal) {
    await readyToSend(deps, manifest);
    const raw = await deps.sign(manifest);
    journal = { manifestSha256: sha256(json(manifest)), raw, transactionHash: hashHex(raw), signedAt: deps.now() };
    validateTransaction(await deps.decode(raw), journal, manifest);
    deps.save('transactions.private.json', journal, true);
  }
  assert.ok(journal, 'Sign and journal the activation before broadcasting');
  validateTransaction(await deps.decode(journal.raw), journal, manifest);
  if (command === 'sign') return { signedAndJournaled: true, transactionHash: journal.transactionHash, nonce: manifest.nonce };
  if (command === 'broadcast') {
    const known = await deps.rpc('eth_getTransactionByHash', [journal.transactionHash]);
    if (!known) {
      await readyToSend(deps, manifest);
      journal = { ...journal, broadcastAttemptedAt: deps.now() };
      deps.save('transactions.private.json', journal);
      assert.equal(await deps.rpc('eth_sendRawTransaction', [journal.raw]), journal.transactionHash, 'Unexpected activation broadcast hash');
      deps.save('transactions.private.json', { ...journal, broadcastAcceptedAt: deps.now() });
    }
    return { broadcast: true, transactionHash: journal.transactionHash, collection: manifest.collection };
  }
  const [receipt, transaction, head] = await Promise.all([deps.rpc('eth_getTransactionReceipt', [journal.transactionHash]),
    deps.rpc('eth_getTransactionByHash', [journal.transactionHash]), deps.rpc('eth_getBlockByNumber', ['latest', false])]);
  assert.ok(receipt?.status === '0x1', 'Renderer activation has not succeeded');
  assert.equal(receipt.transactionHash, journal.transactionHash, 'Wrong activation receipt');
  assert.equal(receipt.from?.toLowerCase(), manifest.owner, 'Wrong activation receipt sender');
  assert.equal(receipt.to?.toLowerCase(), manifest.collection, 'Wrong activation receipt target');
  assert.equal(transaction?.hash, journal.transactionHash, 'Wrong activation transaction');
  validateTransaction({ ...transaction, signer: transaction.from }, journal, manifest);
  assert.equal(transaction.blockHash, receipt.blockHash, 'Activation transaction block differs');
  assert.equal(transaction.blockNumber, receipt.blockNumber, 'Activation transaction height differs');
  const confirmations = quantity(head.number) - quantity(receipt.blockNumber) + 1n;
  assert.ok(confirmations >= 3n, 'Renderer activation needs three canonical confirmations');
  assert.equal((await deps.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]))?.hash, receipt.blockHash, 'Activation receipt is no longer canonical');
  verifyEvents(receipt.logs, manifest);
  for (const tag of [receipt.blockNumber, 'latest']) {
    const state = await deps.state(tag);
    assertState(state, manifest, manifest.nextRenderer);
    await resolveCollectionMetadata(state.uri, manifest, COLLECTION_IMAGE, deps.fetch);
  }
  assert.equal((await deps.rpc('eth_getBlockByNumber', [receipt.blockNumber, false]))?.hash, receipt.blockHash, 'Activation verification encountered a reorg');
  const result = { verified: true, network: manifest.network, chainId: manifest.chainId, collection: manifest.collection,
    owner: manifest.owner, previousRenderer: manifest.previousRenderer, nextRenderer: manifest.nextRenderer,
    transactionHash: journal.transactionHash, blockNumber: Number(quantity(receipt.blockNumber)), blockHash: receipt.blockHash,
    confirmations: Number(confirmations), collectionImage: COLLECTION_IMAGE, refreshEventsVerified: true,
    collectionStateUnchanged: true, gasUsed: quantity(receipt.gasUsed).toString(),
    actualFeeWei: (quantity(receipt.gasUsed) * quantity(receipt.effectiveGasPrice)).toString(),
    feeCeilingWei: manifest.feeCeilingWei, checkedAt: deps.now() };
  Object.assign(result, metadataPins(manifest));
  assert.ok(BigInt(result.actualFeeWei) <= BigInt(manifest.maximumFeeWei), 'Actual activation fee exceeds frozen allowance');
  deps.save('activation.json', result);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options, network } = parseArguments(argv);
  const directory = privateDirectory(path.resolve(options['--directory']));
  return withMetadataLock(path.join(directory, 'operation.lock'), async () => {
    if (command === 'prepare') {
      freezeRelease(path.join(directory, 'collection'), readCollectionRelease(path.resolve(options['--collection-directory']), network));
      freezeRelease(path.join(directory, 'renderer'), readRendererRelease(path.resolve(options['--renderer-directory']), network));
    }
    const collection = readCollectionRelease(path.join(directory, 'collection'), network);
    const renderer = readRendererRelease(path.join(directory, 'renderer'), network);
    assert.equal(renderer.deployment.collectionMetadata.image, COLLECTION_IMAGE, 'Activation requires the CDN PNG renderer');
    assert.equal(renderer.manifest.admin, collection.manifest.admin, 'Renderer administrator differs from collection');
    const scope = { network, chainId: NETWORKS[network], collection: collection.manifest.contractAddress,
      owner: collection.manifest.admin, nextRenderer: renderer.manifest.contractAddress,
      ...metadataPins(renderer.manifest),
      collectionReleaseSha256: releaseHash(collection), rendererReleaseSha256: releaseHash(renderer) };
    const endpoint = (network === 'mainnet' ? process.env.ETHEREUM_TAROT_MAINNET_RPC_URL : process.env.ETHEREUM_TAROT_RPC_URL) ||
      (process.env.ALCHEMY_API_KEY ? 'https://eth-' + network + '.g.alchemy.com/v2/' + encodeURIComponent(process.env.ALCHEMY_API_KEY) : null);
    assert.ok(endpoint && new URL(endpoint).protocol === 'https:', 'An HTTPS RPC is required for the activation network');
    const rpc = async (method, params = []) => {
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      assert.ok(response.ok && !body.error && Object.hasOwn(body, 'result'), 'Activation RPC failed: ' + method);
      return body.result;
    };
    return runActivation(command, { feeCeilingWei: options['--maximum-fee-wei'] }, {
      ...privateFiles(directory), scope, rpc, now: () => new Date().toISOString(),
      state: tag => readState(rpc, scope.collection, tag),
      guard: async () => {
        assert.equal(quantity(await rpc('eth_chainId')), BigInt(scope.chainId), 'Wrong activation chain');
        await collectionProof(collection, rpc);
        await verifyRendererRelease(renderer, rpc);
        await verifyRendererPublication(renderer);
      },
      decode: raw => { const result = JSON.parse(cast(['decode-transaction', raw])); return typeof result === 'string' ? JSON.parse(result) : result; },
      sign: manifest => {
        for (const name of ['--keystore', '--password-file']) {
          const stat = fs.lstatSync(options[name]);
          assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'Signing requires private regular files');
        }
        const wallet = ['--keystore', options['--keystore'], '--password-file', options['--password-file']];
        assert.equal(cast(['wallet', 'address', ...wallet]).toLowerCase(), manifest.owner, 'Wrong owner keystore');
        return cast(['mktx', '--legacy', '--chain', String(manifest.chainId), '--nonce', manifest.nonce,
          '--gas-limit', manifest.gasLimit, '--gas-price', manifest.gasPrice, '--value', '0', ...wallet,
          manifest.collection, 'setRenderer(address)', manifest.nextRenderer]);
      },
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(json(result)), () => {
    console.error('Renderer activation failed; reconcile the private manifest and transaction journal before retrying.');
    process.exitCode = 1;
  });
}
