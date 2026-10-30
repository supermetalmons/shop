import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { ethereumAssetId } from '../shared/ethereum/protocol.ts';
import { encodeAbi, encodeCall, ETHEREUM_EVENT_TOPICS } from '../shared/ethereum/abi.ts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { ethereumReceiptIdsHash, ethereumTokenIdsHash } from '../shared/ethereum/crypto.ts';
import { ethereumApi, EthereumApiError } from '../src/ethereum/api.ts';
import { ethereumInventoryQueryKey, ethereumInventoryScope, ethereumInventoryView, toggleEthereumSelection } from '../src/ethereum/state.ts';
import { ethereumChainId, ethereumOperation } from '../src/ethereum/wallet.ts';
import { resolveAppRoute } from '../src/routes.ts';
import type { EthereumInventoryItem } from '../shared/ethereum/api.ts';
import type { EthereumSubmission } from '../src/ethereum/state.ts';
import type { EIP1193Provider, EthereumProviderListener } from '../src/wallet/injectedEthereumProviders.ts';

const owner = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const contract = '0x3333333333333333333333333333333333333333';
const config = resolveEthereum111kConfig({ contractAddress: contract });
const hash = `0x${'ab'.repeat(32)}`;

const mintOperation: EthereumSubmission = { scope: ethereumInventoryScope(config, owner)!, action: 'mint', submittedAt: 1,
  intent: { to: contract, data: encodeCall('mintCrates(uint256)', ['uint256'], [1]), value: `0x${BigInt(config.cratePriceWei).toString(16)}` } };
const mintLog = { address: contract,
  topics: [`0x${bytesToHex(keccak_256(new TextEncoder().encode('CratesPurchased(address,uint256,uint256,uint256)')))}`, encodeAbi(['address'], [owner])],
  data: encodeAbi(['uint256', 'uint256', 'uint256'], [111112, 1, config.cratePriceWei]) };

test('batch opening confirmation requires one complete ordered summary including the bonus artwork count', async t => {
  const ids = [...Array.from({ length: 14 }, (_, index) => String(111125 - index)), '116666'];
  const operation: EthereumSubmission = { ...mintOperation, action: 'unbox', intent: {
    to: contract, data: encodeCall('unboxCrates(uint256[])', ['uint256[]'], [ids]), value: '0x0',
  } };
  const summary = { address: contract, topics: [
    `0x${bytesToHex(keccak_256(new TextEncoder().encode('CratesUnboxed(address,bytes32,uint256,uint256)')))}`,
    encodeAbi(['address'], [owner]), ethereumTokenIdsHash(ids),
  ], data: encodeAbi(['uint256', 'uint256'], [1, 311]) };
  const individual = { address: contract, topics: [
    `0x${bytesToHex(keccak_256(new TextEncoder().encode('CrateUnboxed(uint256,address,uint256,uint256)')))}`,
    encodeAbi(['uint256'], [ids[0]]), encodeAbi(['address'], [owner]),
  ], data: encodeAbi(['uint256', 'uint256'], [1, 20]) };
  let logs = [individual];
  let confirmations = 1;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'confirmed', confirmations, items: [], burnedTokenIds: ids, logs }));
  assert.equal((await ethereumApi.confirm(hash, config, owner, undefined, operation)).status, 'pending');
  confirmations = 3;
  for (const invalid of [
    [individual],
    [{ ...summary, topics: [summary.topics[0], encodeAbi(['address'], [other]), summary.topics[2]] }],
    [{ ...summary, topics: [summary.topics[0], summary.topics[1], ethereumTokenIdsHash([...ids].reverse())] }],
    [{ ...summary, topics: [summary.topics[0], summary.topics[1], ethereumTokenIdsHash(ids.slice(1))] }],
    [{ ...summary, data: encodeAbi(['uint256', 'uint256'], [1, 300]) }],
    [{ ...summary, data: encodeAbi(['uint256', 'uint256'], [0, 311]) }],
    [{ ...summary, data: encodeAbi(['uint256', 'uint256'], [111000, 311]) }],
  ]) {
    logs = invalid;
    await assert.rejects(ethereumApi.confirm(hash, config, owner, undefined, operation),
      error => error instanceof EthereumApiError && error.code === 'operation-failed');
  }
  logs = [individual, summary];
  assert.equal((await ethereumApi.confirm(hash, config, owner, undefined, operation)).status, 'confirmed');
  logs = [summary, summary];
  await assert.rejects(ethereumApi.confirm(hash, config, owner, undefined, operation),
    error => error instanceof EthereumApiError && error.code === 'operation-ambiguous');
});

