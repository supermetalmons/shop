import test from 'node:test';
import assert from 'node:assert/strict';
import { MI_NOTE_2_CONTRACT_ADDRESS, MI_NOTE_CARDS_API_PATH } from '../../../../shared/miNoteCards.ts';
import { handleMiNoteCards } from '../src/miNoteCards.ts';

const OWNER = '0x000533f50ddd7f2fc4EfD06137b0c1A12CfB7Bb9';
const ORIGIN = 'https://mons.shop';
const API_KEY = 'private-test-key';
const NOW = 1_800_000_000_000;
const EXPIRY_HEADER = 'X-Mi-Note-Cards-Expires-At';
type Dependencies = Parameters<typeof handleMiNoteCards>[2];
type Metrics = Parameters<typeof handleMiNoteCards>[3];

function nft(tokenId: string, balance = '1') {
  return { contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, tokenId, balance };
}

function page(tokenIds: string[] = ['1'], pageKey?: string | null) {
  return Response.json({ ownedNfts: tokenIds.map((id) => nft(id)), pageKey });
}

function request(search = `?address=${OWNER}`, options: RequestInit = {}) {
  return new Request(`https://api.mons.shop${MI_NOTE_CARDS_API_PATH}${search}`, {
    ...options,
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.1', ...options.headers },
  });
}

function setup(overrides: Partial<Dependencies> = {}) {
  const logs: Record<string, unknown>[] = [];
  const deferred: Promise<unknown>[] = [];
  const rateKeys: string[] = [];
  const metrics: Metrics = {
    upstreamCalls: 0,
    providerDurationMs: 0,
    expectedAssetIds: 0,
    expectedAssetRecoveryFailures: 0,
    expectedAssetResolved: 0,
  };
  const dependencies: Dependencies = {
    cache: null,
    providerFetch: async () => page(),
    log: (entry) => logs.push(entry),
    now: () => NOW,
    ...overrides,
  };
  const env = {
    ALCHEMY_MI_NOTE_API_KEY: API_KEY,
    PUBLIC_SHOP_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        rateKeys.push(key);
        return { success: true };
      },
    },
  };
  return {
    logs,
    deferred,
    rateKeys,
    metrics,
    env,
    dependencies,
    run: (input = request()) => handleMiNoteCards(
      input, env, dependencies, metrics, (work) => deferred.push(work),
    ),
  };
}

function assertCors(response: Response, origin = ORIGIN) {
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal(response.headers.get('Vary'), 'Origin');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}

test('mi note ownership sends fixed collection queries and follows encoded cursors', async () => {
  const urls: URL[] = [];
  const fixture = setup({
    providerFetch: async (input, init) => {
      urls.push(new URL(String(input)));
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      assert.ok(init?.signal);
      return urls.length === 1 ? page(['12', '2'], 'cursor +/&=?') : page(['4'], null);
    },
  });
  const result = await fixture.run();
  assert.equal(result.response.status, 200);
  assert.equal(result.cacheStatus, 'MISS');
  assert.deepEqual(await result.response.json(), { ok: true, tokenIds: ['2', '4', '12'] });
  assert.equal(urls.length, 2);
  for (const [index, url] of urls.entries()) {
    assert.equal(url.origin, 'https://eth-mainnet.g.alchemy.com');
    assert.equal(url.pathname, `/nft/v3/${API_KEY}/getNFTsForOwner`);
    assert.equal(url.searchParams.get('owner'), OWNER.toLowerCase());
    assert.deepEqual(url.searchParams.getAll('contractAddresses[]'), [MI_NOTE_2_CONTRACT_ADDRESS]);
    assert.equal(url.searchParams.get('withMetadata'), 'false');
    assert.equal(url.searchParams.get('pageSize'), '100');
    assert.equal(url.searchParams.get('pageKey'), index === 0 ? null : 'cursor +/&=?');
    assert.equal(url.searchParams.has('excludeFilters[]'), false);
  }
  assert.deepEqual(fixture.rateKeys, [`${MI_NOTE_CARDS_API_PATH}:192.0.2.1`]);
  assert.equal(fixture.metrics.upstreamCalls, 2);
  assert.ok(fixture.metrics.providerDurationMs >= 0);
  assertCors(result.response);
});

test('mi note ownership normalizes uint256 IDs, deduplicates, and excludes zero balances', async () => {
  let calls = 0;
  const maxId = ((1n << 256n) - 1n).toString();
  const fixture = setup({
    providerFetch: async () => {
      calls += 1;
      return Response.json({
        ownedNfts: calls === 1
          ? [nft('0x0a'), nft('00010'), nft('0'), nft('4', '0'), nft(maxId)]
          : [{ ...nft('10'), contractAddress: `0x${MI_NOTE_2_CONTRACT_ADDRESS.slice(2).toUpperCase()}` }],
        pageKey: calls === 1 ? 'next' : null,
      });
    },
  });
  const result = await fixture.run();
  assert.deepEqual(await result.response.json(), { ok: true, tokenIds: ['0', '10', maxId] });
});

