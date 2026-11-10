import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encode, decode } from '@metamask/abi-utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { expected111kRuntime, load111kVerification, verificationRpc, verify111kDeployment, verificationSourceRequests, sourceVerification } from './111k-verification.mjs';

const address = value => '0x' + value.toString(16).padStart(40, '0');
const hash = value => '0x' + value.toString(16).padStart(64, '0');
const hex = value => '0x' + BigInt(value).toString(16);
const encoded = (types, values) => '0x' + Buffer.from(encode(types, values)).toString('hex');
const selector = signature => '0x' + Buffer.from(keccak_256(signature)).subarray(0, 4).toString('hex');
const names = ['_cachedDomainSeparator', '_cachedChainId', '_cachedThis', '_hashedName', '_hashedVersion', '_name', '_version'];
const stages = ['closed', 'reserved', 'open', 'mint-qa', 'unpack-qa'];
const actions = ['deploy', 'reserve', 'open', 'mint-qa', 'unpack-qa'];
const collectionURI = 'https://cdn.mons.shop/111k/collection.json';

for (const [name, environment, expectedUrl] of [
  ['accepts and encodes the deployment Alchemy key', { ALCHEMY_API_KEY: 'test/key?value=1#fragment &' },
    'https://eth-sepolia.g.alchemy.com/v2/test%2Fkey%3Fvalue%3D1%23fragment%20%26'],
  ['retains and encodes the MI Note Alchemy alias', { ALCHEMY_MI_NOTE_API_KEY: 'test/key?value=1#fragment &' },
    'https://eth-sepolia.g.alchemy.com/v2/test%2Fkey%3Fvalue%3D1%23fragment%20%26'],
  ['prefers the deployment Alchemy key over the alias', { ALCHEMY_API_KEY: 'deployment-key', ALCHEMY_MI_NOTE_API_KEY: 'legacy-key' },
    'https://eth-sepolia.g.alchemy.com/v2/deployment-key'],
  ['preserves explicit URL precedence', { ETHEREUM_111K_RPC_URL: 'https://rpc.example.test/sepolia?project=test',
    ALCHEMY_API_KEY: 'deployment-key', ALCHEMY_MI_NOTE_API_KEY: 'legacy-key' }, 'https://rpc.example.test/sepolia?project=test'],
]) test(`verification RPC ${name}`, async () => {
  let requests = 0;
  const rpc = verificationRpc(environment, async (url, init) => {
    requests++;
    assert.equal(url, expectedUrl);
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
    return Response.json({ jsonrpc: '2.0', id: 1, result: '0xaa36a7' });
  });
  assert.equal(await rpc('eth_chainId'), '0xaa36a7');
  assert.equal(requests, 1);
});

test('mainnet verification RPC selects its own Alchemy network and rejects unsupported chains', async () => {
  const rpc = verificationRpc({ ALCHEMY_API_KEY: 'mainnet-key' }, async url => {
    assert.equal(url, 'https://eth-mainnet.g.alchemy.com/v2/mainnet-key');
    return Response.json({ result: '0x1' });
  }, 1);
  assert.equal(await rpc('eth_chainId'), '0x1');
  assert.throws(() => verificationRpc({ ALCHEMY_API_KEY: 'key' }, fetch, 10), /mainnet and Sepolia only/);
});

