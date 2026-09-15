import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestHarness } from 'wrangler';
import {
  MI_NOTE_2_CONTRACT_ADDRESS,
  MI_NOTE_3_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESSES,
} from '../../../../shared/miNoteCards.js';

test('Mi Note ownership uses native workerd fetch for pagination and rejects redirects', async (context) => {
  const productionConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const owner = '0x000533f50ddd7f2fc4EfD06137b0c1A12CfB7Bb9';
  const apiKey = 'mi-note-runtime-test-key';
  const origin = 'https://mons.shop';
  const pageKey = 'next +/&=?';
  const outboundUrls: URL[] = [];
  let redirectStatus: number | undefined;
  const server = createTestHarness({
    root: resolve('.'),
    workers: [{
      config: {
        name: 'mi-note-cards-runtime',
        main: resolve('cloud/workers/api/src/index.ts'),
        compatibility_date: productionConfig.compatibility_date,
        compatibility_flags: productionConfig.compatibility_flags,
        vars: { ALCHEMY_MI_NOTE_API_KEY: apiKey },
      },
    }],
  });
  try {
    await server.listen();
    context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      outboundUrls.push(url);
      assert.equal(url.origin, 'https://eth-mainnet.g.alchemy.com');
      assert.equal(url.pathname, `/nft/v3/${apiKey}/getNFTsForOwner`);
      assert.equal(init?.method, 'GET');
      assert.deepEqual(url.searchParams.getAll('contractAddresses[]'), [...MI_NOTE_CONTRACT_ADDRESSES]);
      assert.equal(url.searchParams.get('withMetadata'), 'false');
      assert.equal(url.searchParams.get('pageSize'), '100');
      if (redirectStatus !== undefined) {
        return new Response(null, {
          status: redirectStatus,
          headers: { Location: 'https://redirect-target.example/ownership' },
        });
      }
      assert.equal(url.searchParams.get('owner'), owner.toLowerCase());
      const cursor = url.searchParams.get('pageKey');
      assert.ok(cursor === null || cursor === pageKey);
      return Response.json({
        ownedNfts: [
          ...(cursor === null ? ['12', '2'] : ['4', '12']).map((tokenId) => ({
            contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, tokenId, balance: '1',
          })),
          ...(cursor === null ? ['2'] : ['12', '1']).map((tokenId) => ({
            contractAddress: MI_NOTE_3_CONTRACT_ADDRESS, tokenId, balance: '1',
          })),
        ],
        pageKey: cursor === null ? pageKey : null,
      });
    });
    const worker = server.getWorker('mi-note-cards-runtime');
    const response = await worker.fetch(`https://api.mons.shop/mi-note-cards?address=${owner}&version=2`, {
      headers: { Origin: origin },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      tokenIdsByContract: {
        [MI_NOTE_2_CONTRACT_ADDRESS]: ['2', '4', '12'],
        [MI_NOTE_3_CONTRACT_ADDRESS]: ['1', '2', '12'],
      },
    });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(outboundUrls.length, 2);
    assert.equal(outboundUrls[0].searchParams.get('pageKey'), null);
    assert.equal(outboundUrls[1].searchParams.get('pageKey'), pageKey);

    const legacy = await worker.fetch(`https://api.mons.shop/mi-note-cards?address=${owner}`, {
      headers: { Origin: origin },
    });
    assert.equal(legacy.status, 200);
    assert.deepEqual(await legacy.json(), { ok: true, tokenIds: ['2', '4', '12'] });

    for (const status of [301, 302, 303, 307, 308]) {
      redirectStatus = status;
      const previousCalls: number = outboundUrls.length;
      const redirectOwner = `0x${status.toString(16).padStart(40, '0')}`;
      const redirected = await worker.fetch(`https://api.mons.shop/mi-note-cards?address=${redirectOwner}&version=2`, {
        headers: { Origin: origin },
      });
      assert.equal(redirected.status, 502);
      assert.deepEqual(await redirected.json(), { ok: false, error: 'provider-unavailable' });
      assert.equal(redirected.headers.get('Access-Control-Allow-Origin'), origin);
      assert.equal(outboundUrls.length, previousCalls + 1);
      assert.equal(outboundUrls.at(-1)?.searchParams.get('owner'), redirectOwner);
    }
  } finally {
    await server.close();
  }
});