for (const action of ['mint', 'unbox', 'transfer', 'delivery', 'claim'] as const) {
  test(`${action} confirmation waits for finality before reporting a caught inner failure`, async t => {
    let confirmations = 1;
    t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'confirmed', confirmations, items: [], burnedTokenIds: [], logs: [] }));
    const operation = { ...mintOperation, action };
    assert.deepEqual(await ethereumApi.confirm(hash, config, owner, undefined, operation),
      { status: 'pending', confirmations: 1, items: [], burnedTokenIds: [] });
    confirmations = config.confirmationBlocks;
    await assert.rejects(ethereumApi.confirm(hash, config, owner, undefined, operation),
      error => error instanceof EthereumApiError && error.code === 'operation-failed');
  });
}

test('mint confirmation checks the event even when minted tokens have already moved', async t => {
  let logs = [mintLog];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'confirmed', confirmations: 3, items: [], burnedTokenIds: [], logs }));
  assert.equal((await ethereumApi.confirm(hash, config, owner, undefined, mintOperation)).status, 'confirmed');
  for (const invalidLogs of [
    [{ ...mintLog, topics: [mintLog.topics[0], encodeAbi(['address'], [other])] }],
    [{ ...mintLog, data: encodeAbi(['uint256', 'uint256', 'uint256'], [111112, 2, config.cratePriceWei]) }],
    [{ ...mintLog, data: encodeAbi(['uint256', 'uint256', 'uint256'], [111112, 1, 0]) }],
  ]) {
    logs = invalidLogs;
    await assert.rejects(ethereumApi.confirm(hash, config, owner, undefined, mintOperation),
      error => error instanceof EthereumApiError && error.code === 'operation-failed');
  }
});

test('discounted crate confirmation matches the saved discounted payment and quantity', async t => {
  const discounted = { ...mintOperation, intent: { ...mintOperation.intent!,
    data: encodeCall('mintCratesDiscounted(uint256,bytes32[])', ['uint256', 'bytes32[]'], [1, []]), value: '0x3' } };
  let logs = [{ ...mintLog, data: encodeAbi(['uint256', 'uint256', 'uint256'], [111112, 1, 3]) }];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'confirmed', confirmations: 3, items: [], burnedTokenIds: [], logs }));
  assert.equal((await ethereumApi.confirm(hash, config, owner, undefined, discounted)).status, 'confirmed');
  for (const [quantity, paid] of [[1, BigInt(config.cratePriceWei)], [2, 3]]) {
    logs = [{ ...mintLog, data: encodeAbi(['uint256', 'uint256', 'uint256'], [111112, quantity, paid]) }];
    await assert.rejects(ethereumApi.confirm(hash, config, owner, undefined, discounted),
      error => error instanceof EthereumApiError && error.code === 'operation-failed');
  }
});

test('multiple successful matching mints remain ambiguous instead of failing', async t => {
  let confirmations = 1;
  const logs = [111112, 111113].map((firstToken, index) => ({ ...mintLog, logIndex: `0x${index}`,
    data: encodeAbi(['uint256', 'uint256', 'uint256'], [firstToken, 1, config.cratePriceWei]) }));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'confirmed', confirmations, items: [], burnedTokenIds: [], logs }));
  assert.equal((await ethereumApi.confirm(hash, config, owner, undefined, mintOperation)).status, 'pending');
  confirmations = config.confirmationBlocks;
  await assert.rejects(ethereumApi.confirm(hash, config, owner, undefined, mintOperation),
    error => error instanceof EthereumApiError && error.code === 'operation-ambiguous');
});

