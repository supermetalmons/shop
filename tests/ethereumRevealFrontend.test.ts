import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement, type PropsWithChildren } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { installBrowserLocks } from './helpers/browserLocks.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { encodeCall } from '../shared/ethereum/abi.ts';
import { ETHEREUM_FUNCTIONS, ethereumAssetId, type EthereumInventoryItem } from '../shared/ethereum/protocol.ts';
import { ETHEREUM_REVEAL_MAX_TOKEN_IDS, type EthereumRevealedArtwork, type EthereumRevealTransactionResponse } from '../shared/ethereum/reveal.ts';
import type { EthereumPendingTransaction } from '../src/ethereum/state.ts';

let environment = setupFrontendDom();
const { act, cleanup, fireEvent, render, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider, focusManager, onlineManager } = await import('@tanstack/react-query');
const { ethereumRevealApi, EthereumRevealApiError } = await import('../src/ethereum/revealApi.ts');
const { parseEthereumInventoryItem } = await import('../src/ethereum/api.ts');
const { useEthereumReveals } = await import('../src/ethereum/useEthereumReveals.ts');
const { EthereumArtworkMedia } = await import('../src/ethereum/EthereumArtworkMedia.tsx');
const { ethereumInventoryScope, ethereumInventoryView, forgetEthereumRevealJob, readEthereumRevealJobs, rememberEthereumRevealJob, writeEthereumStorage } = await import('../src/ethereum/state.ts');
environment.dom.window.close();

const owner = `0x${'11'.repeat(20)}`;
const contract = `0x${'33'.repeat(20)}`;
const hash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const config = resolveEthereum111kConfig({ contractAddress: contract });
const scope = ethereumInventoryScope(config, owner)!;
const responseScope = { chainId: config.chainId, contractAddress: contract, dropId: config.dropId, deploymentId: 'test-deployment' };
const clients: InstanceType<typeof QueryClient>[] = [];

beforeEach(context => {
  const t = context as TestContext;
  environment = setupFrontendDom();
  installBrowserLocks(t);
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'play', async () => {});
  t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'pause', () => {});
});
afterEach(async () => {
  await act(async () => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  environment.dom.window.close();
});

function setPageVisibility(visibility: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
  Object.defineProperty(document, 'hidden', { configurable: true, value: visibility === 'hidden' });
  document.dispatchEvent(new window.Event('visibilitychange', { bubbles: true }));
  assert.equal(focusManager.isFocused(), visibility === 'visible');
}

async function waitWithRenders(milliseconds: number) {
  for (let remaining = milliseconds; remaining > 0; remaining -= 100) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining))); });
  }
}

function artwork(tokenId = '1', category: EthereumRevealedArtwork['category'] = 'painting'): EthereumRevealedArtwork {
  return { tokenId, crateTokenId: '111112', category, name: `Artwork ${tokenId}`,
    image: `https://wip.lil.org/reveal-test/${tokenId}.webp`, aspectRatio: { width: 1080, height: 1920 },
    ...(category === 'video' ? { animation_url: `https://wip.lil.org/reveal-test/${tokenId}.mp4` } : {}),
    attributes: [{ trait_type: 'type', value: category }], observation: { transactionHash: hash, blockNumber: 101, blockHash } };
}
function item(tokenId = '1'): EthereumInventoryItem {
  return { tokenId, id: ethereumAssetId(config.chainId, contract, tokenId), chainId: config.chainId,
    contractAddress: contract, kind: 'artwork', displayId: Number(tokenId), owner, name: tokenId,
    image: 'https://wip.lil.org/111k/artwork_placeholder.png', revealStatus: 'unrevealed' };
}
function pending(): EthereumPendingTransaction {
  return { scope, hash, action: 'unbox', submittedAt: 1, intent: {
    to: contract, data: encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], ['111112']), value: '0x0',
  } };
}
function transactionResponse(status: EthereumRevealTransactionResponse['status'] = 'pending', artworks: EthereumRevealedArtwork[] = []): EthereumRevealTransactionResponse {
  return { ...responseScope, status, artworks, retryAfterMs: 2000 };
}
function mockPending(t: TestContext) {
  const transaction = t.mock.method(ethereumRevealApi, 'transaction', async () => transactionResponse());
  const tokens = t.mock.method(ethereumRevealApi, 'tokens', async (_config, tokenIds) => ({ ...responseScope,
    artworks: [], unresolved: tokenIds.map(tokenId => ({ tokenId, status: 'recovering' as const })), retryAfterMs: 2000 }));
  return { transaction, tokens };
}
function harness(initial: Partial<{ config: typeof config; scope: string | null; items: EthereumInventoryItem[]; pending: EthereumPendingTransaction | null }> = {},
  onRevealed: (hash: string, artworks: EthereumRevealedArtwork[]) => void = () => {},
  options: { gcTime?: number; client?: InstanceType<typeof QueryClient> } = {}) {
  const client = options.client ?? new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: options.gcTime ?? Infinity } } });
  if (!options.client) clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const props = { config, scope: scope as string | null, items: [] as EthereumInventoryItem[], pending: null as EthereumPendingTransaction | null, ...initial };
  if (props.scope && props.pending) writeEthereumStorage(`${props.scope}:pending`, props.pending);
  const view = renderHook(current => useEthereumReveals(current.config, current.scope, current.items, current.pending, onRevealed),
    { initialProps: props, wrapper });
  return { ...view, client, update(next: Partial<typeof props>) {
    Object.assign(props, next);
    if (props.scope && 'pending' in next) writeEthereumStorage(`${props.scope}:pending`, props.pending);
    view.rerender({ ...props });
  } };
}

test('artwork requests carry deployment identity and CSRF without requesting a wallet signature', async t => {
  const requests: Array<{ path: string; body: unknown }> = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body));
    requests.push({ path, body });
    assert.equal(init?.method, 'POST');
    assert.equal(init?.cache, 'no-store');
    assert.equal(new Headers(init?.headers).get('X-Mons-CSRF'), '1');
    return Response.json(path.endsWith('/transaction') ? transactionResponse('revealed', [artwork('1', 'video')]) : {
      ...responseScope, artworks: [artwork()], unresolved: [{ tokenId: '2', status: 'unminted' }], retryAfterMs: 2000,
    });
  });
  assert.equal((await ethereumRevealApi.transaction(config, hash)).artworks[0].animation_url, artwork('1', 'video').animation_url);
  assert.equal((await ethereumRevealApi.tokens(config, ['1', '2', '1'])).unresolved[0].status, 'unminted');
  assert.deepEqual(requests, [
    { path: '/ethereum/111k/reveal/transaction', body: { chainId: config.chainId, contractAddress: contract, transactionHash: hash } },
    { path: '/ethereum/111k/reveal/tokens', body: { chainId: config.chainId, contractAddress: contract, tokenIds: ['1', '2'] } },
  ]);
});