function fixture(stage, concurrent = false, preopeningPayout = false, options = {}) {
  const chainId = options.chainId ?? 11155111;
  if (chainId === 1) options = { reservation: { quantity: 0, valueWei: '0' }, collectionMetadata: true, newInterface: true, ...options };
  const reservation = options.reservation ?? { quantity: 18, valueWei: '18000000000000000' };
  const publicMinted = options.publicMinted ?? 0;
  const publicLimit = options.publicLimit ?? publicMinted;
  const publicPrice = BigInt(options.publicPrice ?? '0');
  const manifest = { chainId, network: chainId === 1 ? 'mainnet' : 'sepolia', deploymentId: chainId === 1 ? 'mainnet-v1' : 'v15',
    owner: address(99), deployer: address(99), quoteSigner: address(98),
    contractAddress: address(88), initialDeliveryReceiver: address(97), maxDiscountedMints: chainId === 1 ? 500 : 5555,
    metadataBaseURI: chainId === 1 ? 'https://cdn.mons.shop/111k/' : 'https://cdn.mons.shop/111k-sepolia/v15/',
    discountRoot: hash(3), creationCode: '0x6000', constructorArgs: '0x1234',
    proceeds: { mintRecipients: Array.from({ length: 14 }, (_, i) => address(i + 1)),
      mintSharesBps: [2750, 2600, 500, 500, 500, 500, 100, 100, 100, 100, 500, 583, 583, 584] },
    freeMintAllocations: Array.from({ length: 7 }, (_, i) => ({ wallet: address(100 + i), crateLimit: 0, warehouseLimit: 0, relicLimit: i < 4 ? 3 : 2 })),
    immutableNames: Object.fromEntries(names.map((name, i) => [i + 1, name])) };
  if (options.reservation) {
    manifest.relicReservation = reservation;
    manifest.freeMintAllocations = reservation.quantity ? [{ wallet: address(100), crateLimit: 0, warehouseLimit: 0, relicLimit: reservation.quantity }] : [];
  }
  if (chainId === 1) Object.assign(manifest, { nonce: '0', gasLimit: '8000000', gasPrice: '200000000', maximumFeeWei: '1600000000000000' });
  const artifact = { deployedBytecode: { object: '0x' + '00'.repeat(32 * 7),
    immutableReferences: Object.fromEntries(names.map((_, i) => [i + 1, [{ start: i * 32, length: 32 }]])) },
    metadata: { compiler: { version: '0.8.38+commit.1835d247' } } };
  if (options.collectionMetadata) artifact.abi = [{ type: 'function', name: 'contractURI', inputs: [],
    outputs: [{ name: '', type: 'string' }], stateMutability: 'pure' }];
  const compilerOutput = { sources: { 'EIP712.sol': { ast: { nodes: names.map((name, i) => ({ id: i + 1, name,
    nodeType: 'VariableDeclaration', mutability: 'immutable' })) } } } };
  const crateTokenId = concurrent ? 113111 : 113110;
  const firstArtwork = concurrent ? 21 : 1;
  const calldata = {
    deploy: manifest.creationCode,
    reserve: selector('allocateRelics(uint256)') + encoded(['uint256'], [reservation.quantity]).slice(2),
    open: selector('setSaleActive(bool)') + encoded(['bool'], [true]).slice(2),
    'mint-qa': selector('mintCrates(uint256)') + encoded(['uint256'], [1]).slice(2),
    'unpack-qa': selector('unboxCrate(uint256)') + encoded(['uint256'], [crateTokenId]).slice(2),
  };
  const journal = { actions: Object.fromEntries(actions.map((action, i) => [action, { action, hash: hash(i + 1000),
    data: calldata[action], valueWei: action === 'reserve' ? reservation.valueWei : action === 'mint-qa' ? '100000000000000' : '0', nonce: i }])) };
  if (reservation.quantity === 0) journal.actions.reserve = { action: 'reserve', skipped: true, chainId: manifest.chainId,
    contractAddress: manifest.contractAddress, blockNumber: '0x2', blockHash: hash(2) };
  if (chainId === 1) journal.actions = { deploy: { ...journal.actions.deploy,
    gasLimit: manifest.gasLimit, gasPrice: manifest.gasPrice, maximumFeeWei: manifest.maximumFeeWei } };
  const context = { manifest, artifact, compilerOutput, journal, manifestSha256: 'f'.repeat(64),
    input: { language: 'Solidity', sources: { 'src/NFT111K.sol': { content: 'contract NFT111K {}' } },
      settings: { optimizer: { enabled: true, runs: 500 }, evmVersion: 'prague' } } };
  context.runtime = expected111kRuntime(artifact, manifest, compilerOutput);
  const reserved = stage !== 'closed';
  const minted = stage === 'mint-qa' || stage === 'unpack-qa';
  const unpacked = stage === 'unpack-qa';
  const revenue = (reserved ? BigInt(reservation.valueWei) : 0n) + (minted ? 100000000000000n : 0n) +
    (concurrent ? 100000000000000n : 0n) + BigInt(publicMinted) * publicPrice;
  const payouts = manifest.proceeds.mintSharesBps.map((share, index) => preopeningPayout || concurrent && index === 0
    ? revenue * BigInt(share) / 10000n : 0n);
  const paid = payouts.reduce((total, payout) => total + payout, 0n);
  const lookup = new Map();
  const register = (signature, types, values) => lookup.set(selector(signature), { types, values });
  register('owner()', ['address'], [manifest.owner]);
  register('pendingOwner()', ['address'], [address(0)]);
  register('quoteSigner()', ['address'], [manifest.quoteSigner]);
  register('baseURI()', ['string'], [manifest.metadataBaseURI]);
  if (options.collectionMetadata) register('contractURI()', ['string'], [collectionURI]);
  register('mintRecipientCount()', ['uint256'], [14]);
  register('deliveryConfigCount()', ['uint256'], [1]);
  register('deliveryConfigs(uint256)', ['address', 'address', 'uint16', 'uint256', 'uint256', 'uint256'], [manifest.initialDeliveryReceiver, address(0), 0, 0, 0, 0]);
  register('stats(address)', ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
    [(reserved ? reservation.quantity * 111 : 0) + (minted ? 1 : 0) + (concurrent ? 1 : 0) + publicMinted * 111,
      0, (unpacked ? 20 : 0) + (concurrent ? 20 : 0), 100000000000000n, 1100000000000000n,
      stages.indexOf(stage) >= 2, manifest.discountRoot, 50000000000000n, 1, 0, reserved ? reservation.quantity : 0, concurrent ? 1 : 0, manifest.maxDiscountedMints, 0]);
  if (options.newInterface) {
    const stats = lookup.get(selector('stats(address)'));
    stats.types.push('uint256'); stats.values.push(publicMinted);
    const active = stages.indexOf(stage) >= 2 && publicLimit > 0;
    register('publicRelicStats(address)', ['uint256', 'uint256', 'uint256', 'bool', 'uint256', 'uint16', 'uint16'],
      [publicLimit, publicMinted, publicPrice, active, active ? Math.min(publicLimit - publicMinted, Math.floor((5555 - stats.values[0]) / 111)) : 0, 0, 0]);
  }
  register('eip712Domain()', ['bytes1', 'string', 'string', 'uint256', 'address', 'bytes32', 'uint256[]'], ['0x0f', '111K', '2', chainId, manifest.contractAddress, hash(0), []]);
  register('totalSupply()', ['uint256'], [(unpacked ? 20 : minted ? 1 : 0) + (concurrent ? 21 : 0) + publicMinted]);
  register('totalMintReceived()', ['uint256'], [revenue]);
  register('totalMintReleased()', ['uint256'], [paid]);
  register('getRelicClaimedMask()', ['uint256'], [(1 << (publicMinted + (concurrent ? 1 : 0))) - 1]);
  register('redemptionsPaused()', ['bool'], [false]);
  const rpc = async (method, params = []) => {
    if (method === 'eth_chainId') return hex(chainId);
    if (method === 'eth_getLogs') {
      assert.equal(chainId, 1);
      const [{ topics, ...scope }] = params;
      assert.deepEqual(scope, { address: manifest.contractAddress, fromBlock: '0x1', toBlock: '0xa' });
      return (options.historyEvents ?? []).filter(event => event.address === scope.address
        && BigInt(event.blockNumber) >= BigInt(scope.fromBlock) && BigInt(event.blockNumber) <= BigInt(scope.toBlock)
        && topics[0].includes(event.topics[0]));
    }
    if (method === 'eth_getBlockByNumber') { const n = params[0] === 'latest' ? 10 : Number(BigInt(params[0])); return { number: hex(n), hash: hash(n) }; }
    if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') {
      const index = actions.findIndex(action => journal.actions[action]?.hash === params[0]);
      const entry = journal.actions[actions[index]];
      const blockNumber = hex(index + 1);
      if (method === 'eth_getTransactionReceipt') {
        const topic = signature => '0x' + Buffer.from(keccak_256(signature)).toString('hex');
        const logs = index === 3 ? [{ address: manifest.contractAddress,
          topics: [topic('CratesPurchased(address,uint256,uint256,uint256)'), hash(99)],
          data: encoded(['uint256', 'uint256', 'uint256'], [crateTokenId, 1, 100000000000000n]) }]
          : index === 4 ? [{ address: manifest.contractAddress,
            topics: [topic('CrateUnboxed(uint256,address,uint256,uint256)'), hash(crateTokenId), hash(99)],
            data: encoded(['uint256', 'uint256'], [firstArtwork, 20]) }] : [];
        return { status: '0x1', transactionHash: entry.hash, blockHash: hash(index + 1), blockNumber,
          contractAddress: index === 0 ? manifest.contractAddress : null, gasUsed: '0x5208', logs };
      }
      return { hash: entry.hash, from: manifest.deployer, to: index === 0 ? null : manifest.contractAddress,
        input: entry.data, value: hex(entry.valueWei), nonce: hex(index), chainId: hex(chainId), blockHash: hash(index + 1), blockNumber,
        ...(chainId === 1 ? { gas: hex(manifest.gasLimit), gasPrice: hex(manifest.gasPrice) } : {}) };
    }
    if (method === 'eth_call' && reservation.quantity === 0 && params[1]?.blockHash === hash(2)) {
      assert.deepEqual(params[1], { blockHash: hash(2), requireCanonical: true });
      const isSale = params[0].data === selector('saleActive()');
      return encoded([isSale ? 'bool' : 'uint256'], [isSale ? false : 0]);
    }
    assert.deepEqual(params[1], { blockHash: hash(10), requireCanonical: true });
    if (method === 'eth_getCode') return context.runtime;
    if (method === 'eth_getBalance') return hex(revenue - paid);
    assert.equal(method, 'eth_call');
    const data = params[0].data;
    const known = lookup.get(data.slice(0, 10));
    if (known) return encoded(known.types, known.values);
    const args = types => decode(types, '0x' + data.slice(10));
    if (data.startsWith(selector('mintRecipients(uint256)'))) return encoded(['address'], [manifest.proceeds.mintRecipients[Number(args(['uint256'])[0])]]);
    if (['mintSharesBps(address)', 'mintReleased(address)', 'releasableMint(address)'].some(signature => data.startsWith(selector(signature)))) {
      const index = manifest.proceeds.mintRecipients.indexOf(args(['address'])[0]);
      assert.ok(index >= 0);
      const share = manifest.proceeds.mintSharesBps[index];
      const released = payouts[index];
      return encoded(['uint256'], [data.startsWith(selector('mintSharesBps(address)')) ? share :
        data.startsWith(selector('mintReleased(address)')) ? released : revenue * BigInt(share) / 10000n - released]);
    }
    if (data.startsWith(selector('freeMintAllowances(address)'))) {
      const allocation = manifest.freeMintAllocations.find(value => value.wallet === args(['address'])[0]);
      return encoded(Array(6).fill('uint16'), [0, 0, allocation.relicLimit, 0, 0, concurrent && allocation.wallet === address(100) ? 1 : 0]);
    }
    if (data.startsWith(selector('previewTokenURI(uint8,uint256)'))) {
      const [kind, displayId] = args(['uint8', 'uint256']);
      const offset = { 1: 0n, 2: 111111n, 3: 116666n, 4: 1000000n, 5: 2000000n, 6: 117171n, 7: 3000000n }[kind.toString()];
      return encoded(['string'], [manifest.metadataBaseURI + (offset + displayId).toString() + '.json']);
    }
    if (data.startsWith(selector('getTokenInfo(uint256)'))) {
      const [id] = args(['uint256']);
      return encoded(['uint8', 'uint256', 'address'], id === BigInt(crateTokenId)
        ? unpacked ? [0, 0, address(0)] : [2, crateTokenId - 111111, manifest.deployer] : [1, id, manifest.deployer]);
    }
    assert.fail('Unhandled mock call ' + data.slice(0, 10));
  };
  return { context, rpc, lookup };
}