test('receipt transfers and verified cancellations do not require minted items', async t => {
  const receiptId = '2000001';
  let logs = [{ address: contract, topics: [ETHEREUM_EVENT_TOPICS.Transfer, encodeAbi(['address'], [owner]),
    encodeAbi(['address'], [other]), encodeAbi(['uint256'], [receiptId])], data: '0x' }];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'confirmed', confirmations: 3, items: [], burnedTokenIds: [], logs }));
  const operation: EthereumSubmission = { ...mintOperation, action: 'transfer', intent: { to: contract,
    data: encodeCall('safeTransferFrom(address,address,uint256)', ['address', 'address', 'uint256'], [owner, other, receiptId]), value: '0x0' } };
  assert.equal((await ethereumApi.confirm(hash, config, owner, undefined, operation)).status, 'confirmed');
  logs = [];
  assert.equal((await ethereumApi.confirm(hash, config, owner, undefined,
    { ...operation, action: 'cancel', actionBeforeCancellation: 'transfer' })).status, 'confirmed');
});

test('missing event data or a legacy request keeps confirmation recoverable', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'confirmed', confirmations: 3, items: [], burnedTokenIds: [] }));
  await assert.rejects(ethereumApi.confirm(hash, config, owner, undefined, mintOperation),
    error => !(error instanceof EthereumApiError) && /invalid response/.test(String(error)));
  await assert.rejects(ethereumApi.confirm(hash, config, owner, undefined, { ...mintOperation, intent: undefined }), /missing its original request/);
});

function providerFixture() {
  let chainId = 1;
  let address = owner;
  const calls: string[] = [];
  const listeners = new Map<string, Set<EthereumProviderListener>>();
  const emit = (event: string, value: unknown) => { for (const listener of listeners.get(event) ?? []) listener(value); };
  const provider: EIP1193Provider = {
    request: async ({ method, params }) => {
      calls.push(method);
      if (method === 'eth_accounts') return [address];
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
      if (method === 'wallet_switchEthereumChain') {
        chainId = Number(BigInt((params as [{ chainId: string }])[0].chainId));
        emit('chainChanged', `0x${chainId.toString(16)}`);
        return null;
      }
      if (method === 'eth_sendTransaction') return hash;
      throw new Error(`Unexpected method ${method}`);
    },
    on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  return { provider, calls, listeners, emit,
    setAccount(next: string) { address = next; emit('accountsChanged', [next]); },
    snapshot: () => ({ address, provider }),
  };
}
function item(tokenId: string, kind: EthereumInventoryItem['kind'] = 'artwork'): EthereumInventoryItem {
  return { id: ethereumAssetId(config.chainId, contract, tokenId), tokenId, chainId: config.chainId, contractAddress: contract,
    owner, displayId: Number(tokenId), kind, name: `Artwork #${tokenId}`, image: 'data:image/svg+xml,%3Csvg/%3E' };
}

test('111k routes independently of Solana deployments and preserves its URL', () => {
  const route = resolveAppRoute({ pathname: '/111k_devnet' });
  assert.equal(route.kind, 'ethereum-drop');
  assert.equal(route.ethereumDropId, '111k_devnet');
  assert.equal(route.path, '/111k_devnet');
  assert.equal(route.drop, null);
  assert.equal(route.preorderId, null);
  assert.equal(route.replacementHref, null);
  assert.equal(resolveAppRoute({ pathname: '/' }).ethereumDropId, undefined);
});

test('Ethereum transactions switch network, recheck identity, and use the captured provider', async () => {
  const wallet = providerFixture();
  const operation = ethereumOperation(wallet.snapshot, config);
  assert.equal(await operation.send({ to: contract, data: '0x12345678', value: '0x0', chainId: config.chainId }), hash);
  assert.equal(wallet.calls.filter(method => method === 'eth_sendTransaction').length, 1);
  assert.ok(wallet.calls.indexOf('wallet_switchEthereumChain') < wallet.calls.indexOf('eth_sendTransaction'));
  assert.equal(wallet.calls.filter(method => method === 'eth_accounts').length, 2);
  operation.dispose();
  assert.equal([...wallet.listeners.values()].reduce((sum, set) => sum + set.size, 0), 0);
});

test('wallet cancellation never sends a transaction', async () => {
  const wallet = providerFixture();
  const original = wallet.provider.request;
  wallet.provider.request = async args => {
    if (args.method === 'wallet_switchEthereumChain') throw Object.assign(new Error('Cancelled'), { code: 4001 });
    return original(args);
  };
  const operation = ethereumOperation(wallet.snapshot, config);
  await assert.rejects(operation.send({ to: contract, data: '0x', value: '0x0', chainId: config.chainId }), /Cancelled/);
  assert.ok(!wallet.calls.includes('eth_sendTransaction'));
  operation.dispose();
});

test('account replacement, disconnect and unexpected chain changes cancel captured intent', async () => {
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
    const wallet = providerFixture();
    const operation = ethereumOperation(wallet.snapshot, config);
    await operation.ensureNetwork();
    if (event === 'accountsChanged') wallet.setAccount(other);
    else wallet.emit(event, event === 'chainChanged' ? '0x1' : undefined);
    assert.throws(operation.assertCurrent, /wallet changed/);
    await assert.rejects(operation.send({ to: contract, data: '0x', value: '0x0', chainId: config.chainId }));
    assert.ok(!wallet.calls.includes('eth_sendTransaction'));
    operation.dispose();
  }
});