for (const search of ['', '?address=', '?address=garbage', `?address=${OWNER}&address=${OWNER}`, '?address=vitalik.eth']) {
  test(`mi note ownership rejects invalid address query ${search || '(missing)'}`, async () => {
    const fixture = setup();
    const result = await fixture.run(request(search));
    assert.equal(result.response.status, 400);
    assert.equal(fixture.metrics.upstreamCalls, 0);
    assert.equal(fixture.rateKeys.length, 0);
    assertCors(result.response);
  });
}

test('mi note ownership rejects missing or disallowed origins', async () => {
  const fixture = setup();
  for (const origin of ['', 'https://example.com']) {
    const input = request();
    if (origin) input.headers.set('Origin', origin);
    else input.headers.delete('Origin');
    const result = await fixture.run(input);
    assert.equal(result.response.status, 403);
    assert.equal(result.response.headers.has('Access-Control-Allow-Origin'), false);
  }
  assert.equal(fixture.metrics.upstreamCalls, 0);
});

test('mi note ownership returns 502 with CORS when the dedicated key is missing', async () => {
  const fixture = setup();
  fixture.env.ALCHEMY_MI_NOTE_API_KEY = '';
  const result = await fixture.run();
  assert.equal(result.response.status, 502);
  assert.equal(fixture.metrics.upstreamCalls, 0);
  assertCors(result.response);
});

for (const invalid of [
  null,
  {},
  { ownedNfts: null },
  { ownedNfts: [{}] },
  { ownedNfts: [{ ...nft('1'), contractAddress: OWNER }] },
  { ownedNfts: [{ contract: { address: MI_NOTE_2_CONTRACT_ADDRESS }, tokenId: '1', balance: '1' }] },
  { ownedNfts: [nft('-1')] },
  { ownedNfts: [nft('1.5')] },
  { ownedNfts: [nft('0xz')] },
  { ownedNfts: [nft((1n << 256n).toString())] },
  { ownedNfts: [nft('1', '-1')] },
  { ownedNfts: [{ ...nft('1'), balance: 1 }] },
  { ownedNfts: [{ ...nft('1'), tokenId: 1 }] },
  { ownedNfts: Array.from({ length: 101 }, (_, index) => nft(String(index))) },
  { ownedNfts: [], pageKey: '' },
  { ownedNfts: [], pageKey: 1 },
  { ownedNfts: [], pageKey: 'a'.repeat(4097) },
]) {
  test(`mi note ownership rejects malformed provider data ${JSON.stringify(invalid).slice(0, 100)}`, async () => {
    const fixture = setup({ providerFetch: async () => Response.json(invalid) });
    const result = await fixture.run();
    assert.equal(result.response.status, 502);
    assert.deepEqual(await result.response.json(), { ok: false, error: 'provider-unavailable' });
    assert.equal(fixture.deferred.length, 0);
    assertCors(result.response);
  });
}

test('mi note ownership rejects repeating pagination cursors and discards partial results', async () => {
  const fixture = setup({ providerFetch: async () => page(['1'], 'repeat') });
  const result = await fixture.run();
  assert.equal(result.response.status, 502);
  assert.equal(fixture.metrics.upstreamCalls, 2);
  assert.equal(fixture.deferred.length, 0);
});

test('mi note ownership accepts exactly 100 complete pages and rejects further pagination', async () => {
  for (const complete of [true, false]) {
    let calls = 0;
    const fixture = setup({
      providerFetch: async () => {
        const offset = calls * 100;
        calls += 1;
        return page(
          Array.from({ length: 100 }, (_, index) => String(offset + index)),
          complete && calls === 100 ? null : String(calls),
        );
      },
    });
    const result = await fixture.run();
    assert.equal(fixture.metrics.upstreamCalls, 100);
    assert.equal(result.response.status, complete ? 200 : 502);
    if (complete) {
      const body = await result.response.json() as { tokenIds: string[] };
      assert.equal(body.tokenIds.length, 10_000);
      assert.equal(body.tokenIds.at(-1), '9999');
    }
  }
});