for (const stage of stages) test(`verifies ${stage} at one canonical block with fourteen receivers`, async () => {
  const { context, rpc } = fixture(stage);
  const report = await verify111kDeployment(context, rpc, stage);
  assert.equal(report.stage, stage);
  assert.equal(report.mintRecipients.length, 14);
  assert.equal(report.mintRecipients[13].shareBps, 584n);
  assert.equal(report.freeMintAllowances.length, 7);
  assert.equal(report.publicRelicsMinted, 0n);
  assert.equal(report.publicSale, null);
  assert.equal(report.runtimeAndImmutablesMatch, true);
  assert.equal(report.totalMintReleased, 0n);
  assert.equal(Object.keys(report.actions).length, stages.indexOf(stage) + 1);
});

test('verifies mainnet as a closed zero-issuance deployment with clean metadata URLs', async () => {
  const { context, rpc } = fixture('closed', false, false, { chainId: 1 });
  const report = await verify111kDeployment(context, rpc);
  assert.equal(report.chainId, 1);
  assert.deepEqual(report.relicReservation, { quantity: 0, valueWei: '0' });
  assert.deepEqual(report.freeMintAllowances, []);
  assert.deepEqual(Object.keys(report.actions), ['deploy']);
  assert.deepEqual(report.publicSale, [0n, 0n, 0n, false, 0n, 0n, 0n]);
  assert.equal(report.stats[5], false);
  assert.equal(report.stats[10], 0n);
  assert.equal(report.stats[12], 500n);
  assert.equal(report.totalSupply, 0n);
  assert.equal(report.totalMintReceived, 0n);
  assert.equal(report.metadataPreviews[0].uri, 'https://cdn.mons.shop/111k/1.json');
  const sepolia = { ...context.manifest, chainId: 11155111 };
  assert.notEqual(context.runtime, expected111kRuntime(context.artifact, sepolia, context.compilerOutput));
  await assert.rejects(verify111kDeployment(context, (method, params) => method === 'eth_getCode'
    ? expected111kRuntime(context.artifact, sepolia, context.compilerOutput) : rpc(method, params)), /Runtime or constructor immutables/);
});