for (const status of ['pending', 'reverted', 'not_unpack'] as const) test(`${status} artwork responses cannot smuggle media into the client`, async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(transactionResponse(status, [artwork()])));
  await assert.rejects(ethereumRevealApi.transaction(config, hash), /invalid response/);
});

test('artwork response validation rejects foreign scopes, unsafe media, malformed dimensions and missing observation', async t => {
  let value: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(value));
  for (const update of [
    { chainId: 1 }, { contractAddress: owner }, { deploymentId: '' }, { retryAfterMs: -1 },
    { artworks: [{ ...artwork(), image: 'http://wip.lil.org/art.webp' }] },
    { artworks: [{ ...artwork('1', 'video'), animation_url: 'https://user:secret@wip.lil.org/a.mp4' }] },
    { artworks: [{ ...artwork('1', 'video'), animation_url: undefined }] },
    { artworks: [{ ...artwork(), aspectRatio: { width: 0, height: 12 } }] },
    { artworks: [{ ...artwork(), aspectRatio: { width: 12, height: Infinity } }] },
    { artworks: [{ ...artwork(), observation: undefined }] },
    { artworks: [{ ...artwork(), observation: { ...artwork().observation, blockHash: 'wrong' } }] },
    { artworks: [artwork(), artwork()] },
  ]) {
    value = { ...transactionResponse('revealed', [artwork()]), ...update };
    await assert.rejects(ethereumRevealApi.transaction(config, hash), /invalid response/);
  }
});

test('token recovery rejects missing, duplicated or unrequested token results', async t => {
  let value: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(value));
  for (const update of [
    { artworks: [], unresolved: [] },
    { artworks: [artwork()], unresolved: [{ tokenId: '1', status: 'recovering' }] },
    { artworks: [artwork('3')], unresolved: [{ tokenId: '2', status: 'recovering' }] },
    { artworks: [artwork()], unresolved: [{ tokenId: '2', status: 'revealed' }] },
  ]) {
    value = { ...responseScope, retryAfterMs: 2000, ...update };
    await assert.rejects(ethereumRevealApi.tokens(config, ['1', '2']), /invalid response/);
  }
});

test('reveal validates requests before fetching and accepts the full bonus unpack result', async t => {
  const requests = t.mock.method(globalThis, 'fetch', async () => Response.json(transactionResponse('revealed',
    Array.from({ length: 311 }, (_, index) => artwork(String(index + 1))))));
  await assert.rejects(ethereumRevealApi.tokens(config, []));
  await assert.rejects(ethereumRevealApi.tokens(config, ['0']));
  await assert.rejects(ethereumRevealApi.tokens(config, ['111112']));
  await assert.rejects(ethereumRevealApi.tokens(config, Array.from({ length: ETHEREUM_REVEAL_MAX_TOKEN_IDS + 1 }, (_, index) => String(index + 1))));
  await assert.rejects(ethereumRevealApi.transaction(config, 'invalid'));
  assert.equal(requests.mock.callCount(), 0);
  assert.equal((await ethereumRevealApi.transaction(config, hash)).artworks.length, 311);
});

test('artwork rate limits preserve the server retry delay', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'Try again later.' } },
    { status: 429, headers: { 'Retry-After': '75' } }));
  await assert.rejects(ethereumRevealApi.transaction(config, hash), error =>
    error instanceof EthereumRevealApiError && error.status === 429 && error.retryAfterMs === 75000);
});

test('restored unpack jobs remain private and survive confirmation clearing the pending transaction', async t => {
  const mocks = mockPending(t);
  const view = harness({ pending: pending() });
  await waitFor(() => assert.equal(mocks.transaction.mock.callCount(), 1));
  assert.deepEqual(readEthereumRevealJobs(scope).map(({ trackingId: _, ...job }) => job), [{ transactionHash: hash, submittedAt: 1, crateTokenIds: ['111112'] }]);
  assert.equal(view.result.current.applyArtwork(item()).image, item().image);
  view.update({ pending: null });
  assert.equal(readEthereumRevealJobs(scope).length, 1);
  assert.equal(mocks.tokens.mock.callCount(), 0);
  const saved = window.localStorage.getItem(`ethereum111k:${scope}:reveal-job:v2:${hash}`)!;
  assert.ok(saved.includes(hash));
  assert.ok(!saved.includes('wip.lil.org'));
});

test('stale pending UI state cannot recreate an explicitly removed reveal job', async t => {
  const mocks = mockPending(t);
  const operation = pending();
  const view = harness({ pending: operation });
  await waitFor(() => assert.equal(mocks.transaction.mock.callCount(), 1));
  act(() => {
    writeEthereumStorage(`${scope}:pending`, null);
    forgetEthereumRevealJob(scope, hash);
  });
  view.rerender({ config, scope, items: [], pending: { ...operation } });
  await act(async () => {});
  assert.deepEqual(readEthereumRevealJobs(scope), []);
  assert.equal(mocks.transaction.mock.callCount(), 1);
});

for (const status of ['reverted', 'not_unpack'] as const) test(`a generation adopted from another tab revalidates a cached ${status} result`, async t => {
  mockPending(t);
  let ready = false;
  const requests = t.mock.method(ethereumRevealApi, 'transaction', async () => transactionResponse(ready ? 'pending' : status));
  rememberEthereumRevealJob(scope, hash, 1);
  const first = readEthereumRevealJobs(scope)[0];
  const view = harness();
  await waitFor(() => assert.deepEqual(readEthereumRevealJobs(scope), []));
  assert.equal(requests.mock.callCount(), 1);
  const otherHash = `0x${'ee'.repeat(32)}`;
  ready = true;
  act(() => {
    rememberEthereumRevealJob(scope, otherHash, 2);
    forgetEthereumRevealJob(scope, otherHash);
    rememberEthereumRevealJob(scope, hash, 3);
  });
  await waitFor(() => assert.equal(requests.mock.callCount(), 2));
  await waitFor(() => assert.equal(view.client.getQueryState<EthereumRevealTransactionResponse>(['ethereum111k', 'reveal-transaction', config.chainId, contract, hash])?.data?.status, 'pending'));
  const current = readEthereumRevealJobs(scope)[0];
  assert.equal(current.transactionHash, hash);
  assert.notEqual(current.trackingId, first.trackingId);
});