test('mi note ownership bounds declared and streamed page bodies and does not await stalled cancellation', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const fixture = setup({
      providerFetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          if (!declared) controller.enqueue(new TextEncoder().encode(' '.repeat(256 * 1024 + 1)));
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => undefined);
        },
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...(declared ? { 'Content-Length': String(256 * 1024 + 1) } : {}),
        },
      }),
    });
    const result = await fixture.run();
    assert.equal(result.response.status, 502);
    assert.equal(cancelled, true);
  }
});

test('mi note ownership rejects non-JSON, malformed JSON, and invalid UTF-8', async () => {
  for (const response of [
    new Response('<html>error</html>'),
    new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const fixture = setup({ providerFetch: async () => response });
    assert.equal((await fixture.run()).response.status, 502);
  }
});

test('mi note ownership cancels provider HTTP failures and never logs upstream details', async () => {
  let cancelled = false;
  const fixture = setup({
    providerFetch: async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { status: 429 }),
  });
  const result = await fixture.run();
  assert.equal(result.response.status, 502);
  assert.equal(cancelled, true);
  fixture.dependencies.providerFetch = async () => {
    throw new Error(`https://eth-mainnet.g.alchemy.com/${API_KEY}`);
  };
  assert.equal((await fixture.run()).response.status, 502);
  assert.equal(JSON.stringify(fixture.logs).includes(API_KEY), false);
  assert.equal(JSON.stringify(fixture.logs).includes('alchemy.com'), false);
});

test('mi note ownership times out stalled headers and cancels late provider responses', async () => {
  let resolveFetch!: (response: Response) => void;
  let cancelled = false;
  let providerSignal: AbortSignal | null | undefined;
  const fixture = setup({
    timeoutMs: 10,
    providerFetch: async (_input, init) => {
      providerSignal = init?.signal;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    },
  });
  const result = await fixture.run();
  assert.equal(result.response.status, 504);
  assert.equal(providerSignal?.aborted, true);
  assertCors(result.response);
  resolveFetch(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('mi note ownership uses one total deadline across pages and body reads', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let cancelled = false;
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  let resolveFirst!: (response: Response) => void;
  const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
  const secondReady = new Promise<void>((resolve) => { secondStarted = resolve; });
  const fixture = setup({
    timeoutMs: 30,
    providerFetch: async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        return new Promise<Response>((resolve) => { resolveFirst = resolve; });
      }
      secondStarted();
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; },
      }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  const pending = fixture.run();
  await firstReady;
  context.mock.timers.tick(20);
  resolveFirst(page(['1'], 'next'));
  await secondReady;
  context.mock.timers.tick(10);
  const result = await pending;
  assert.equal(result.response.status, 504);
  assert.equal(calls, 2);
  assert.equal(cancelled, true);
  assert.equal(fixture.deferred.length, 0);
});

test('mi note ownership preserves client cancellation and does not cache partial data', async () => {
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const fixture = setup({
    providerFetch: async () => {
      started();
      return new Promise<Response>(() => undefined);
    },
  });
  const pending = fixture.run(request(undefined, { signal: controller.signal }));
  await ready;
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(fixture.deferred.length, 0);
});

test('mi note ownership caches populated and empty results for 60 seconds per lowercase owner', async () => {
  for (const tokenIds of [[], ['1', '2']]) {
    const entries = new Map<string, Response>();
    const fixture = setup({
      providerFetch: async () => page(tokenIds),
      cache: {
        match: async (input) => entries.get(new Request(input).url)?.clone(),
        put: async (input, response) => { entries.set(new Request(input).url, response.clone()); },
      },
    });
    const first = await fixture.run();
    assert.equal(first.cacheStatus, 'MISS');
    assertCors(first.response);
    await Promise.all(fixture.deferred);
    assert.equal(entries.size, 1);
    const [cacheUrl, cached] = [...entries.entries()][0];
    assert.equal(new URL(cacheUrl).searchParams.get('address'), OWNER.toLowerCase());
    assert.equal(cached.headers.get('Cache-Control'), 'public, max-age=60');
    assert.equal(cached.headers.get(EXPIRY_HEADER), String(NOW + 60_000));
    assert.equal(cached.headers.has('Access-Control-Allow-Origin'), false);
    assert.equal(cached.headers.has('Vary'), false);
    const second = await fixture.run(request(`?address=${OWNER.toLowerCase()}`, {
      headers: { Origin: 'http://localhost:5173' },
    }));
    assert.equal(second.cacheStatus, 'HIT');
    assert.equal(fixture.metrics.upstreamCalls, 1);
    assert.deepEqual(await second.response.json(), { ok: true, tokenIds });
    assert.equal(second.response.headers.has(EXPIRY_HEADER), false);
    assertCors(second.response, 'http://localhost:5173');
  }
});

for (const cached of [
  () => Response.json({ ok: true, tokenIds: ['1'] }),
  () => Response.json({ ok: true, tokenIds: ['1'] }, { headers: { [EXPIRY_HEADER]: String(NOW) } }),
  () => Response.json({ ok: true, tokenIds: ['1'] }, { headers: { [EXPIRY_HEADER]: String(NOW + 60_001) } }),
  () => Response.json({ ok: true, tokenIds: ['01'] }, { headers: { [EXPIRY_HEADER]: String(NOW + 60_000) } }),
  () => Response.json({ ok: true, tokenIds: ['1', '1'] }, { headers: { [EXPIRY_HEADER]: String(NOW + 60_000) } }),
  () => new Response('{', { headers: { 'Content-Type': 'application/json', [EXPIRY_HEADER]: String(NOW + 60_000) } }),
]) {
  test('mi note ownership treats invalid or expired cached results as misses', async () => {
    const fixture = setup({ cache: { match: async () => cached(), put: async () => undefined } });
    const result = await fixture.run();
    assert.equal(result.cacheStatus, 'MISS');
    assert.equal(fixture.metrics.upstreamCalls, 1);
    assert.deepEqual(await result.response.json(), { ok: true, tokenIds: ['1'] });
    await Promise.all(fixture.deferred);
  });
}

test('mi note ownership tolerates cache and logging failures', async () => {
  const fixture = setup({
    cache: {
      match: async () => { throw new Error('cache read failed'); },
      put: async () => { throw new Error('cache write failed'); },
    },
    log: () => { throw new Error('log failed'); },
  });
  const result = await fixture.run();
  assert.equal(result.response.status, 200);
  assert.equal(result.cacheStatus, 'MISS');
  await Promise.all(fixture.deferred);
});

test('mi note ownership rechecks cache expiry after reading the body', async () => {
  let currentTime = NOW;
  const fixture = setup({
    now: () => currentTime,
    cache: {
      match: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          currentTime = NOW + 1;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, tokenIds: ['8'] })));
          controller.close();
        },
      }, { highWaterMark: 0 }), {
        headers: { 'Content-Type': 'application/json', [EXPIRY_HEADER]: String(NOW + 1) },
      }),
      put: async () => undefined,
    },
  });
  const result = await fixture.run();
  assert.equal(result.cacheStatus, 'MISS');
  assert.deepEqual(await result.response.json(), { ok: true, tokenIds: ['1'] });
  await Promise.all(fixture.deferred);
});