test('mainnet rejects opening, reservation, QA stages, and extra journal actions before RPC reads', async () => {
  const { context } = fixture('closed', false, false, { chainId: 1 });
  const rpc = async () => assert.fail('Unexpected RPC request');
  for (const stage of stages.slice(1)) await assert.rejects(verify111kDeployment(context, rpc, stage), /closed stage only/);
  context.journal.actions.reserve = { skipped: true };
  await assert.rejects(verify111kDeployment(context, rpc), /only deployment/);
});

test('mainnet rejects wrong-chain receipts and evidence of sale activation, allocation, or issuance', async () => {
  const { context, rpc } = fixture('closed', false, false, { chainId: 1 });
  await assert.rejects(verify111kDeployment(context, async (method, params) => method === 'eth_chainId'
    ? hex(11155111) : rpc(method, params)), /RPC chain mismatch/);
  await assert.rejects(verify111kDeployment(context, async (method, params) => {
    const result = await rpc(method, params);
    return method === 'eth_getTransactionByHash' ? { ...result, chainId: hex(11155111) } : result;
  }));
  for (const signature of ['SaleStatusUpdated(bool)', 'RelicsAllocated(uint256,uint256)', 'Transfer(address,address,uint256)']) {
    const changed = fixture('closed', false, false, { chainId: 1, historyEvents: [{ address: address(88), blockNumber: '0x5',
      topics: ['0x' + Buffer.from(keccak_256(signature)).toString('hex')] }] });
    await assert.rejects(verify111kDeployment(changed.context, changed.rpc), /changed after deployment/);
  }
});