test('transaction and config validation reject unrelated networks and unsafe local RPC settings', async t => {
  const wallet = providerFixture();
  const operation = ethereumOperation(wallet.snapshot, config);
  await assert.rejects(operation.send({ to: contract, data: '0x', value: '0x0', chainId: 1 }), /network/);
  operation.dispose();
  let response = { ...config, chainId: 1 };
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  await assert.rejects(ethereumApi.config());
  response = { ...config, walletRpcUrl: 'http://untrusted.example' };
  await assert.rejects(ethereumApi.config());
  response = { ...config, chainId: 31337, walletRpcUrl: 'http://untrusted.example' };
  await assert.rejects(ethereumApi.config());
  response = { ...config, walletRpcUrl: 'http://[::1]:8545' };
  await assert.rejects(ethereumApi.config());
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    response = resolveEthereum111kConfig({ chainId: 31337, contractAddress: contract, walletRpcUrl: `http://${host}:8545` });
    assert.equal((await ethereumApi.config()).walletRpcUrl, response.walletRpcUrl);
  }
  response = config;
  assert.equal((await ethereumApi.config()).chainId, 11155111);
  assert.equal(ethereumChainId('0xaa36a7'), 11155111);
  assert.equal(ethereumChainId('11155111'), null);
});

test('Ethereum inventory isolates chain, contract and owner, without changing NFT display numbers', async t => {
  const scope = ethereumInventoryScope(config, owner)!;
  assert.notDeepEqual(ethereumInventoryQueryKey(scope), ethereumInventoryQueryKey(ethereumInventoryScope(config, other)));
  assert.notEqual(scope, ethereumInventoryScope({ ...config, chainId: 31337 }, owner));
  assert.notEqual(scope, ethereumInventoryScope({ ...config, contractAddress: other }, owner));
  const artwork = { ...item('123'), displayId: 841 };
  const view = ethereumInventoryView(artwork);
  assert.equal(view.dudeId, 841);
  assert.equal(view.ethereum.tokenId, '123');
  assert.equal(view.id, ethereumAssetId(config.chainId, contract, '123'));
  let response = { ...artwork, owner: other };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ items: [response], nextCursor: null, observedBlock: 1 }));
  await assert.rejects(ethereumApi.inventory(config, owner, null));
  response = { ...artwork, chainId: 1 };
  await assert.rejects(ethereumApi.inventory(config, owner, null));
});