test('mi note ownership preserves successful responses if deferred cache registration fails', async () => {
  const fixture = setup({
    cache: { match: async () => undefined, put: async () => undefined },
  });
  const result = await handleMiNoteCards(
    request(), fixture.env, fixture.dependencies, fixture.metrics,
    () => { throw new Error('deferred registration failed'); },
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { ok: true, tokenIds: ['1'] });
  assert.equal(fixture.logs.some((entry) => entry.event === 'mi_note_cards_cache_registration_failed'), true);
});

test('mi note ownership accepts a response body exactly at the page byte limit', async () => {
  const json = JSON.stringify({ ownedNfts: [nft('1')] });
  const fixture = setup({
    providerFetch: async () => new Response(json.padEnd(256 * 1024, ' '), {
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(256 * 1024) },
    }),
  });
  assert.equal((await fixture.run()).response.status, 200);
});

test('mi note ownership never caches partial results if a later page fails', async () => {
  let calls = 0;
  let puts = 0;
  const fixture = setup({
    cache: { match: async () => undefined, put: async () => { puts += 1; } },
    providerFetch: async () => {
      calls += 1;
      return calls === 1 ? page(['1'], 'next') : Response.json({ error: 'failed' }, { status: 503 });
    },
  });
  const result = await fixture.run();
  assert.equal(result.response.status, 502);
  assert.equal(puts, 0);
  assert.equal(fixture.deferred.length, 0);
  assertCors(result.response);
});

test('mi note ownership preserves an already-aborted request without a provider lookup', async () => {
  const fixture = setup();
  const controller = new AbortController();
  const reason = new Error('already cancelled');
  controller.abort(reason);
  await assert.rejects(
    fixture.run(request(undefined, { signal: controller.signal })),
    (error: unknown) => error === reason,
  );
  assert.equal(fixture.metrics.upstreamCalls, 0);
});

test('mi note ownership does not turn observation-only rate limits into rejection', async () => {
  const fixture = setup();
  fixture.env.PUBLIC_SHOP_RATE_LIMITER.limit = async () => ({ success: false });
  assert.equal((await fixture.run()).response.status, 200);
  assert.equal(fixture.logs.some((entry) => entry.event === 'public_rate_limit_would_block'), true);
});