for (const [signature, types, values] of [
  ['FreeMintAllowanceUpdated(address,uint16,uint16,uint16)', ['uint16', 'uint16', 'uint16'], [1, 0, 0]],
  ['PublicRelicFreeMintAllowanceUpdated(address,uint16)', ['uint16'], [1]],
]) test(`mainnet detects an unlisted wallet grant through ${signature} while minting remains closed`, async () => {
  const { context, rpc } = fixture('closed', false, false, { chainId: 1, historyEvents: [{
    address: address(88), blockNumber: '0x5', topics: ['0x' + Buffer.from(keccak_256(signature)).toString('hex'), hash(123)],
    data: encoded(types, values),
  }] });
  assert.deepEqual(context.manifest.freeMintAllocations, []);
  await assert.rejects(verify111kDeployment(context, rpc), /free allowances changed after deployment/);
});

test('mainnet receipt verification enforces frozen nonce, gas, and the approved fee ceiling', async () => {
  for (const changed of [{ nonce: '0x1' }, { gas: hex(8_000_001) }, { gasPrice: hex(200_000_001) }]) {
    const { context, rpc } = fixture('closed', false, false, { chainId: 1 });
    await assert.rejects(verify111kDeployment(context, async (method, params) => {
      const value = await rpc(method, params);
      return method === 'eth_getTransactionByHash' ? { ...value, ...changed } : value;
    }));
  }
  const { context, rpc } = fixture('closed', false, false, { chainId: 1 });
  context.manifest.gasPrice = context.journal.actions.deploy.gasPrice = '300000000';
  context.manifest.maximumFeeWei = context.journal.actions.deploy.maximumFeeWei = '2400000000000000';
  await assert.rejects(verify111kDeployment(context, rpc), /approved fee ceiling/);
});

test('mainnet requires the current metadata and public relic interfaces', async () => {
  for (const options of [{ collectionMetadata: false }, { newInterface: false }]) {
    const { context, rpc } = fixture('closed', false, false, { chainId: 1, ...options });
    await assert.rejects(verify111kDeployment(context, rpc), /Mainnet requires/);
  }
});

test('frozen mainnet loading rejects changed launch policy before reading artifacts', async t => {
  const directory = await mkdtemp(join(tmpdir(), '111k-mainnet-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { context } = fixture('closed', false, false, { chainId: 1 });
  for (const [change, message] of [
    [{ chainId: 10 }, /mainnet and Sepolia only/],
    [{ network: 'sepolia' }, /network and chain differ/],
    [{ metadataBaseURI: 'https://cdn.mons.shop/111k/mainnet-v1/' }, /clean metadata root/],
    [{ relicReservation: { quantity: 1, valueWei: '0' } }, /must not reserve relics/],
    [{ freeMintAllocations: [{ wallet: address(100), crateLimit: 1, warehouseLimit: 0, relicLimit: 0 }] }, /must be empty/],
    [{ maxDiscountedMints: 5555 }, /discounted mint cap changed/],
  ]) {
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...context.manifest, ...change }));
    await assert.rejects(load111kVerification(directory), message);
  }
});

test('verifies the shared collection URI exposed by the frozen ABI at the canonical block', async () => {
  const { context, rpc } = fixture('closed', false, false, { collectionMetadata: true });
  const report = await verify111kDeployment(context, rpc);
  assert.equal(report.contractURI, collectionURI);
});

test('rejects a changed collection URI instead of falling back to legacy verification', async () => {
  const { context, rpc, lookup } = fixture('closed', false, false, { collectionMetadata: true });
  for (const uri of ['', 'https://cdn.mons.shop/111k-sepolia/collection.json']) {
    lookup.get(selector('contractURI()')).values[0] = uri;
    await assert.rejects(verify111kDeployment(context, rpc), /Collection contractURI\(\) changed/);
  }
});

test('propagates collection URI RPC failures for a frozen ABI that exposes the getter', async () => {
  const { context, rpc } = fixture('closed', false, false, { collectionMetadata: true });
  await assert.rejects(verify111kDeployment(context, async (method, params) => {
    if (method === 'eth_call' && params[0].data === selector('contractURI()')) throw new Error('Unavailable collection URI');
    return rpc(method, params);
  }), /Unavailable collection URI/);
});