test('Ethereum inventory and confirmations preserve metadata while container previews use dimensioned overrides', async t => {
  const artwork = { ...item('1'), name: 'Updated artwork #1', description: '',
    image: 'https://future-cdn.example/artwork.webp', attributes: [{ trait_type: 'type', value: 'artwork' }] };
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    items: [artwork], nextCursor: null, observedBlock: 1, status: 'confirmed', confirmations: 3, burnedTokenIds: [],
  }));
  assert.deepEqual((await ethereumApi.inventory(config, owner, null)).items, [artwork]);
  assert.deepEqual((await ethereumApi.confirm(hash, config, owner)).items, [artwork]);
  assert.deepEqual(ethereumInventoryView(artwork).attributes, artwork.attributes);
  for (const kind of ['artwork', 'artwork_receipt', 'crate_receipt', 'reliquary'] as const) {
    const view = ethereumInventoryView({ ...artwork, kind });
    assert.equal(view.image, artwork.image);
    assert.equal(view.imageDimensions, undefined);
  }
  for (const container of [
    { kind: 'crate', width: 1218, height: 833 },
    { kind: 'warehouse', width: 1254, height: 1104 },
  ] as const) {
    const view = ethereumInventoryView({ ...artwork, kind: container.kind });
    assert.equal(view.image, `https://wip.lil.org/111k/${container.kind}_clean.webp`);
    assert.deepEqual(view.imageDimensions, { width: container.width, height: container.height });
    assert.equal(view.ethereum.image, artwork.image);
  }
  for (const image of ['http://wip.lil.org/artwork.webp', 'https://user@wip.lil.org/artwork.webp', 'javascript:alert(1)']) {
    artwork.image = image;
    await assert.rejects(ethereumApi.inventory(config, owner, null), /invalid response/);
    await assert.rejects(ethereumApi.confirm(hash, config, owner), /invalid response/);
  }
});

test('Ethereum inventory reads all live and rollback IDs in two parallel bounded requests', async t => {
  const liveIds = Array.from({ length: 100 }, (_, index) => String(index + 1));
  const rollbackIds = Array.from({ length: 100 }, (_, index) => String(index + 1001));
  const controller = new AbortController();
  const requests: Array<{ url: URL; signal: AbortSignal; resolve: (response: Response) => void }> = [];
  t.mock.method(globalThis, 'fetch', (input, init) => new Promise<Response>(resolve => {
    requests.push({ url: new URL(String(input)), signal: init!.signal!, resolve });
  }));
  const response = ethereumApi.inventory(config, owner, null, controller.signal,
    [...liveIds, ...rollbackIds, liveIds[0], rollbackIds[0]]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(entry => entry.url.searchParams.get('expectedTokenIds')?.split(',')), [liveIds, rollbackIds]);
  for (const entry of requests) {
    assert.equal(entry.url.pathname, '/ethereum/111k/inventory');
    assert.equal(entry.url.searchParams.get('owner'), owner);
    assert.equal(entry.url.searchParams.has('cursor'), false);
  }
  const indexed = item('9999');
  requests[1].resolve(Response.json({ items: [indexed, ...rollbackIds.map(id => item(id))], nextCursor: 'second-cursor', observedBlock: 21 }));
  requests[0].resolve(Response.json({ items: [indexed, ...liveIds.map(id => item(id))], nextCursor: 'first-cursor', observedBlock: 20 }));
  const result = await response;
  assert.equal(result.items.length, 201);
  assert.deepEqual(new Set(result.items.map(entry => entry.tokenId)), new Set(['9999', ...liveIds, ...rollbackIds]));
  assert.equal(result.nextCursor, 'first-cursor');
  assert.equal(result.observedBlock, 20);
  controller.abort();
  assert.ok(requests.every(entry => entry.signal.aborted));
});