test('a generation adopted from another tab cancels the earlier in-flight request before retrying', async t => {
  mockPending(t);
  const late = Promise.withResolvers<EthereumRevealTransactionResponse>();
  const signals: AbortSignal[] = [];
  const requests = t.mock.method(ethereumRevealApi, 'transaction', (_config, _hash, signal) => {
    signals.push(signal!);
    return signals.length === 1 ? late.promise : Promise.resolve(transactionResponse());
  });
  rememberEthereumRevealJob(scope, hash, 1);
  const first = readEthereumRevealJobs(scope)[0];
  const view = harness();
  await waitFor(() => assert.equal(requests.mock.callCount(), 1));
  act(() => {
    forgetEthereumRevealJob(scope, hash, first.trackingId);
    rememberEthereumRevealJob(scope, hash, 2);
  });
  await waitFor(() => assert.equal(requests.mock.callCount(), 2));
  assert.equal(signals[0].aborted, true);
  await act(async () => { late.resolve(transactionResponse('reverted')); });
  const current = readEthereumRevealJobs(scope)[0];
  assert.equal(current.transactionHash, hash);
  assert.notEqual(current.trackingId, first.trackingId);
  assert.equal(view.client.getQueryState<EthereumRevealTransactionResponse>(['ethereum111k', 'reveal-transaction', config.chainId, contract, hash])?.data?.status, 'pending');
});

test('a new generation revalidates a revealed transaction output set while retaining frozen token media', async t => {
  mockPending(t);
  let tokenId = '1';
  const requests = t.mock.method(ethereumRevealApi, 'transaction', async () => transactionResponse('revealed',
    [...(tokenId === '1' ? [] : [{ ...artwork('1'), crateTokenId: '111113' }]), artwork(tokenId)]));
  const shown: string[][] = [];
  rememberEthereumRevealJob(scope, hash, 1, pending());
  const view = harness({}, (_hash, artworks) => { shown.push(artworks.map(value => value.tokenId)); });
  await waitFor(() => assert.deepEqual(readEthereumRevealJobs(scope), []));
  tokenId = '2';
  act(() => rememberEthereumRevealJob(scope, hash, 2, pending()));
  await waitFor(() => assert.equal(requests.mock.callCount(), 2));
  await waitFor(() => assert.deepEqual(shown, [['1'], ['2']]));
  assert.equal(view.result.current.applyArtwork(item('1')).image, artwork('1').image);
  assert.equal(view.result.current.applyArtwork(item('2')).image, artwork('2').image);
});

test('new tracking submits once while hidden without restarting unchanged generations', async t => {
  mockPending(t);
  const requests = t.mock.method(ethereumRevealApi, 'transaction', async () => transactionResponse());
  rememberEthereumRevealJob(scope, hash, 1);
  const first = readEthereumRevealJobs(scope)[0];
  const view = harness();
  const key = ['ethereum111k', 'reveal-transaction', config.chainId, contract, hash];
  await waitFor(() => assert.equal(view.client.getQueryState(key)?.status, 'success'));
  act(() => setPageVisibility('hidden'));
  act(() => {
    forgetEthereumRevealJob(scope, hash, first.trackingId);
    rememberEthereumRevealJob(scope, hash, 2);
  });
  await waitFor(() => assert.equal(requests.mock.callCount(), 2));
  await waitFor(() => assert.equal(view.client.getQueryState(key)?.status, 'success'));
  const generation = readEthereumRevealJobs(scope)[0].trackingId;
  view.unmount();
  const restored = harness({}, undefined, { client: view.client });
  await act(async () => {});
  assert.equal(readEthereumRevealJobs(scope)[0].trackingId, generation);
  assert.equal(requests.mock.callCount(), 2);
  restored.unmount();
});

test('a saved hash resumes after remount and revealed media overlays stale inventory without changing ownership', async t => {
  mockPending(t);
  const first = harness({ pending: pending() });
  await waitFor(() => assert.equal(readEthereumRevealJobs(scope).length, 1));
  first.unmount();
  t.mock.method(ethereumRevealApi, 'transaction', async () => transactionResponse('revealed', [artwork('1', 'video')]));
  let revealed = 0;
  const second = harness({ items: [item()] }, (actual, result) => { assert.equal(actual, hash); assert.equal(result.length, 1); revealed++; });
  await waitFor(() => assert.equal(second.result.current.applyArtwork(item()).animation_url, artwork('1', 'video').animation_url));
  assert.equal(revealed, 1);
  assert.equal(readEthereumRevealJobs(scope).length, 0);
  const transferred = { ...item(), owner: `0x${'44'.repeat(20)}`, name: 'Old placeholder' };
  second.update({ items: [transferred] });
  const updated = second.result.current.applyArtwork(transferred);
  assert.equal(updated.owner, transferred.owner);
  assert.equal(updated.tokenId, '1');
  assert.equal(updated.image, artwork().image);
  assert.deepEqual(updated.aspectRatio, { width: 1080, height: 1920 });
});

test('an in-flight bundled reveal uses enriched crate scope without losing other crates from the media cache', async t => {
  mockPending(t);
  const response = Promise.withResolvers<EthereumRevealTransactionResponse>();
  const requests = t.mock.method(ethereumRevealApi, 'transaction', () => response.promise);
  rememberEthereumRevealJob(scope, hash, 1);
  const original = readEthereumRevealJobs(scope)[0];
  const shown: string[][] = [];
  const view = harness({}, (_hash, artworks) => { shown.push(artworks.map(value => value.tokenId)); });
  await waitFor(() => assert.equal(requests.mock.callCount(), 1));
  view.update({ pending: pending() });
  await waitFor(() => assert.deepEqual(readEthereumRevealJobs(scope), [{ ...original, crateTokenIds: ['111112'] }]));
  const artworks = Array.from({ length: 40 }, (_, index) => ({ ...artwork(String(index + 1)),
    crateTokenId: index < 20 ? '111112' : '111113' }));
  await act(async () => { response.resolve(transactionResponse('revealed', artworks)); });
  await waitFor(() => assert.deepEqual(shown, [artworks.slice(0, 20).map(value => value.tokenId)]));
  assert.equal(requests.mock.callCount(), 1);
  assert.equal(view.result.current.applyArtwork(item('40')).image, artwork('40').image);
  assert.deepEqual(readEthereumRevealJobs(scope), []);
});