test('does not request collection metadata from historical artifacts without the getter', async () => {
  const { context, rpc } = fixture('closed');
  for (const abi of [undefined, [], [{ type: 'event', name: 'contractURI', inputs: [] }],
    [{ type: 'function', name: 'contractURI', inputs: [{ type: 'uint256' }] }]]) {
    context.artifact.abi = abi;
    const report = await verify111kDeployment(context, async (method, params) => {
      if (method === 'eth_call') assert.notEqual(params[0].data, selector('contractURI()'));
      return rpc(method, params);
    });
    assert.equal(Object.hasOwn(report, 'contractURI'), false);
  }
});

for (const quantity of [0, 3, 18]) test(`verifies an explicit ${quantity}-relic reservation and inactive public issuance`, async () => {
  const reservation = { quantity, valueWei: quantity ? '17' : '0' };
  const { context, rpc } = fixture('reserved', false, false, { reservation, newInterface: true });
  const report = await verify111kDeployment(context, rpc, 'reserved');
  assert.equal(report.stats[10], BigInt(quantity));
  assert.equal(report.stats[0], BigInt(quantity * 111));
  assert.equal(report.totalMintReceived, BigInt(reservation.valueWei));
  assert.deepEqual(report.relicReservation, reservation);
  assert.deepEqual(report.publicSale, [0n, 0n, 0n, false, 0n, 0n, 0n]);
});

test('public issuance does not consume reserved claims and shares the permanent ID mask', async () => {
  const { context, rpc, lookup } = fixture('open', true, false, {
    reservation: { quantity: 3, valueWei: '101' }, newInterface: true, publicMinted: 2, publicLimit: 4, publicPrice: '11',
  });
  const report = await verify111kDeployment(context, rpc, 'open');
  assert.equal(report.stats[10], 3n);
  assert.equal(report.stats[11], 1n);
  assert.equal(report.publicRelicsMinted, 2n);
  assert.equal(report.claimedRelicMask, 7n);
  assert.equal(report.publicSale[4], 2n);
  lookup.get(selector('getRelicClaimedMask()')).values[0] = 1;
  await assert.rejects(verify111kDeployment(context, rpc, 'open'));
});

test('public stats failures and invalid capacity never fall back to legacy verification', async () => {
  const { context, rpc, lookup } = fixture('open', false, false, {
    reservation: { quantity: 2, valueWei: '0' }, newInterface: true, publicMinted: 1, publicLimit: 3,
  });
  lookup.get(selector('publicRelicStats(address)')).values[4] = 3;
  await assert.rejects(verify111kDeployment(context, rpc, 'open'));
  await assert.rejects(verify111kDeployment(context, async (method, params) => {
    if (method === 'eth_call' && params[0].data.startsWith(selector('publicRelicStats(address)'))) throw new Error('Unavailable public stats');
    return rpc(method, params);
  }, 'open'), /Unavailable public stats/);
});

test('zero reservation verification rejects a missing skip and a changed historical snapshot', async () => {
  const { context, rpc } = fixture('open', false, false, { reservation: { quantity: 0, valueWei: '0' }, newInterface: true });
  await verify111kDeployment(context, rpc, 'open');
  const entry = context.journal.actions.reserve;
  delete context.journal.actions.reserve;
  await assert.rejects(verify111kDeployment(context, rpc, 'open'), /Missing zero relic reservation/);
  context.journal.actions.reserve = entry;
  await assert.rejects(verify111kDeployment(context, async (method, params) => method === 'eth_getBlockByNumber' && params[0] === '0x2'
    ? { number: '0x2', hash: hash(999) } : rpc(method, params), 'open'), /no longer canonical/);
});

test('rejects wrong immutable bytes instead of masking them', async () => {
  const { context, rpc } = fixture('closed');
  await assert.rejects(verify111kDeployment(context, (method, params) => method === 'eth_getCode'
    ? '0x' + '00'.repeat(32 * 7) : rpc(method, params)), /Runtime or constructor immutables/);
  const wrong = structuredClone(context.compilerOutput);
  wrong.sources['EIP712.sol'].ast.nodes[0].name = 'unexpected';
  assert.throws(() => expected111kRuntime(context.artifact, context.manifest, wrong), /Unknown frozen runtime immutable/);
});

test('rejects reorganized and insufficiently confirmed actions', async () => {
  const { context, rpc } = fixture('reserved');
  await assert.rejects(verify111kDeployment(context, async (method, params) => {
    const value = await rpc(method, params);
    return method === 'eth_getBlockByNumber' && params[0] === '0x1' ? { ...value, hash: hash(123) } : value;
  }, 'reserved'), /not canonical/);
  await assert.rejects(verify111kDeployment(context, async (method, params) => method === 'eth_getBlockByNumber' && params[0] === 'latest'
    ? { number: '0x2', hash: hash(2) } : rpc(method, params), 'reserved'), /three canonical confirmations/);
});