test('a reliquary opening recovers all 111 crates across the inventory request boundary', async t => {
  const crates = Array.from({ length: 111 }, (_, index) => ({
    ...item(String(111112 + index), 'crate'), displayId: index + 1, name: `Crate #${index + 1}`,
  }));
  const requested: string[][] = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(String(input));
    const ids = url.searchParams.get('expectedTokenIds')!.split(',');
    requested.push(ids);
    return Response.json({ items: crates.filter(crate => ids.includes(crate.tokenId)), nextCursor: null, observedBlock: 42 });
  });
  const result = await ethereumApi.inventory(config, owner, null, undefined, crates.map(crate => crate.tokenId));
  assert.deepEqual(requested.map(ids => ids.length), [100, 11]);
  assert.deepEqual(requested.flat(), crates.map(crate => crate.tokenId));
  assert.deepEqual(result.items, crates);
  assert.equal(result.observedBlock, 42);
});

test('Ethereum inventory cursor pages use one request without repeating expected IDs', async t => {
  const requests: URL[] = [];
  t.mock.method(globalThis, 'fetch', async input => {
    requests.push(new URL(String(input)));
    return Response.json({ items: [item('151')], nextCursor: null, observedBlock: 22 });
  });
  const result = await ethereumApi.inventory(config, owner, 'page-two', undefined,
    Array.from({ length: 200 }, (_, index) => String(index + 1)));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('cursor'), 'page-two');
  assert.equal(requests[0].searchParams.has('expectedTokenIds'), false);
  assert.deepEqual(result.items.map(entry => entry.tokenId), ['151']);
  assert.equal(result.nextCursor, null);
});

test('Ethereum inventory reads one thousand expected IDs with at most two requests running', async t => {
  const ids = Array.from({ length: 1000 }, (_, index) => String(index + 1));
  const chunks: string[][] = [];
  let active = 0;
  let maximum = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    const chunk = new URL(String(input)).searchParams.get('expectedTokenIds')!.split(',');
    chunks.push(chunk);
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 0));
    active--;
    return Response.json({ items: [item('9999'), ...chunk.map(id => item(id))], nextCursor: 'next', observedBlock: 20 });
  });
  const result = await ethereumApi.inventory(config, owner, null, undefined, [...ids, ids[0]]);
  assert.equal(maximum, 2);
  assert.equal(chunks.length, 10);
  assert.ok(chunks.every(chunk => chunk.length === 100));
  assert.deepEqual(chunks.flat(), ids);
  assert.equal(result.items.length, 1001);
  assert.equal(result.nextCursor, 'next');
});

test('aborting expected-ID inventory stops before another chunk starts', async t => {
  const controller = new AbortController();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    requests++;
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  });
  const inventory = ethereumApi.inventory(config, owner, null, controller.signal,
    Array.from({ length: 311 }, (_, index) => String(index + 1)));
  assert.equal(requests, 2);
  controller.abort();
  await assert.rejects(inventory, /abort/i);
  assert.equal(requests, 2);
});

test('Ethereum inventory validates supplemental ownership and rejects excess IDs without truncation', async t => {
  const ids = Array.from({ length: 1001 }, (_, index) => String(index + 1));
  const fetch = t.mock.method(globalThis, 'fetch', async input => {
    const expected = new URL(String(input)).searchParams.get('expectedTokenIds')!.split(',');
    return Response.json({ items: [{ ...item(expected[0]), owner: expected[0] === '101' ? other : owner }],
      nextCursor: null, observedBlock: 20 });
  });
  await assert.rejects(ethereumApi.inventory(config, owner, null, undefined, ids), /Too many expected/);
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(ethereumApi.inventory(config, owner, null, undefined, ids.slice(0, 200)), /invalid response/);
  assert.equal(fetch.mock.callCount(), 2);
});

test('Ethereum selection caps delivery at 50 and keeps warehouses separate from shippable items', () => {
  const rows = Array.from({ length: 51 }, (_, index) => item(String(index + 1)));
  const warehouse = item('116667', 'warehouse');
  const receipt = item('1000001', 'artwork_receipt');
  const index = new Map([...rows, warehouse, receipt].map(row => [row.id, row]));
  const selected = new Set(rows.slice(0, 50).map(row => row.id));
  assert.equal(toggleEthereumSelection(selected, rows[50], index, 50).size, 50);
  assert.deepEqual([...toggleEthereumSelection(selected, warehouse, index, 50)], [warehouse.id]);
  assert.deepEqual([...toggleEthereumSelection(new Set([warehouse.id]), rows[0], index, 50)], [rows[0].id]);
  assert.equal(toggleEthereumSelection(selected, receipt, index, 50).size, 50);
});

