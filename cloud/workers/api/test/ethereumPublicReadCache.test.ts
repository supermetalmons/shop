import assert from 'node:assert/strict';
import test from 'node:test';
import { raceWithSignal } from '../src/boundedRequest.ts';
import { EthereumPublicReadCache, ethereumPublicReadCacheKey, ethereumPublicReadCacheName,
  type EthereumPublicReadCacheScope } from '../src/ethereumPublicReadCache.ts';

const SCOPE: EthereumPublicReadCacheScope = { chainId: 1, contractAddress: `0x${'ab'.repeat(20)}`,
  deploymentId: 'mainnet-v1', revision: 3, catalogRevision: 0, catalogUpdateId: null,
  metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 100 };
const OWNER = `0x${'12'.repeat(20)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('public cache coalesces misses, clones values and expires from the original read start', async () => {
  let now = 100;
  let fills = 0;
  const cache = new EthereumPublicReadCache(() => now);
  const pending = deferred<{ ids: string[] }>();
  const load = () => { fills++; return pending.promise; };
  const first = cache.read('same', 2_000, load);
  const second = cache.read('same', 2_000, load);
  await Promise.resolve();
  assert.equal(fills, 1);
  now = 1_000;
  pending.resolve({ ids: ['1'] });
  const [a, b] = await Promise.all([first, second]);
  a.ids.push('2');
  assert.deepEqual(b.ids, ['1']);
  now = 2_099;
  assert.deepEqual(await cache.read('same', 2_000, load), { ids: ['1'] });
  assert.equal(fills, 1);
  now = 2_100;
  assert.deepEqual(await cache.read('same', 2_000, async () => { fills++; return { ids: ['3'] }; }), { ids: ['3'] });
  assert.equal(fills, 2);
});

test('public cache does not retain a slow fill past its freshness window or retain errors', async () => {
  let now = 0;
  let fills = 0;
  const cache = new EthereumPublicReadCache(() => now);
  assert.equal(await cache.read('slow', 1_000, async () => { now = 1_500; return 1; }), 1);
  assert.equal(await cache.read('slow', 1_000, async () => { fills++; return 2; }), 2);
  assert.equal(fills, 1);
  await assert.rejects(cache.read('failure', 1_000, async () => { throw new Error('upstream'); }), /upstream/);
  assert.equal(await cache.read('failure', 1_000, async () => 3), 3);
});

test('fresh and coalesced delivery deadlines do not extend retained cache expiry', async () => {
  let now = 0;
  const cache = new EthereumPublicReadCache(() => now);
  const pending = deferred<number>();
  const first = cache.readEntry('same', 2_000, () => pending.promise);
  const second = cache.readEntry('same', 2_000, async () => assert.fail('Must join the pending fill'));
  now = 500;
  pending.resolve(7);
  assert.deepEqual(await first, { value: 7, expiresAtMs: 2_500 });
  assert.deepEqual(await second, { value: 7, expiresAtMs: 2_500 });
  now = 1_900;
  assert.deepEqual(await cache.readEntry('same', 2_000, async () => assert.fail('Must reuse retained value')),
    { value: 7, expiresAtMs: 2_000 });
  now = 2_000;
  assert.deepEqual(await cache.readEntry('same', 2_000, async () => 8), { value: 8, expiresAtMs: 4_000 });
});

test('a slow fresh fill can be delivered once without retaining its extended delivery deadline', async () => {
  let now = 0;
  const cache = new EthereumPublicReadCache(() => now);
  assert.deepEqual(await cache.readEntry('slow', 1_000, async () => { now = 1_500; return 1; }),
    { value: 1, expiresAtMs: 2_500 });
  assert.deepEqual(await cache.readEntry('slow', 1_000, async () => 2), { value: 2, expiresAtMs: 2_500 });
});

test('cancelling one public cache waiter does not cancel its fill or another waiter', async () => {
  const cache = new EthereumPublicReadCache();
  const controller = new AbortController();
  const pending = deferred<string>();
  let fillSignal: AbortSignal | undefined;
  const first = raceWithSignal(cache.read('same', 2_000, signal => { fillSignal = signal; return pending.promise; }), controller.signal);
  const second = cache.read('same', 2_000, async () => assert.fail('must join the fill'));
  await Promise.resolve();
  const reason = new Error('client left');
  controller.abort(reason);
  await assert.rejects(first, error => error === reason);
  assert.equal(fillSignal?.aborted, false);
  pending.resolve('ready');
  assert.equal(await second, 'ready');
  assert.equal(await cache.read('same', 2_000, async () => assert.fail('must reuse the result')), 'ready');
});

test('public cache bounds distinct fills while allowing an existing waiter to join at capacity', async () => {
  const cache = new EthereumPublicReadCache();
  const pending = deferred<number>();
  const reads = Array.from({ length: 64 }, (_, index) => cache.read(String(index), 2_000, () => pending.promise));
  const joined = cache.read('0', 2_000, async () => assert.fail('must join'));
  await assert.rejects(cache.read('overflow', 2_000, async () => 1), /busy/);
  pending.resolve(7);
  assert.ok((await Promise.all([...reads, joined])).every(value => value === 7));
  assert.equal(await cache.read('overflow', 2_000, async () => 8), 8);
});

test('public cache evicts least recently used entries at 1024 results', async () => {
  const cache = new EthereumPublicReadCache(() => 0);
  for (let index = 0; index < 1024; index++) await cache.read(String(index), 2_000, async () => index);
  assert.equal(await cache.read('0', 2_000, async () => assert.fail('entry 0 should still exist')), 0);
  await cache.read('new', 2_000, async () => 1024);
  assert.equal(await cache.read('0', 2_000, async () => assert.fail('recent entry must survive')), 0);
  assert.equal(await cache.read('1', 2_000, async () => -1), -1);
});

test('public cache keys retain full collection, owner, revision and cursor identity', () => {
  const base = ethereumPublicReadCacheKey(SCOPE, 'stats', OWNER);
  assert.equal(ethereumPublicReadCacheKey({ ...SCOPE, contractAddress: SCOPE.contractAddress.toUpperCase().replace('0X', '0x') },
    'stats', OWNER), base);
  for (const change of [{ chainId: 11155111 }, { contractAddress: OWNER }, { deploymentId: 'other' }, { revision: 4 },
    { catalogRevision: 1 }, { catalogUpdateId: 'update' }, { metadataBaseUri: 'https://cdn.mons.shop/111k/other/' }, { deploymentBlock: 101 }]) {
    assert.notEqual(ethereumPublicReadCacheKey({ ...SCOPE, ...change }, 'stats', OWNER), base);
  }
  assert.notEqual(ethereumPublicReadCacheKey(SCOPE, 'stats', null), base);
  assert.notEqual(ethereumPublicReadCacheKey(SCOPE, 'stats', SCOPE.contractAddress), base);
  assert.notEqual(ethereumPublicReadCacheKey(SCOPE, 'owner-ids', OWNER, null), ethereumPublicReadCacheKey(SCOPE, 'owner-ids', OWNER, 'next'));
  assert.notEqual(ethereumPublicReadCacheName(SCOPE, OWNER), ethereumPublicReadCacheName(SCOPE, null));
  assert.equal(new Set(Array.from({ length: 16 }, (_, value) =>
    ethereumPublicReadCacheName(SCOPE, `${OWNER.slice(0, -1)}${value.toString(16)}`))).size, 16);
});