test('verifies replay protection when a legacy RPC transaction omits chainId', async () => {
  const { context, rpc } = fixture('closed');
  const report = await verify111kDeployment(context, async (method, params) => {
    const value = await rpc(method, params);
    if (method !== 'eth_getTransactionByHash') return value;
    const { chainId, ...legacy } = value;
    return { ...legacy, v: hex(BigInt(chainId) * 2n + 35n) };
  });
  assert.equal(report.chainId, 11155111);
});

test('rejects inconsistent recipient payout accounting before opening', async () => {
  const { context, rpc, lookup } = fixture('reserved');
  lookup.get(selector('totalMintReleased()')).values = [1];
  await assert.rejects(verify111kDeployment(context, rpc, 'reserved'), /Released mint total does not match recipient accounting/);
});

test('preopening verification accepts permissionless releaseAllMint while preserving reservation checks', async () => {
  const { context, rpc } = fixture('reserved', false, true);
  const report = await verify111kDeployment(context, rpc, 'reserved');
  assert.equal(report.totalSupply, 0n);
  assert.equal(report.stats[5], false);
  assert.equal(report.stats[10], 18n);
  assert.equal(report.stats[11], 0n);
  assert.equal(report.totalMintReceived, 18000000000000000n);
  assert.equal(report.totalMintReleased, report.totalMintReceived);
  assert.equal(report.contractBalanceWei, 0n);
  for (const recipient of report.mintRecipients) {
    assert.equal(recipient.released, report.totalMintReceived * recipient.shareBps / 10000n);
    assert.equal(recipient.releasable, 0n);
  }
  for (const allowance of report.freeMintAllowances) assert.deepEqual(allowance.values.slice(3), [0n, 0n, 0n]);
});

test('post-open QA tolerates concurrent public mint, claim, and proceeds release', async () => {
  const { context, rpc } = fixture('unpack-qa', true);
  const report = await verify111kDeployment(context, rpc, 'unpack-qa');
  assert.equal(report.totalSupply, 41n);
  assert.equal(report.stats[2], 40n);
  assert.equal(report.stats[11], 1n);
  assert.ok(report.totalMintReleased > 0n);
  assert.equal(report.qa.crateTokenId, 113111n);
  assert.equal(report.qa.firstArtwork, 21n);
  assert.equal(report.qa.artworkCount, 20);
  assert.deepEqual(report.qa.tokenIds, Array.from({ length: 20 }, (_, index) => BigInt(index + 21)));
});

for (const chainId of [1, 11155111]) test(`chain ${chainId} source requests contain frozen constructor and source data without credentials`, () => {
  const { context } = fixture('closed', false, false, { chainId });
  const requests = verificationSourceRequests(context);
  assert.equal(requests.etherscan.constructorArguments, '1234');
  assert.equal(requests.etherscan.codeformat, 'solidity-standard-json-input');
  assert.equal(requests.etherscan.chainid, String(chainId));
  assert.deepEqual(requests.sourcify.stdJsonInput, context.input);
  assert.equal(requests.sourcify.creationTransactionHash, context.journal.actions.deploy.hash);
  assert.equal('apikey' in requests.etherscan, false);
  assert.equal('raw' in requests.sourcify, false);
});

for (const chainId of [1, 11155111]) test(`chain ${chainId} source submission refuses the wrong chain before posting anything`, async () => {
  const { context } = fixture('closed', false, false, { chainId });
  let requests = 0;
  await assert.rejects(sourceVerification(context, 'sourcify', 'submit', { rpc: async () => hex(chainId === 1 ? 11155111 : 1),
    request: async () => { requests++; throw new Error('Unexpected network request'); } }));
  assert.equal(requests, 0);
});

for (const chainId of [1, 11155111]) for (const success of [true, false]) test(`chain ${chainId} Etherscan submission routes v2 query parameters and preserves ${success ? 'success' : 'sanitized failure'}`, async t => {
  const { context, rpc } = fixture('closed', false, false, { chainId });
  context.directory = await mkdtemp(join(tmpdir(), '111k-verification-'));
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  const apiKey = 'test-api-secret';
  const submit = () => sourceVerification(context, 'etherscan', 'submit', { rpc, apiKey, request: async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://api.etherscan.io/v2/api');
    assert.equal(url.searchParams.get('chainid'), String(chainId));
    assert.equal(url.searchParams.get('apikey'), apiKey);
    assert.equal(url.searchParams.get('module'), 'contract');
    assert.equal(url.searchParams.get('action'), 'verifysourcecode');
    assert.equal(init.method, 'POST');
    const body = new URLSearchParams(init.body);
    for (const field of ['chainid', 'apikey', 'module', 'action']) assert.equal(body.has(field), false);
    assert.equal(body.get('constructorArguments'), '1234');
    assert.deepEqual(JSON.parse(body.get('sourceCode')), context.input);
    return Response.json(success ? { status: '1', message: 'OK', result: 'verification-guid' }
      : { status: '0', message: 'NOTOK', result: `Missing chainid for ${apiKey}` });
  } });
  if (success) assert.equal((await submit()).guid, 'verification-guid');
  else await assert.rejects(submit(), /Etherscan source submission failed: Missing chainid for \[redacted\]/);
  const response = await readFile(join(context.directory, 'NFT111K.etherscan-submission-response.json'), 'utf8');
  assert.equal(response.includes(apiKey), false);
  assert.equal(JSON.parse(response).status, success ? '1' : '0');
  if (!success) {
    assert.match(JSON.parse(response).result, /\[redacted\]/);
    await assert.rejects(readFile(join(context.directory, 'NFT111K.etherscan-submission.json')), { code: 'ENOENT' });
  }
});