test('delivery authorization bytes must match the selected IDs, wallet, order, signature and exact fee', async () => {
  const { checkedEthereumDelivery } = await import('../src/ethereum/prepared.ts');
  const { encodeCall } = await import('../shared/ethereum/abi.ts');
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const signature = `0x${'ab'.repeat(65)}`;
  const selected = [item('1'), item('2')];
  const receiptIdsHash = ethereumReceiptIdsHash(['1000001', '1000002']);
  const quote = { orderId: 42, wallet: owner, fee: config.deliveryFeeWei, deadline, receiptIdsHash };
  const prepared = { orderId: 42, quote, expiresAtMs: deadline * 1000, signature,
    transaction: { chainId: config.chainId, to: contract, value: `0x${BigInt(config.deliveryFeeWei).toString(16)}`,
      data: encodeCall('redeemForDelivery(uint256[],(uint256,address,uint256,uint256,bytes32),bytes)', ['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'], [['1', '2'], [42, owner, config.deliveryFeeWei, deadline, receiptIdsHash], signature]) } };
  assert.equal(checkedEthereumDelivery(prepared, config, owner, selected), prepared.transaction);
  assert.throws(() => checkedEthereumDelivery(prepared, config, owner, [...selected].reverse()), /does not match/);
  assert.throws(() => checkedEthereumDelivery({ ...prepared, quote: { ...quote, wallet: other } }, config, owner, selected), /wallet or fee/);
  assert.throws(() => checkedEthereumDelivery({ ...prepared, signature: `0x${'cd'.repeat(65)}` }, config, owner, selected), /does not match/);
  assert.throws(() => checkedEthereumDelivery({ ...prepared, transaction: { ...prepared.transaction, value: '0x1' } }, config, owner, selected), /does not match/);
  assert.throws(() => checkedEthereumDelivery(prepared, config, owner, [{ ...selected[0], displayId: 3 }, selected[1]]), /selected items/);
  assert.throws(() => checkedEthereumDelivery(prepared, config, owner, [{ ...selected[0], kind: 'crate' }, selected[1]]), /selected items/);
  assert.throws(() => checkedEthereumDelivery({ ...prepared, quote: { ...quote, receiptIdsHash: ethereumReceiptIdsHash(['1000002', '1000001']) } }, config, owner, selected), /selected items/);
});

test('only authenticated 401 responses identify the session token to invalidate', async t => {
  const session = { token: 'rejected-token', address: owner, chainId: config.chainId, dropId: config.dropId, expiresAtMs: Date.now() + 60_000 };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'Expired' }, { status: 401 }));
  await assert.rejects(ethereumApi.profile(session), cause => cause instanceof EthereumApiError && cause.rejectedSessionToken === session.token);
  await assert.rejects(ethereumApi.challenge(owner, config), cause => cause instanceof EthereumApiError && cause.rejectedSessionToken === null);
});

test('crate claims reject another receipt, mismatched calldata and expired authorization', async () => {
  const { checkedEthereumClaim } = await import('../src/ethereum/prepared.ts');
  const { encodeCall } = await import('../shared/ethereum/abi.ts');
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const signature = `0x${'ab'.repeat(65)}`;
  const claimId = `0x${'cd'.repeat(32)}`;
  const prepared = { receiptId: '2000001', claimId, deadline, expiresAtMs: deadline * 1000, signature,
    transaction: { chainId: config.chainId, to: contract, value: '0x0',
      data: encodeCall('claimCrateReceipt(uint256,bytes32,uint256,bytes)', ['uint256', 'bytes32', 'uint256', 'bytes'], ['2000001', claimId, deadline, signature]) } };
  assert.equal(checkedEthereumClaim(prepared, config, '2000001'), prepared.transaction);
  assert.throws(() => checkedEthereumClaim(prepared, config, '2000002'), /does not match/);
  assert.throws(() => checkedEthereumClaim({ ...prepared, transaction: { ...prepared.transaction, data: '0x' } }, config, '2000001'), /does not match/);
  assert.throws(() => checkedEthereumClaim({ ...prepared, expiresAtMs: Date.now() - 1 }, config, '2000001'), /expired/);
});