for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'current'} unscoped jobs cache revealed media without claiming the transaction gallery`, async t => {
  mockPending(t);
  t.mock.method(ethereumRevealApi, 'transaction', async () => transactionResponse('revealed', [artwork()]));
  if (legacy) writeEthereumStorage(`${scope}:reveals`, [{ transactionHash: hash, submittedAt: 1 }]);
  else rememberEthereumRevealJob(scope, hash, 1);
  let shown = 0;
  const view = harness({}, () => { shown++; });
  await waitFor(() => assert.deepEqual(readEthereumRevealJobs(scope), []));
  assert.equal(view.result.current.applyArtwork(item()).image, artwork().image);
  assert.equal(shown, 0);
});

test('enriching a saved job preserves its rate-limit cooldown and generation', async t => {
  mockPending(t);
  const requests = t.mock.method(ethereumRevealApi, 'transaction', async () => { throw new EthereumRevealApiError(429, 'Try later.', 60_000); });
  rememberEthereumRevealJob(scope, hash, 1);
  const view = harness();
  const key = ['ethereum111k', 'reveal-transaction', config.chainId, contract, hash];
  await waitFor(() => assert.equal(view.client.getQueryState(key)?.status, 'error'));
  const original = readEthereumRevealJobs(scope)[0];
  const updatedAt = view.client.getQueryState(key)?.errorUpdatedAt;
  view.update({ pending: pending() });
  await waitFor(() => assert.deepEqual(readEthereumRevealJobs(scope), [{ ...original, crateTokenIds: ['111112'] }]));
  await waitWithRenders(400);
  assert.equal(requests.mock.callCount(), 1);
  assert.equal(view.client.getQueryState(key)?.errorUpdatedAt, updatedAt);
});

test('a legacy reveal can finish while its pending-intent restoration is waiting for the submission lock', async t => {
  mockPending(t);
  writeEthereumStorage(`${scope}:reveals`, [{ transactionHash: hash, submittedAt: 1 }]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const competing = navigator.locks.request(`ethereum111k-submission:${scope}`, {}, () => { entered.resolve(); return release.promise; });
  await entered.promise;
  const artworks = [artwork(), { ...artwork('21'), crateTokenId: '111113' }];
  t.mock.method(ethereumRevealApi, 'transaction', async () => transactionResponse('revealed', artworks));
  const shown: string[][] = [];
  harness({ pending: pending() }, (_hash, values) => { shown.push(values.map(value => value.tokenId)); });
  try {
    await waitFor(() => assert.deepEqual(shown, [['1']]));
    assert.deepEqual(readEthereumRevealJobs(scope), []);
  } finally {
    release.resolve();
    await competing;
  }
  await act(async () => {});
  assert.deepEqual(readEthereumRevealJobs(scope), []);
});

test('tokens heal without a transaction hash and revealed media stays fixed after stale responses', async t => {
  const mocks = mockPending(t);
  t.mock.method(ethereumRevealApi, 'tokens', async (_config, ids) => ({ ...responseScope,
    artworks: ids.map(id => artwork(id, 'egg')), unresolved: [], retryAfterMs: 2000 }));
  const original = item();
  const view = harness({ items: [original, { ...item('2000001'), kind: 'crate_receipt' }] });
  await waitFor(() => assert.equal(view.result.current.applyArtwork(original).category, 'egg'));
  view.update({ items: [{ ...original, image: 'https://wip.lil.org/old-placeholder.webp' }] });
  assert.equal(view.result.current.applyArtwork(original).image, artwork().image);
  assert.equal(mocks.transaction.mock.callCount(), 0);
  assert.equal(readEthereumRevealJobs(scope).length, 0);
});

test('token healing covers every batch with at most two concurrent requests', async t => {
  mockPending(t);
  let running = 0, maximum = 0;
  const seen: string[] = [];
  t.mock.method(ethereumRevealApi, 'tokens', async (_config, ids) => {
    running++;
    maximum = Math.max(maximum, running);
    assert.ok(ids.length <= ETHEREUM_REVEAL_MAX_TOKEN_IDS);
    seen.push(...ids);
    await new Promise(resolve => setTimeout(resolve, 5));
    running--;
    return { ...responseScope, artworks: ids.map(id => artwork(id)), unresolved: [], retryAfterMs: 2000 };
  });
  const items = Array.from({ length: 1200 }, (_, index) => item(String(index + 1)));
  const view = harness({ items });
  await waitFor(() => assert.equal(view.result.current.applyArtwork(items[1199]).image, artwork('1200').image));
  assert.equal(seen.length, 1200);
  assert.equal(new Set(seen).size, 1200);
  assert.equal(maximum, 2);
});

for (const change of ['remount', 'gain', 'lose'] as const) {
  for (const retryAfterMs of [75_000, null]) test(`token cooldown survives ${change} with retry delay ${retryAfterMs}`, async t => {
    let now = Date.now(), ready = false;
    const deadline = now + (retryAfterMs ?? 60_000);
    t.mock.method(Date, 'now', () => now);
    const calls = t.mock.method(ethereumRevealApi, 'tokens', async (_config, ids) => {
      if (!ready) throw new EthereumRevealApiError(429, 'Try again later.', retryAfterMs);
      return { ...responseScope, artworks: ids.map(id => artwork(id)), unresolved: [], retryAfterMs: 0 };
    });
    const items = change === 'lose' ? [item('1'), item('2')] : [item('1')];
    let view = harness({ items });
    const key = (values: EthereumInventoryItem[]) => ['ethereum111k', 'reveal-tokens', config.chainId, contract, [values.map(value => value.tokenId)]];
    await waitFor(() => assert.equal(view.client.getQueryState(key(items))?.status, 'error'));
    now += 20_000;
    const next = change === 'gain' ? [item('1'), item('2')] : [item('1')];
    if (change === 'remount') {
      view.unmount();
      view = harness({ items: next }, undefined, { client: view.client });
    } else view.update({ items: next });
    await waitFor(() => assert.equal((view.client.getQueryState(key(next))?.error as InstanceType<typeof EthereumRevealApiError>)?.retryAfterMs, deadline - now));
    assert.equal(calls.mock.callCount(), 1);
    now += 10_000;
    await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'reveal-tokens'] }); });
    assert.equal(calls.mock.callCount(), 1);
    assert.equal((view.client.getQueryState(key(next))?.error as InstanceType<typeof EthereumRevealApiError>).retryAfterMs, deadline - now);
    now = deadline - 1;
    await act(async () => { setPageVisibility('hidden'); setPageVisibility('visible'); });
    assert.equal(calls.mock.callCount(), 1);
    now = deadline;
    ready = true;
    act(() => { setPageVisibility('hidden'); setPageVisibility('visible'); });
    await waitFor(() => assert.ok(next.every(value => view.result.current.applyArtwork(value).revealStatus === 'revealed')));
    assert.equal(calls.mock.callCount(), 2);
    assert.deepEqual(calls.mock.calls[1].arguments[1], next.map(value => value.tokenId));
  });
}

test('a token rate limit immediately blocks other hooks and later batches while retaining successful in-flight artwork', async t => {
  let now = Date.now(), ready = false;
  const deadline = now + 60_000;
  t.mock.method(Date, 'now', () => now);
  const sibling = Promise.withResolvers<void>();
  const requests: string[][] = [];
  t.mock.method(ethereumRevealApi, 'tokens', async (_config, ids) => {
    requests.push([...ids]);
    if (!ready && ids[0] === '1') throw new EthereumRevealApiError(429, 'Try again later.', 60_000);
    if (!ready && ids[0] === '501') await sibling.promise;
    return { ...responseScope, artworks: ids.map(id => artwork(id)), unresolved: [], retryAfterMs: 0 };
  });
  const items = Array.from({ length: 1200 }, (_, index) => item(String(index + 1)));
  const view = harness({ items });
  await waitFor(() => assert.equal(requests.length, 2));
  now += 20_000;
  const other = harness({ items: [item('1201')] }, undefined, { client: view.client });
  const otherKey = ['ethereum111k', 'reveal-tokens', config.chainId, contract, [['1201']]];
  await waitFor(() => assert.equal(other.client.getQueryState(otherKey)?.status, 'error'));
  assert.equal(requests.length, 2);
  await act(async () => { sibling.resolve(); });
  await waitFor(() => assert.equal(view.result.current.applyArtwork(items[500]).revealStatus, 'revealed'));
  assert.equal(view.result.current.applyArtwork(items[0]).revealStatus, 'unrevealed');
  assert.equal(view.result.current.applyArtwork(items[1199]).revealStatus, 'unrevealed');
  assert.deepEqual(requests.map(ids => [ids[0], ids.length]), [['1', 500], ['501', 500]]);
  now = deadline - 1;
  await act(async () => { setPageVisibility('hidden'); setPageVisibility('visible'); });
  assert.equal(requests.length, 2);
  now = deadline;
  ready = true;
  act(() => { setPageVisibility('hidden'); setPageVisibility('visible'); });
  await waitFor(() => assert.ok(items.every(value => view.result.current.applyArtwork(value).revealStatus === 'revealed')));
  await waitFor(() => assert.equal(other.result.current.applyArtwork(item('1201')).revealStatus, 'revealed'));
  assert.deepEqual(requests.slice(2).map(ids => [ids[0], ids.length]).sort(), [['1', 500], ['1001', 200], ['1201', 1]]);
});

test('a sibling settling after the token cooldown expires cannot restart its full retry delay', async t => {
  let now = Date.now(), ready = false;
  t.mock.method(Date, 'now', () => now);
  const sibling = Promise.withResolvers<void>();
  const requests: string[][] = [];
  t.mock.method(ethereumRevealApi, 'tokens', async (_config, ids) => {
    requests.push([...ids]);
    if (!ready && ids[0] === '1') throw new EthereumRevealApiError(429, 'Try again later.', 60_000);
    if (!ready) await sibling.promise;
    return { ...responseScope, artworks: ids.map(id => artwork(id)), unresolved: [], retryAfterMs: 0 };
  });
  const items = Array.from({ length: 1000 }, (_, index) => item(String(index + 1)));
  const view = harness({ items });
  await waitFor(() => assert.equal(requests.length, 2));
  now += 70_000;
  await act(async () => { sibling.resolve(); });
  const key = ['ethereum111k', 'reveal-tokens', config.chainId, contract,
    [items.slice(0, 500).map(value => value.tokenId), items.slice(500).map(value => value.tokenId)]];
  await waitFor(() => assert.equal(view.client.getQueryState(key)?.status, 'error'));
  assert.equal((view.client.getQueryState(key)?.error as InstanceType<typeof EthereumRevealApiError>).retryAfterMs, 2000);
  assert.equal(view.result.current.applyArtwork(items[500]).revealStatus, 'revealed');
  ready = true;
  now += 2000;
  act(() => { setPageVisibility('hidden'); setPageVisibility('visible'); });
  await waitFor(() => assert.ok(items.every(value => view.result.current.applyArtwork(value).revealStatus === 'revealed')));
  assert.deepEqual(requests.map(ids => [ids[0], ids.length]), [['1', 500], ['501', 500], ['1', 500]]);
});

test('a transient reveal failure preserves its job and retries without resubmitting a wallet transaction', async t => {
  mockPending(t);
  let unavailable = true;
  t.mock.method(ethereumRevealApi, 'transaction', async () => {
    if (unavailable) throw new Error('RPC temporarily unavailable');
    return transactionResponse('revealed', [artwork()]);
  });
  rememberEthereumRevealJob(scope, hash);
  const view = harness();
  await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'reveal-transaction', config.chainId, contract, hash])?.status, 'error'));
  assert.equal(readEthereumRevealJobs(scope).length, 1);
  unavailable = false;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'reveal-transaction'] }); });
  await waitFor(() => assert.equal(readEthereumRevealJobs(scope).length, 0));
  assert.equal(view.result.current.applyArtwork(item()).image, artwork().image);
});

for (const initialVisibility of ['visible', 'hidden'] as const) test(`an initially ${initialVisibility} page submits once, pauses hidden repeats and resumes when visible`, async t => {
  mockPending(t);
  const calls = t.mock.method(ethereumRevealApi, 'transaction', async () => ({ ...transactionResponse(), retryAfterMs: 1000 }));
  setPageVisibility(initialVisibility);
  rememberEthereumRevealJob(scope, hash);
  const view = harness();
  await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'reveal-transaction', config.chainId, contract, hash])?.status, 'success'));
  assert.equal(calls.mock.callCount(), 1);
  act(() => setPageVisibility('hidden'));
  await waitWithRenders(1300);
  assert.equal(calls.mock.callCount(), 1);
  assert.equal(readEthereumRevealJobs(scope).length, 1);
  act(() => setPageVisibility('visible'));
  await waitFor(() => assert.equal(calls.mock.callCount(), 2), { timeout: 750 });
});

test('garbage collection cannot restart polling while the page remains hidden', async t => {
  mockPending(t);
  const calls = t.mock.method(ethereumRevealApi, 'transaction', async () => ({ ...transactionResponse(), retryAfterMs: 1000 }));
  rememberEthereumRevealJob(scope, hash);
  const view = harness({}, undefined, { gcTime: 20 });
  const key = ['ethereum111k', 'reveal-transaction', config.chainId, contract, hash];
  await waitFor(() => assert.equal(view.client.getQueryState(key)?.status, 'success'));
  act(() => setPageVisibility('hidden'));
  await waitFor(() => assert.equal(view.client.getQueryState(key), undefined));
  await waitWithRenders(1300);
  assert.equal(calls.mock.callCount(), 1);
  assert.equal(view.client.getQueryState(key), undefined);
  assert.equal(readEthereumRevealJobs(scope).length, 1);
  act(() => setPageVisibility('visible'));
  await waitFor(() => assert.equal(calls.mock.callCount(), 2), { timeout: 750 });
});

test('hiding the page preserves an in-flight reveal and processes its confirmed result', async t => {
  mockPending(t);
  const response = Promise.withResolvers<EthereumRevealTransactionResponse>();
  let signal: AbortSignal | undefined;
  const calls = t.mock.method(ethereumRevealApi, 'transaction', (_config, _hash, requestSignal) => {
    signal = requestSignal;
    return response.promise;
  });
  rememberEthereumRevealJob(scope, hash);
  const view = harness();
  await waitFor(() => assert.ok(signal));
  act(() => setPageVisibility('hidden'));
  await waitWithRenders(500);
  assert.equal(signal?.aborted, false);
  assert.equal(calls.mock.callCount(), 1);
  await act(async () => { response.resolve(transactionResponse('revealed', [artwork()])); });
  await waitFor(() => assert.equal(readEthereumRevealJobs(scope).length, 0));
  assert.equal(view.result.current.applyArtwork(item()).image, artwork().image);
  assert.equal(signal?.aborted, false);
});

for (const failure of ['transient error', 'rate limit'] as const) test(`focus and reconnect preserve the ${failure} retry delay`, async t => {
  mockPending(t);
  const calls = t.mock.method(ethereumRevealApi, 'transaction', async () => {
    throw failure === 'rate limit' ? new EthereumRevealApiError(429, 'Try again later.', 60_000) : new Error('RPC unavailable');
  });
  rememberEthereumRevealJob(scope, hash);
  const view = harness();
  await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'reveal-transaction', config.chainId, contract, hash])?.status, 'error'));
  assert.equal(calls.mock.callCount(), 1);
  await act(async () => {
    setPageVisibility('hidden');
    setPageVisibility('visible');
    window.dispatchEvent(new window.Event('offline'));
    assert.equal(onlineManager.isOnline(), false);
    window.dispatchEvent(new window.Event('online'));
    assert.equal(onlineManager.isOnline(), true);
  });
  await waitWithRenders(400);
  assert.equal(calls.mock.callCount(), 1);
  assert.equal(readEthereumRevealJobs(scope).length, 1);
});

for (const state of ['recovering', 'unminted', 'transient error', 'rate limit'] as const) {
  for (const resume of ['focus', 'reconnect'] as const) test(`token ${state} waits for its deadline and resumes immediately on ${resume}`, async t => {
    let now = Date.now(), ready = false;
    t.mock.method(Date, 'now', () => now);
    const calls = t.mock.method(ethereumRevealApi, 'tokens', async () => {
      if (ready) return { ...responseScope, artworks: [artwork()], unresolved: [], retryAfterMs: 0 };
      if (state === 'transient error') throw new Error('RPC unavailable');
      if (state === 'rate limit') throw new EthereumRevealApiError(429, 'Try again later.', 60_000);
      return { ...responseScope, artworks: [], unresolved: [{ tokenId: '1', status: state }], retryAfterMs: 8_000 };
    });
    setPageVisibility('hidden');
    const view = harness({ items: [item()] });
    const key = ['ethereum111k', 'reveal-tokens', config.chainId, contract, [['1']]];
    const status = state === 'transient error' || state === 'rate limit' ? 'error' : 'success';
    await waitFor(() => assert.equal(view.client.getQueryState(key)?.status, status));
    assert.equal(calls.mock.callCount(), 1);
    let attempts = 1;
    if (state === 'transient error') {
      now += 2_000;
      act(() => setPageVisibility('visible'));
      await waitFor(() => assert.equal(view.client.getQueryState(key)?.errorUpdateCount, 2));
      attempts = 2;
    }
    const interval = state === 'recovering' ? 8_000 : state === 'unminted' ? 30_000 : state === 'rate limit' ? 60_000 : 4_000;
    const query = view.client.getQueryState(key)!;
    const deadline = Math.max(query.dataUpdatedAt, query.errorUpdatedAt) + interval;
    now = deadline - 1;
    await act(async () => {
      setPageVisibility('hidden');
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      setPageVisibility('visible');
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    assert.equal(calls.mock.callCount(), attempts);
    now = deadline;
    ready = true;
    if (resume === 'focus') {
      await act(async () => {
        setPageVisibility('hidden');
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });
      assert.equal(calls.mock.callCount(), attempts);
      act(() => setPageVisibility('visible'));
    } else await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await waitFor(() => assert.equal(view.result.current.applyArtwork(item()).image, artwork().image), { timeout: 500 });
    assert.equal(calls.mock.callCount(), attempts + 1);
  });
}

test('pending saved hashes do not starve later reveal jobs', async t => {
  mockPending(t);
  const hashes = Array.from({ length: 5 }, (_, index) => `0x${String(index + 1).padStart(64, '0')}`);
  const seen: string[] = [];
  hashes.forEach((transactionHash, index) => rememberEthereumRevealJob(scope, transactionHash, index + 1));
  t.mock.method(ethereumRevealApi, 'transaction', async (_config, transactionHash) => {
    seen.push(transactionHash);
    return transactionHash === hashes[4] ? transactionResponse('revealed', [artwork()]) : transactionResponse();
  });
  const view = harness();
  await waitFor(() => assert.ok(seen.includes(hashes[4])));
  await waitFor(() => assert.equal(view.result.current.applyArtwork(item()).image, artwork().image));
  assert.equal(readEthereumRevealJobs(scope).length, 4);
  assert.deepEqual(new Set(seen), new Set(hashes));
});

test('saved hash scheduling keeps in-flight work and prioritizes the current unpack when a slot opens', async t => {
  mockPending(t);
  const hashes = Array.from({ length: 6 }, (_, index) => `0x${String(index + 1).padStart(64, '0')}`);
  const gates = hashes.slice(0, 4).map(() => Promise.withResolvers<void>());
  const signals: AbortSignal[] = [];
  const seen: string[] = [];
  let running = 0, maximum = 0;
  hashes.forEach((transactionHash, index) => rememberEthereumRevealJob(scope, transactionHash, index + 1));
  t.mock.method(ethereumRevealApi, 'transaction', async (_config, transactionHash, signal) => {
    seen.push(transactionHash);
    signals.push(signal!);
    running++;
    maximum = Math.max(maximum, running);
    try {
      const index = hashes.indexOf(transactionHash);
      if (index < 4) await gates[index].promise;
      return transactionResponse();
    } finally { running--; }
  });
  const view = harness();
  await waitFor(() => assert.equal(seen.length, 4));
  view.update({ pending: { ...pending(), hash: hashes[5], submittedAt: 6 } });
  await act(async () => {});
  assert.equal(seen.length, 4);
  assert.ok(signals.every(signal => !signal.aborted));
  await act(async () => { gates[0].resolve(); });
  await waitFor(() => assert.equal(seen[4], hashes[5]));
  assert.equal(maximum, 4);
  assert.ok(signals.slice(1, 4).every(signal => !signal.aborted));
  await act(async () => { gates.slice(1).forEach(gate => gate.resolve()); });
});

test('a failed manual refresh does not strand a saved hash outside the retry schedule', async t => {
  mockPending(t);
  let ready = false;
  const calls = t.mock.method(ethereumRevealApi, 'transaction', async () => {
    if (!ready) throw new EthereumRevealApiError(503, 'Try again shortly.', 1000);
    return transactionResponse('revealed', [artwork()]);
  });
  rememberEthereumRevealJob(scope, hash);
  const view = harness();
  await waitFor(() => assert.equal(view.client.getQueryState(['ethereum111k', 'reveal-transaction', config.chainId, contract, hash])?.status, 'error'));
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'reveal-transaction'] }); });
  assert.equal(calls.mock.callCount(), 2);
  ready = true;
  await waitFor(() => assert.equal(view.result.current.applyArtwork(item()).image, artwork().image), { timeout: 3000 });
  assert.equal(readEthereumRevealJobs(scope).length, 0);
});

test('successful healing batches render immediately and remain cached when another batch fails', async t => {
  mockPending(t);
  const failingBatch = Promise.withResolvers<void>();
  let fail = true, running = 0, maximum = 0;
  let failedSignal: AbortSignal | undefined;
  const requests: string[][] = [];
  t.mock.method(ethereumRevealApi, 'tokens', async (_config, ids, signal) => {
    requests.push([...ids]);
    running++;
    maximum = Math.max(maximum, running);
    try {
      await Promise.resolve();
      if (ids.includes('501') && fail) { failedSignal = signal; await failingBatch.promise; }
      return { ...responseScope, artworks: ids.map(id => artwork(id)), unresolved: [], retryAfterMs: 2000 };
    } finally { running--; }
  });
  const items = Array.from({ length: 1001 }, (_, index) => item(String(index + 1)));
  const view = harness({ items });
  await waitFor(() => assert.equal(view.result.current.applyArtwork(items[0]).image, artwork('1').image));
  assert.equal(failedSignal?.aborted, false);
  assert.equal(requests.length, 2);
  await act(async () => { failingBatch.reject(new Error('Second batch temporarily unavailable')); });
  await waitFor(() => assert.equal(view.result.current.applyArtwork(items[1000]).image, artwork('1001').image));
  assert.equal(view.result.current.applyArtwork(items[0]).image, artwork('1').image);
  assert.equal(view.result.current.applyArtwork(items[500]).image, items[500].image);
  fail = false;
  await act(async () => { await view.client.invalidateQueries({ queryKey: ['ethereum111k', 'reveal-tokens'] }); });
  await waitFor(() => assert.equal(view.result.current.applyArtwork(items[500]).image, artwork('501').image));
  assert.deepEqual(requests.map(ids => [ids[0], ids.length]), [['1', 500], ['501', 500], ['1001', 1], ['501', 500]]);
  assert.equal(maximum, 2);
});

test('late healing batches do not populate another deployment after cancellation', async t => {
  mockPending(t);
  const response = Promise.withResolvers<Awaited<ReturnType<typeof ethereumRevealApi.tokens>>>();
  let started = false;
  t.mock.method(ethereumRevealApi, 'tokens', () => { started = true; return response.promise; });
  const view = harness({ items: [item()] });
  await waitFor(() => assert.equal(started, true));
  const otherConfig = resolveEthereum111kConfig({ contractAddress: `0x${'55'.repeat(20)}` });
  view.update({ config: otherConfig, scope: ethereumInventoryScope(otherConfig, owner), items: [] });
  await act(async () => { response.resolve({ ...responseScope, artworks: [artwork()], unresolved: [], retryAfterMs: 0 }); await response.promise; });
  assert.equal(view.result.current.applyArtwork(item()).image, item().image);
  assert.equal(view.client.getQueryData(['ethereum111k', 'revealed-artworks', config.chainId, contract]), undefined);
});

for (const status of ['reverted', 'not_unpack'] as const) test(`${status} stops reveal polling without publishing media`, async t => {
  mockPending(t);
  t.mock.method(ethereumRevealApi, 'transaction', async () => transactionResponse(status));
  rememberEthereumRevealJob(scope, hash);
  const view = harness();
  await waitFor(() => assert.equal(readEthereumRevealJobs(scope).length, 0));
  assert.equal(view.result.current.applyArtwork(item()).image, item().image);
});

test('late reveal results cannot open another account or deployment and leave its inventory untouched', async t => {
  mockPending(t);
  const response = Promise.withResolvers<EthereumRevealTransactionResponse>();
  let started = false, shown = 0;
  t.mock.method(ethereumRevealApi, 'transaction', () => { started = true; return response.promise; });
  rememberEthereumRevealJob(scope, hash);
  const view = harness({}, () => { shown++; });
  await waitFor(() => assert.equal(started, true));
  const otherConfig = resolveEthereum111kConfig({ contractAddress: `0x${'55'.repeat(20)}` });
  view.update({ config: otherConfig, scope: ethereumInventoryScope(otherConfig, owner) });
  await act(async () => { response.resolve(transactionResponse('revealed', [artwork()])); await response.promise; });
  assert.equal(shown, 0);
  assert.equal(view.result.current.applyArtwork(item()).image, item().image);
  assert.equal(readEthereumRevealJobs(scope).length, 1);
});

for (const kind of ['warehouse', 'reliquary'] as const) test(`${kind} opening does not register an artwork reveal job`, async t => {
  const mocks = mockPending(t);
  const operation = pending();
  operation.intent!.data = encodeCall(kind === 'warehouse' ? ETHEREUM_FUNCTIONS.unboxWarehouse : ETHEREUM_FUNCTIONS.unboxReliquary, ['uint256'], [kind === 'warehouse' ? '116667' : '117172']);
  harness({ pending: operation });
  await act(async () => {});
  assert.equal(mocks.transaction.mock.callCount(), 0);
  assert.equal(readEthereumRevealJobs(scope).length, 0);
});

test('shared inventory media preserves confirmed dimensions and video while rejecting unsafe optional media', () => {
  const video = { ...item(), ...artwork('1', 'video'), revealStatus: 'revealed' as const };
  const parsed = parseEthereumInventoryItem(video, config, owner);
  const preview = ethereumInventoryView(parsed);
  assert.deepEqual(preview.imageDimensions, video.aspectRatio);
  assert.equal(preview.previewVideo?.sources[0].src, video.animation_url);
  assert.equal(preview.previewVideo?.posterSrc, video.image);
  for (const update of [{ animation_url: 'javascript:alert(1)' }, { aspectRatio: { width: -1, height: 20 } }]) {
    assert.throws(() => parseEthereumInventoryItem({ ...video, ...update }, config, owner), /invalid response/);
  }
});

test('published reveal metadata does not need token recovery on a fresh inventory load', async t => {
  const mocks = mockPending(t);
  const published = parseEthereumInventoryItem({ ...item(), ...artwork('1', 'video'), revealStatus: 'revealed' }, config, owner);
  const view = harness({ items: [published] });
  await act(async () => {});
  assert.equal(mocks.tokens.mock.callCount(), 0);
  assert.equal(view.result.current.applyArtwork(published).revealStatus, 'revealed');
  assert.equal(view.result.current.applyArtwork(published).category, 'video');
});

test('published artwork remains fixed across stale inventory and later reveal responses without retaining ownership', async t => {
  const mocks = mockPending(t);
  const published = parseEthereumInventoryItem({ ...item(), ...artwork('1', 'video'),
    description: 'Published description', revealStatus: 'revealed' }, config, owner);
  const view = harness({ items: [published] });
  await act(async () => {});
  const transferred = { ...item(), owner: `0x${'44'.repeat(20)}`, displayId: 2 };
  view.update({ items: [transferred] });
  const expected = { ...transferred, name: published.name, description: published.description, image: published.image,
    animation_url: published.animation_url, aspectRatio: published.aspectRatio, category: published.category,
    attributes: published.attributes, revealStatus: 'revealed' };
  assert.deepEqual(view.result.current.applyArtwork(transferred), expected);
  assert.equal(mocks.tokens.mock.callCount(), 0);
  const cache = view.client.getQueryData<Record<string, Record<string, unknown>>>(['ethereum111k', 'revealed-artworks', config.chainId, contract])!;
  for (const key of ['owner', 'id', 'chainId', 'contractAddress', 'kind', 'displayId', 'crateTokenId', 'observation']) {
    assert.equal(key in cache['1'], false);
  }
  const receipt = { ...transferred, kind: 'artwork_receipt' as const };
  assert.equal(view.result.current.applyArtwork(receipt), receipt);
  t.mock.method(ethereumRevealApi, 'transaction', async () => transactionResponse('revealed', [{ ...artwork(), name: 'Later metadata' }]));
  act(() => rememberEthereumRevealJob(scope, hash));
  await waitFor(() => assert.equal(readEthereumRevealJobs(scope).length, 0));
  assert.deepEqual(view.result.current.applyArtwork(transferred), expected);
});

test('published inventory media remains isolated by chain and contract', async t => {
  mockPending(t);
  const published = parseEthereumInventoryItem({ ...item(), ...artwork(), revealStatus: 'revealed' }, config, owner);
  const view = harness({ items: [published] });
  await act(async () => {});
  const otherConfig = resolveEthereum111kConfig({ contractAddress: `0x${'55'.repeat(20)}` });
  const otherItem = { ...item(), contractAddress: otherConfig.contractAddress!, id: ethereumAssetId(otherConfig.chainId, otherConfig.contractAddress!, '1') };
  view.update({ config: otherConfig, scope: ethereumInventoryScope(otherConfig, owner), items: [published] });
  await act(async () => {});
  assert.equal(view.result.current.applyArtwork(otherItem), otherItem);
  assert.equal(view.client.getQueryData(['ethereum111k', 'revealed-artworks', otherConfig.chainId, otherConfig.contractAddress]), undefined);
  const localConfig = resolveEthereum111kConfig({ chainId: 31337, contractAddress: contract });
  const localItem = { ...item(), chainId: 31337, id: ethereumAssetId(31337, contract, '1') };
  view.update({ config: localConfig, scope: ethereumInventoryScope(localConfig, owner), items: [published] });
  await act(async () => {});
  assert.equal(view.result.current.applyArtwork(localItem), localItem);
  assert.equal(view.client.getQueryData(['ethereum111k', 'revealed-artworks', 31337, contract]), undefined);
});

test('local inventory verifies media against its own ledger even when shared CDN metadata is revealed', async t => {
  const localConfig = resolveEthereum111kConfig({ chainId: 31337, contractAddress: contract });
  const localScope = ethereumInventoryScope(localConfig, owner)!;
  const localItem = { ...item(), ...artwork(), chainId: 31337, id: ethereumAssetId(31337, contract, '1'), revealStatus: 'revealed' as const };
  const localArtwork = { ...artwork(), image: 'https://wip.lil.org/reveal-test/local.webp' };
  const recovery = t.mock.method(ethereumRevealApi, 'tokens', async () => ({ ...responseScope, chainId: 31337,
    artworks: [localArtwork], unresolved: [], retryAfterMs: 0 }));
  const view = harness({ config: localConfig, scope: localScope, items: [localItem] });
  await waitFor(() => assert.equal(view.result.current.applyArtwork(localItem).image, localArtwork.image));
  assert.equal(recovery.mock.callCount(), 1);
});

test('artwork video reserves its dimensions before loading and falls back to the poster on failure', async () => {
  const video = { ...item(), ...artwork('1', 'video'), revealStatus: 'revealed' as const };
  const view = render(createElement(EthereumArtworkMedia, { item: video, viewer: true }));
  const frame = view.container.querySelector<HTMLElement>('.ethereum111k__artwork-media')!;
  assert.equal(Number.parseFloat(frame.style.aspectRatio), 1080 / 1920);
  const image = view.container.querySelector('img')!;
  assert.equal(image.getAttribute('width'), '1080');
  assert.equal(image.getAttribute('height'), '1920');
  const media = view.container.querySelector('video')!;
  assert.equal(media.getAttribute('src'), video.animation_url);
  assert.equal(media.getAttribute('height'), '1920');
  fireEvent.error(media);
  assert.equal(view.container.querySelector('video'), null);
  assert.equal(image.hidden, false);
  assert.equal(image.getAttribute('src'), video.image);
});

test('reduced motion prevents playback on the first viewer mount', t => {
  environment.setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  const play = t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'play', async () => {});
  const video = { ...item(), ...artwork('1', 'video') };
  const view = render(createElement(EthereumArtworkMedia, { item: video, viewer: true }));
  const media = view.container.querySelector('video')!;
  assert.equal(media.autoplay, false);
  assert.equal(media.controls, true);
  fireEvent.loadedData(media);
  assert.equal(play.mock.callCount(), 0);
});

test('reduced motion leaves reveal tiles on their poster while keeping viewer playback controls', () => {
  environment.setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  const video = { ...item(), ...artwork('1', 'video'), revealStatus: 'revealed' as const };
  const view = render(createElement(EthereumArtworkMedia, { item: video }));
  assert.equal(view.container.querySelector('video'), null);
  view.rerender(createElement(EthereumArtworkMedia, { item: video, viewer: true }));
  const media = view.container.querySelector('video')!;
  assert.equal(media.autoplay, false);
  assert.equal(media.controls, true);
});

test('reduced aspect-ratio pairs never become pixel-size limits in the artwork viewer', () => {
  for (const ratio of [{ width: 1, height: 1 }, { width: 16, height: 9 }]) {
    const view = render(createElement(EthereumArtworkMedia, { item: { ...item(), ...artwork(), aspectRatio: ratio }, viewer: true }));
    const frame = view.container.querySelector<HTMLElement>('.ethereum111k__artwork-media')!;
    assert.doesNotMatch(frame.style.width, /\b\d+px/);
    assert.match(frame.style.width, /svh/);
    assert.equal(Number.parseFloat(frame.style.aspectRatio), ratio.width / ratio.height);
    view.unmount();
  }
});