test('Etherscan publication still rejects a similar match with matching constructor data', async () => {
  const { context } = fixture('closed');
  await assert.rejects(sourceVerification(context, 'etherscan', 'verify', { apiKey: 'test-api-secret',
    request: async () => Response.json({ status: '1', result: [{ ContractName: 'NFT111K',
      CompilerVersion: 'v0.8.38+commit.1835d247', ConstructorArguments: '1234', SimilarMatch: address(77),
      ABI: '[]', SourceCode: JSON.stringify(context.input) }] }) }), /only reports a similar match/);
});

test('mainnet Sourcify submission uses chain-one lookup and submission paths', async t => {
  const { context, rpc } = fixture('closed', false, false, { chainId: 1 });
  context.directory = await mkdtemp(join(tmpdir(), '111k-mainnet-sourcify-'));
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  let requests = 0;
  const result = await sourceVerification(context, 'sourcify', 'submit', { rpc, request: async (url, init) => {
    requests++;
    const path = new URL(url).pathname;
    if (!init.method) {
      assert.equal(path, `/server/v2/contract/1/${context.manifest.contractAddress}`);
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    assert.equal(init.method, 'POST');
    assert.equal(path, `/server/v2/verify/1/${context.manifest.contractAddress}`);
    assert.deepEqual(JSON.parse(init.body), verificationSourceRequests(context).sourcify);
    return Response.json({ verificationId: 'mainnet-verification' }, { status: 202 });
  } });
  assert.equal(requests, 2);
  assert.equal(result.verificationId, 'mainnet-verification');
});

test('mainnet source publication checks exact sources and produces mainnet explorer URLs', async t => {
  const { context } = fixture('closed', false, false, { chainId: 1 });
  context.directory = await mkdtemp(join(tmpdir(), '111k-mainnet-publication-'));
  t.after(() => rm(context.directory, { recursive: true, force: true }));
  context.artifact.bytecode = { object: '0x6000' };
  const published = {
    chainId: '1', address: context.manifest.contractAddress, match: 'exact_match', creationMatch: 'exact_match', runtimeMatch: 'exact_match',
    compilation: { fullyQualifiedName: 'src/NFT111K.sol:NFT111K', compilerVersion: context.artifact.metadata.compiler.version },
    deployment: { transactionHash: context.journal.actions.deploy.hash }, sources: context.input.sources,
    creationBytecode: { onchainBytecode: context.manifest.creationCode, recompiledBytecode: context.artifact.bytecode.object,
      transformationValues: { constructorArguments: context.manifest.constructorArgs } },
    runtimeBytecode: { onchainBytecode: context.runtime },
  };
  const sourcify = await sourceVerification(context, 'sourcify', 'verify', { request: async url => {
    assert.equal(url, `https://sourcify.dev/server/v2/contract/1/${context.manifest.contractAddress}?fields=all`);
    return Response.json(published);
  } });
  assert.equal(sourcify.chainId, 1);
  assert.equal(sourcify.url, `https://repo.sourcify.dev/1/${context.manifest.contractAddress}`);
  await assert.rejects(sourceVerification(context, 'sourcify', 'verify', {
    request: async () => Response.json({ ...published, chainId: '11155111' }),
  }));
  const etherscan = await sourceVerification(context, 'etherscan', 'verify', { apiKey: 'test-key', request: async input => {
    const url = new URL(input);
    assert.equal(url.searchParams.get('chainid'), '1');
    assert.equal(url.searchParams.get('action'), 'getsourcecode');
    return Response.json({ status: '1', result: [{ ContractName: 'NFT111K', CompilerVersion: 'v' + context.artifact.metadata.compiler.version,
      ConstructorArguments: '1234', SimilarMatch: '', ABI: '[]', SourceCode: JSON.stringify(context.input) }] });
  } });
  assert.equal(etherscan.chainId, 1);
  assert.equal(etherscan.url, `https://etherscan.io/address/${context.manifest.contractAddress}#code`);
});