test('replacement recovery verifies sender, nonce, chain and the exact original intent', async () => {
  const { recoverEthereumTransaction } = await import('../src/ethereum/recovery.ts');
  const replacementHash = `0x${'cd'.repeat(32)}`;
  const intent = { to: contract, data: '0x12345678', value: '0x123' };
  const pending = { scope: ethereumInventoryScope(config, owner)!, hash, action: 'mint' as const, submittedAt: Date.now(), nonce: '0x7', intent };
  let candidate = { hash: replacementHash, from: owner, to: contract, input: intent.data, value: intent.value, nonce: '0x7', chainId: '0xaa36a7' };
  const provider: EIP1193Provider = { request: async () => candidate };
  const args = { provider, config, owner, pending, transactionHash: replacementHash, assertCurrent() {} };
  const replacement = await recoverEthereumTransaction(args);
  assert.equal(replacement.hash, replacementHash);
  assert.equal(replacement.action, 'mint');
  candidate = { ...candidate, nonce: '0x8' };
  await assert.rejects(recoverEthereumTransaction(args), /does not replace/);
  candidate = { ...candidate, nonce: '0x7', value: '0x456' };
  await assert.rejects(recoverEthereumTransaction(args), /changes the original/);
  candidate = { ...candidate, value: intent.value, from: other };
  await assert.rejects(recoverEthereumTransaction(args), /wallet or network/);
  candidate = { ...candidate, from: owner, chainId: '0x1' };
  await assert.rejects(recoverEthereumTransaction(args), /wallet or network/);
});

test('replacement recovery can recover the original nonce and recognizes only a matching self-transfer as cancellation', async () => {
  const { recoverEthereumTransaction } = await import('../src/ethereum/recovery.ts');
  const replacementHash = `0x${'cd'.repeat(32)}`;
  const original = { hash, from: owner, to: contract, input: '0x12345678', value: '0x123', nonce: '0x7', chainId: '0xaa36a7' };
  const candidate = { ...original, hash: replacementHash, to: owner, input: '0x', value: '0x0' };
  const provider: EIP1193Provider = { request: async ({ params }) => (params as string[])[0] === hash ? original : candidate };
  const pending = { scope: ethereumInventoryScope(config, owner)!, hash, action: 'mint' as const, submittedAt: Date.now() };
  const replacement = await recoverEthereumTransaction({ provider, config, owner, pending, transactionHash: replacementHash, assertCurrent() {} });
  assert.equal(replacement.action, 'cancel');
  assert.equal(replacement.nonce, '0x7');
  assert.equal(replacement.actionBeforeCancellation, 'mint');
  const resumedHash = `0x${'ef'.repeat(32)}`;
  provider.request = async () => ({ ...original, hash: resumedHash });
  const resumed = await recoverEthereumTransaction({ provider, config, owner, pending: replacement, transactionHash: resumedHash, assertCurrent() {} });
  assert.equal(resumed.action, 'mint');
  provider.request = async () => null;
  await assert.rejects(recoverEthereumTransaction({ provider, config, owner, pending, transactionHash: replacementHash, assertCurrent() {} }), /cannot be verified/);
});

test('a local address encryption public key is accepted only in development on chain 31337', async () => {
  const { ethereumAddressEncryptionKey } = await import('../src/ethereum/addressEncryption.ts');
  assert.equal(ethereumAddressEncryptionKey('production', 31337, true, ' local '), 'local');
  assert.equal(ethereumAddressEncryptionKey('production', 11155111, true, 'local'), 'production');
  assert.equal(ethereumAddressEncryptionKey('production', 31337, false, 'local'), 'production');
  assert.equal(ethereumAddressEncryptionKey('production', 31337, true, undefined), 'production');
});
