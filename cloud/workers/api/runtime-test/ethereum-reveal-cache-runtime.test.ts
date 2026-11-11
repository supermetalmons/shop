import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import type { EthereumRevealTokensResponse } from '../../../../shared/ethereum/reveal.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';

const DEPLOYMENT: EthereumRevealDeployment = {
  deploymentId: 'mainnet-v1', dropId: '111k', chainId: 1, contractAddress: `0x${'11'.repeat(20)}`,
  metadataBaseUri: 'https://cdn.mons.shop/111k/', deploymentBlock: 100, catalogVersion: '111k-v9',
  templateJson: '{}', templateSha256: 'ab'.repeat(32), state: 'active', revision: 9,
  createdAtMs: 1, updatedAtMs: 1, activatedAtMs: 1, provisionedAtMs: 1, lastError: null,
  effectiveCatalogVersion: '111k-v9', effectiveCatalogSha256: 'cd'.repeat(32),
  catalogRevision: 1, catalogUpdateId: null,
};

test('native reveal Cache API preserves token order, isolates revisions, rejects partial results and expires snapshots', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ethereum-reveal-cache-runtime-'));
  const main = join(directory, 'worker.ts');
  await writeFile(main, `
    import { createEthereumRevealCacheRequest, readCachedEthereumReveal, cacheEthereumReveal }
      from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealCache.ts'))};
    import { normalizeEthereumTokenId } from ${JSON.stringify(resolve('shared/ethereum/protocol.ts'))};
    const actualNow = Date.now;
    let clockOffset = 0;
    let originCalls = 0;
    Date.now = () => actualNow() + clockOffset;
    export default {
      async fetch(request) {
        const body = await request.json();
        if (new URL(request.url).pathname === '/advance') {
          clockOffset += body.milliseconds;
          return Response.json({ ok: true });
        }
        const deployment = { ...${JSON.stringify(DEPLOYMENT)},
          revision: body.revision ?? 9, catalogRevision: body.catalogRevision ?? 1 };
        const tokenIds = [...new Set(body.tokenIds.map(normalizeEthereumTokenId))];
        const key = await createEthereumRevealCacheRequest(request, deployment, tokenIds);
        if (!key) throw new Error('Expected an eligible cache key.');
        const cached = await readCachedEthereumReveal(caches.default, key, deployment, tokenIds, request.signal);
        if (cached) return Response.json(cached.value, { headers: {
          'X-Test-Cache': 'hit', 'X-Test-Origin-Calls': String(originCalls),
        } });
        originCalls++;
        const partial = body.mode === 'partial';
        const value = {
          deploymentId: deployment.deploymentId, dropId: deployment.dropId, chainId: deployment.chainId,
          contractAddress: deployment.contractAddress, catalogRevision: deployment.catalogRevision,
          artworks: (partial ? tokenIds.slice(0, -1) : tokenIds).map(tokenId => ({
            tokenId, crateTokenId: '111112', category: 'painting', name: 'Painting ' + tokenId,
            image: 'https://cdn.mons.shop/paintings/' + tokenId + '.png',
            aspectRatio: { width: 4, height: 3 }, metadataRevision: body.mode === 'enriched' ? 1 : 0,
            observation: { transactionHash: '0x' + '33'.repeat(32), blockNumber: 101, blockHash: '0x' + '44'.repeat(32) },
          })),
          unresolved: partial ? [{ tokenId: tokenIds.at(-1), status: 'recovering' }] : [],
          retryAfterMs: partial ? 2000 : 0,
        };
        const deferred = [];
        cacheEthereumReveal(caches.default, key, deployment, tokenIds, value, promise => deferred.push(promise));
        await Promise.all(deferred);
        const stored = await caches.default.match(key);
        const headers = { 'X-Test-Cache': 'miss', 'X-Test-Origin-Calls': String(originCalls),
          'X-Test-Stored': String(!!stored), 'X-Test-Stored-Cache-Control': stored?.headers.get('Cache-Control') ?? '' };
        if (stored) await stored.body?.cancel();
        return Response.json(value, { headers });
      },
    };
  `);
  const runtime = createTestHarness({ root: directory, workers: [{ config: {
    name: 'ethereum-reveal-cache-test', main, compatibility_date: '2026-08-08',
    compatibility_flags: ['nodejs_compat', 'enable_request_signal'],
  } }] });
  try {
    await runtime.listen();
    const worker = runtime.getWorker('ethereum-reveal-cache-test');
    const read = async (tokenIds: string[], options: { revision?: number; catalogRevision?: number; mode?: 'partial' | 'enriched' } = {}) => {
      const response = await worker.fetch('https://cache.test/ethereum/111k/reveal/tokens', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokenIds, ...options }),
      });
      assert.equal(response.status, 200);
      return { headers: response.headers, value: await response.json() as EthereumRevealTokensResponse };
    };
    const advance = async (milliseconds: number) => {
      const response = await worker.fetch('https://cache.test/advance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ milliseconds }),
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    };

    const first = await read(['21', '7', '21']);
    assert.equal(first.headers.get('X-Test-Cache'), 'miss');
    assert.equal(first.headers.get('X-Test-Origin-Calls'), '1');
    assert.equal(first.headers.get('X-Test-Stored'), 'true');
    assert.deepEqual(first.value.artworks.map(artwork => artwork.tokenId), ['21', '7']);
    const reordered = await read(['7', '21']);
    assert.equal(reordered.headers.get('X-Test-Cache'), 'hit');
    assert.equal(reordered.headers.get('X-Test-Origin-Calls'), '1');
    assert.deepEqual(reordered.value.artworks.map(artwork => artwork.tokenId), ['7', '21']);

    const revision = await read(['7', '21'], { revision: 10 });
    assert.equal(revision.headers.get('X-Test-Cache'), 'miss');
    assert.equal(revision.headers.get('X-Test-Origin-Calls'), '2');
    const catalog = await read(['7', '21'], { catalogRevision: 2 });
    assert.equal(catalog.headers.get('X-Test-Cache'), 'miss');
    assert.equal(catalog.headers.get('X-Test-Origin-Calls'), '3');
    assert.equal(catalog.value.catalogRevision, 2);

    for (const count of [4, 5]) {
      const partial = await read(['41', '42'], { mode: 'partial' });
      assert.equal(partial.headers.get('X-Test-Cache'), 'miss');
      assert.equal(partial.headers.get('X-Test-Origin-Calls'), String(count));
      assert.equal(partial.headers.get('X-Test-Stored'), 'false');
      assert.deepEqual(partial.value.unresolved, [{ tokenId: '42', status: 'recovering' }]);
    }
    const completed = await read(['41', '42']);
    assert.equal(completed.headers.get('X-Test-Origin-Calls'), '6');
    assert.equal(completed.headers.get('X-Test-Stored'), 'true');
    assert.equal((await read(['42', '41'])).headers.get('X-Test-Cache'), 'hit');

    const base = await read(['81']);
    assert.equal(base.headers.get('X-Test-Origin-Calls'), '7');
    assert.match(base.headers.get('X-Test-Stored-Cache-Control') ?? '', /max-age=2(?:\D|$)/);
    await advance(2100);
    const expiredBase = await read(['81']);
    assert.equal(expiredBase.headers.get('X-Test-Cache'), 'miss');
    assert.equal(expiredBase.headers.get('X-Test-Origin-Calls'), '8');

    const enriched = await read(['101'], { mode: 'enriched' });
    assert.equal(enriched.headers.get('X-Test-Origin-Calls'), '9');
    assert.match(enriched.headers.get('X-Test-Stored-Cache-Control') ?? '', /max-age=5(?:\D|$)/);
    await advance(2100);
    const stillFresh = await read(['101'], { mode: 'enriched' });
    assert.equal(stillFresh.headers.get('X-Test-Cache'), 'hit');
    assert.equal(stillFresh.headers.get('X-Test-Origin-Calls'), '9');
    await advance(3100);
    const expiredEnriched = await read(['101'], { mode: 'enriched' });
    assert.equal(expiredEnriched.headers.get('X-Test-Cache'), 'miss');
    assert.equal(expiredEnriched.headers.get('X-Test-Origin-Calls'), '10');
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
