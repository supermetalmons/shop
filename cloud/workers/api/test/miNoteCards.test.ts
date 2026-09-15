import test from 'node:test';
import assert from 'node:assert/strict';
import miNoteCollections from '../../../../mi_note_eth.json';
import {
  MI_NOTE_CONTRACT_ADDRESS,
  MI_NOTE_2_CONTRACT_ADDRESS,
  MI_NOTE_3_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESSES,
  MI_NOTE_CARDS_API_PATH,
  type MiNoteContractAddress,
} from '../../../../shared/miNoteCards.ts';
import { handleMiNoteCards } from '../src/miNoteCards.ts';

const OWNER = '0x000533f50ddd7f2fc4EfD06137b0c1A12CfB7Bb9';
const ORIGIN = 'https://mons.shop';
const API_KEY = 'private-alchemy-test-key';
const OPENSEA_KEY = 'private-opensea-test-key';
const NOW = 1_800_000_000_000;
const EXPIRY_HEADER = 'X-Mi-Note-Cards-Expires-At';
const ORIGINAL_IDS = miNoteCollections.find((collection) => collection.contractAddress === MI_NOTE_CONTRACT_ADDRESS)!.tokens.map((token) => token.id);
type Dependencies = Parameters<typeof handleMiNoteCards>[2];
type Metrics = Parameters<typeof handleMiNoteCards>[3];
type ProviderFetch = Dependencies['providerFetch'];
type Provider = 'alchemy' | 'opensea';
type Failure = 'provider-timeout' | 'provider-unavailable';

function nft(tokenId: string, balance = '1', contractAddress: MiNoteContractAddress = MI_NOTE_2_CONTRACT_ADDRESS) {
  return { contractAddress, tokenId, balance };
}

function page(tokenIds: string[] = ['1'], pageKey?: string | null) {
  return Response.json({ ownedNfts: tokenIds.map((id) => nft(id)), pageKey });
}

function openSeaPage(tokenIds: string[] = [], next?: string | null) {
  return Response.json({
    nfts: tokenIds.map((identifier) => ({
      identifier, contract: MI_NOTE_CONTRACT_ADDRESS, collection: 'minote', token_standard: 'erc1155',
    })),
    next,
  });
}

function expectedProvider(contract: MiNoteContractAddress): Provider {
  return contract === MI_NOTE_CONTRACT_ADDRESS ? 'opensea' : 'alchemy';
}

function collectionOwnership(contractAddress: MiNoteContractAddress, tokenIds: string[] = [], provider = expectedProvider(contractAddress)) {
  return { contractAddress, tokenIds, provider, visibilityLimited: provider === 'opensea' };
}

function success(provider: Provider = 'alchemy') {
  return { status: 'success', provider, visibilityLimited: provider === 'opensea' };
}

function failure(error: Failure = 'provider-unavailable') {
  return { status: 'error', error };
}

function ownership(two: string[] = ['1'], three: string[] = [], original: string[] = []) {
  return {
    ok: true,
    tokenIdsByContract: {
      [MI_NOTE_3_CONTRACT_ADDRESS]: three,
      [MI_NOTE_2_CONTRACT_ADDRESS]: two,
      [MI_NOTE_CONTRACT_ADDRESS]: original,
    },
    resultsByContract: {
      [MI_NOTE_3_CONTRACT_ADDRESS]: success(),
      [MI_NOTE_2_CONTRACT_ADDRESS]: success(),
      [MI_NOTE_CONTRACT_ADDRESS]: success('opensea'),
    },
  };
}

function request(search = `?address=${OWNER}`, options: RequestInit = {}) {
  return new Request(`https://api.mons.shop${MI_NOTE_CARDS_API_PATH}${search}`, {
    ...options,
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.1', ...options.headers },
  });
}

function inputUrl(input: Parameters<ProviderFetch>[0]) {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}

function setup(options: Partial<Dependencies> & { nfts?: ProviderFetch; opensea?: ProviderFetch } = {}) {
  const { nfts = async () => page(), opensea = async () => openSeaPage(), ...overrides } = options;
  const logs: Record<string, unknown>[] = [];
  const deferred: Promise<unknown>[] = [];
  const rateKeys: string[] = [];
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const metrics: Metrics = {
    upstreamCalls: 0, providerDurationMs: 0, expectedAssetIds: 0,
    expectedAssetRecoveryFailures: 0, expectedAssetResolved: 0,
  };
  const dependencies: Dependencies = {
    cache: null,
    providerFetch: async (input, init) => {
      const url = inputUrl(input);
      calls.push({ url, init });
      if (url.origin === 'https://api.opensea.io') {
        assert.equal(url.searchParams.get('collection'), 'minote');
        return opensea(input, init);
      }
      assert.equal(url.origin, 'https://eth-mainnet.g.alchemy.com');
      assert.equal(url.pathname, `/nft/v3/${API_KEY}/getNFTsForOwner`);
      return nfts(input, init);
    },
    log: (entry) => logs.push(entry),
    now: () => NOW,
    ...overrides,
  };
  const env = {
    ALCHEMY_MI_NOTE_API_KEY: API_KEY,
    OPENSEA_API_KEY: OPENSEA_KEY,
    PUBLIC_SHOP_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        rateKeys.push(key);
        return { success: true };
      },
    },
  };
  return {
    logs, deferred, rateKeys, calls, metrics, env, dependencies,
    run: (input = request()) => handleMiNoteCards(input, env, dependencies, metrics, (work) => deferred.push(work)),
  };
}

function memoryCache() {
  const entries = new Map<string, Response>();
  return {
    entries,
    cache: {
      match: async (input: RequestInfo | URL) => entries.get(new Request(input).url)?.clone(),
      put: async (input: RequestInfo | URL, response: Response) => { entries.set(new Request(input).url, response.clone()); },
    },
  };
}

function cacheUrl(contract: MiNoteContractAddress, version = 4) {
  return `https://api.mons.shop${MI_NOTE_CARDS_API_PATH}?address=${OWNER.toLowerCase()}&contract=${contract}&version=${version}`;
}

function cachedOwnership(contract: MiNoteContractAddress, ids: string[] = [], provider = expectedProvider(contract)) {
  return Response.json(collectionOwnership(contract, ids, provider), {
    headers: { [EXPIRY_HEADER]: String(NOW + 60_000), 'Cache-Control': 'public, max-age=60' },
  });
}

function assertCors(response: Response, origin = ORIGIN) {
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal(response.headers.get('Vary'), 'Origin');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}

async function assertIndexedFailure(response: Response) {
  assert.equal(response.status, 200);
  const body = await response.json() as ReturnType<typeof ownership>;
  assert.deepEqual(body.tokenIdsByContract[MI_NOTE_2_CONTRACT_ADDRESS], []);
  assert.deepEqual(body.tokenIdsByContract[MI_NOTE_3_CONTRACT_ADDRESS], []);
  assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], success('opensea'));
  assert.deepEqual(body.resultsByContract[MI_NOTE_2_CONTRACT_ADDRESS], failure());
  assert.deepEqual(body.resultsByContract[MI_NOTE_3_CONTRACT_ADDRESS], failure());
  assertCors(response);
}

async function assertOriginalFailure(response: Response) {
  assert.equal(response.status, 200);
  const body = await response.json() as ReturnType<typeof ownership>;
  assert.deepEqual(body.tokenIdsByContract[MI_NOTE_CONTRACT_ADDRESS], []);
  assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], failure());
  assert.deepEqual(body.resultsByContract[MI_NOTE_2_CONTRACT_ADDRESS], success());
  assert.deepEqual(body.resultsByContract[MI_NOTE_3_CONTRACT_ADDRESS], success());
  assertCors(response);
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('mi note ownership sends fixed Alchemy and OpenSea requests and follows encoded cursors', async () => {
  let alchemyPages = 0;
  let openSeaPages = 0;
  const fixture = setup({
    nfts: async (input, init) => {
      const url = inputUrl(input);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      assert.ok(init?.signal);
      assert.equal(url.searchParams.get('owner'), OWNER.toLowerCase());
      assert.deepEqual(url.searchParams.getAll('contractAddresses[]'), [MI_NOTE_2_CONTRACT_ADDRESS, MI_NOTE_3_CONTRACT_ADDRESS]);
      assert.equal(url.searchParams.get('withMetadata'), 'false');
      assert.equal(url.searchParams.get('pageSize'), '100');
      alchemyPages += 1;
      assert.equal(url.searchParams.get('pageKey'), alchemyPages === 1 ? null : 'alchemy +/&=?');
      return Response.json({
        ownedNfts: alchemyPages === 1 ? [nft('12'), nft('0x02', '1', MI_NOTE_3_CONTRACT_ADDRESS)] : [nft('2'), nft('12'), nft('4', '1', MI_NOTE_3_CONTRACT_ADDRESS)],
        pageKey: alchemyPages === 1 ? 'alchemy +/&=?' : null,
      });
    },
    opensea: async (input, init) => {
      const url = inputUrl(input);
      assert.equal(url.pathname, `/api/v2/chain/ethereum/account/${OWNER.toLowerCase()}/nfts`);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('x-api-key'), OPENSEA_KEY);
      assert.equal(new Headers(init?.headers).get('Accept'), 'application/json');
      assert.equal(url.searchParams.get('collection'), 'minote');
      assert.equal(url.searchParams.get('include_auto_hidden'), 'true');
      assert.equal(url.searchParams.get('limit'), '100');
      openSeaPages += 1;
      assert.equal(url.searchParams.get('next'), openSeaPages === 1 ? null : 'opensea +/&=?');
      return openSeaPages === 1 ? openSeaPage([ORIGINAL_IDS[0]], 'opensea +/&=?') : openSeaPage([ORIGINAL_IDS[0], ORIGINAL_IDS[165]]);
    },
  });
  const result = await fixture.run();
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), ownership(['2', '12'], ['2', '4'], [ORIGINAL_IDS[0], ORIGINAL_IDS[165]]));
  assert.equal(fixture.metrics.upstreamCalls, 4);
  assert.deepEqual(fixture.rateKeys, [`${MI_NOTE_CARDS_API_PATH}:192.0.2.1`]);
  assertCors(result.response);
});

for (const finishedFirst of ['alchemy', 'opensea'] as const) {
  test(`mi note starts both providers immediately and waits for both when ${finishedFirst} finishes first`, async () => {
    const alchemy = Promise.withResolvers<Response>();
    const opensea = Promise.withResolvers<Response>();
    const fixture = setup({ nfts: async () => alchemy.promise, opensea: async () => opensea.promise });
    let completed = false;
    const pending = fixture.run(request(undefined, { headers: { Accept: 'application/x-ndjson' } })).then((result) => {
      completed = true;
      return result;
    });
    await settle();
    assert.equal(fixture.calls.length, 2);
    assert.equal(completed, false);
    if (finishedFirst === 'alchemy') alchemy.resolve(page(['2']));
    else opensea.resolve(openSeaPage([ORIGINAL_IDS[0]]));
    await settle();
    assert.equal(completed, false);
    if (finishedFirst === 'alchemy') opensea.resolve(openSeaPage([ORIGINAL_IDS[0]]));
    else alchemy.resolve(page(['2']));
    const { response } = await pending;
    assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
    assert.deepEqual(await response.json(), ownership(['2'], [], [ORIGINAL_IDS[0]]));
    assert.equal(fixture.calls.length, 2);
  });
}

test('mi note ownership normalizes uint256 IDs, deduplicates, and excludes zero balances', async () => {
  const maxId = ((1n << 256n) - 1n).toString();
  const fixture = setup({ nfts: async () => Response.json({ ownedNfts: [nft('0x0a'), nft('00010'), nft('0'), nft('4', '0'), nft(maxId)] }) });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership(['0', '10', maxId]));
});

test('mi note OpenSea original results exclude unrelated shared-contract tokens', async () => {
  const fixture = setup({ opensea: async () => openSeaPage(['1', ORIGINAL_IDS[0], ORIGINAL_IDS[165]]) });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership(['1'], [], [ORIGINAL_IDS[0], ORIGINAL_IDS[165]]));
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

for (const failed of ['alchemy', 'opensea'] as const) {
  test(`mi note ${failed} failures remain partial errors without fallback or retries`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = setup({
      nfts: async () => failed === 'alchemy' ? new Response(null, { status: 503 }) : page(),
      opensea: async () => failed === 'opensea' ? new Response(null, { status: 503 }) : openSeaPage(),
    });
    const result = await fixture.run();
    if (failed === 'alchemy') await assertIndexedFailure(result.response);
    else await assertOriginalFailure(result.response);
    context.mock.timers.tick(60_000);
    await settle();
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls.filter(({ url }) => url.origin === 'https://api.opensea.io').length, 1);
  });
}

test('mi note empty results are successful and retain fixed provider metadata', async () => {
  const fixture = setup({ nfts: async () => page([]) });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership([]));
  assert.equal(fixture.calls.length, 2);
});

for (const invalid of [
  null, {}, { nfts: null }, { nfts: [{}] },
  { nfts: [{ identifier: '1', contract: OWNER, collection: 'minote', token_standard: 'erc1155' }] },
  { nfts: [{ identifier: ORIGINAL_IDS[0], contract: MI_NOTE_CONTRACT_ADDRESS, collection: 'other', token_standard: 'erc1155' }] },
  { nfts: [{ identifier: ORIGINAL_IDS[0], contract: MI_NOTE_CONTRACT_ADDRESS, collection: 'minote', token_standard: 'erc721' }] },
  { nfts: [{ identifier: '-1', contract: MI_NOTE_CONTRACT_ADDRESS, collection: 'minote', token_standard: 'erc1155' }] },
  { nfts: [{ identifier: 1, contract: MI_NOTE_CONTRACT_ADDRESS, collection: 'minote', token_standard: 'erc1155' }] },
  { nfts: [], next: '' }, { nfts: [], next: 1 }, { nfts: [], next: 'a'.repeat(4097) },
]) {
  test(`mi note ownership rejects malformed OpenSea data ${JSON.stringify(invalid).slice(0, 80)}`, async () => {
    await assertOriginalFailure((await setup({ opensea: async () => Response.json(invalid) }).run()).response);
  });
}

for (const invalid of [
  null, {}, { ownedNfts: null }, { ownedNfts: [{}] },
  { ownedNfts: [{ ...nft('1'), contractAddress: OWNER }] },
  { ownedNfts: [{ contract: { address: MI_NOTE_2_CONTRACT_ADDRESS }, tokenId: '1', balance: '1' }] },
  { ownedNfts: [nft('-1')] }, { ownedNfts: [nft('1.5')] }, { ownedNfts: [nft('0xz')] },
  { ownedNfts: [nft((1n << 256n).toString())] }, { ownedNfts: [nft('1', '-1')] },
  { ownedNfts: [{ ...nft('1'), balance: 1 }] }, { ownedNfts: [{ ...nft('1'), tokenId: 1 }] },
  { ownedNfts: Array.from({ length: 101 }, (_, index) => nft(String(index))) },
  { ownedNfts: [], pageKey: '' }, { ownedNfts: [], pageKey: 1 }, { ownedNfts: [], pageKey: 'a'.repeat(4097) },
]) {
  test(`mi note ownership rejects malformed Alchemy NFT data ${JSON.stringify(invalid).slice(0, 80)}`, async () => {
    await assertIndexedFailure((await setup({ nfts: async () => Response.json(invalid) }).run()).response);
  });
}

test('mi note ownership rejects repeating pagination cursors without returning partial holdings', async () => {
  const fixture = setup({ nfts: async () => page(['1'], 'repeat'), opensea: async () => openSeaPage([ORIGINAL_IDS[0]], 'repeat') });
  const result = await fixture.run();
  assert.equal(result.response.status, 502);
  assert.deepEqual(await result.response.json(), { ok: false, error: 'provider-unavailable' });
  assert.equal(fixture.metrics.upstreamCalls, 4);
});

test('mi note Alchemy accepts 100 complete pages and rejects continued pagination', async () => {
  for (const complete of [true, false]) {
    let calls = 0;
    const fixture = setup({ nfts: async () => {
      const offset = calls++ * 100;
      return Response.json({
        ownedNfts: Array.from({ length: 100 }, (_, index) => nft(String(offset + index), '1', index % 2 === 0 ? MI_NOTE_2_CONTRACT_ADDRESS : MI_NOTE_3_CONTRACT_ADDRESS)),
        pageKey: complete && calls === 100 ? null : String(calls),
      });
    } });
    const result = await fixture.run();
    assert.equal(calls, 100);
    if (!complete) await assertIndexedFailure(result.response);
    else {
      const body = await result.response.json() as ReturnType<typeof ownership>;
      assert.equal(body.tokenIdsByContract[MI_NOTE_2_CONTRACT_ADDRESS].length, 5_000);
      assert.equal(body.tokenIdsByContract[MI_NOTE_3_CONTRACT_ADDRESS].length, 5_000);
    }
  }
});

test('mi note OpenSea accepts 100 complete pages and rejects continued pagination', async () => {
  for (const complete of [true, false]) {
    let calls = 0;
    const fixture = setup({ opensea: async () => {
      calls += 1;
      return openSeaPage([ORIGINAL_IDS[0]], complete && calls === 100 ? null : String(calls));
    } });
    const result = await fixture.run();
    assert.equal(calls, 100);
    if (!complete) await assertOriginalFailure(result.response);
    else assert.deepEqual(await result.response.json(), ownership(['1'], [], [ORIGINAL_IDS[0]]));
  }
});

for (const provider of ['nfts', 'opensea'] as const) {
  test(`mi note bounds ${provider} declared and streamed pages without awaiting stalled cancellation`, async () => {
    for (const declared of [true, false]) {
      let cancelled = false;
      const fixture = setup({ [provider]: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { if (!declared) controller.enqueue(new TextEncoder().encode(' '.repeat(256 * 1024 + 1))); },
        cancel() { cancelled = true; return new Promise<void>(() => undefined); },
      }), { headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': String(256 * 1024 + 1) } : {}) } }) });
      const result = await fixture.run();
      if (provider === 'nfts') await assertIndexedFailure(result.response);
      else await assertOriginalFailure(result.response);
      assert.equal(cancelled, true);
    }
  });
}

test('mi note ownership rejects non-JSON, malformed JSON, and invalid UTF-8', async () => {
  for (const response of [
    new Response('<html>error</html>'),
    new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    await assertIndexedFailure((await setup({ nfts: async () => response }).run()).response);
  }
});

test('mi note ownership accepts a provider page exactly at the byte limit', async () => {
  const json = JSON.stringify({ ownedNfts: [nft('1')] });
  const fixture = setup({ nfts: async () => new Response(json.padEnd(256 * 1024, ' '), {
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(256 * 1024) },
  }) });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership());
});

test('mi note all-provider failures return generic errors without exposing credentials', async () => {
  const fixture = setup({ providerFetch: async () => { throw new Error(`https://eth-mainnet.g.alchemy.com/${API_KEY} https://api.opensea.io/${OPENSEA_KEY}`); } });
  const result = await fixture.run();
  assert.equal(result.response.status, 502);
  assert.deepEqual(await result.response.json(), { ok: false, error: 'provider-unavailable' });
  assert.equal(fixture.metrics.upstreamCalls, 2);
  assert.equal(fixture.deferred.length, 0);
  assert.equal(JSON.stringify(fixture.logs).includes(API_KEY), false);
  assert.equal(JSON.stringify(fixture.logs).includes(OPENSEA_KEY), false);
  assertCors(result.response);
});

test('mi note missing credentials fail only their assigned collections without using another provider', async () => {
  const alchemyMissing = setup();
  alchemyMissing.env.ALCHEMY_MI_NOTE_API_KEY = '';
  await assertIndexedFailure((await alchemyMissing.run()).response);
  assert.equal(alchemyMissing.calls.length, 1);
  assert.equal(alchemyMissing.calls[0].url.origin, 'https://api.opensea.io');
  const openSeaMissing = setup();
  openSeaMissing.env.OPENSEA_API_KEY = '';
  await assertOriginalFailure((await openSeaMissing.run()).response);
  assert.equal(openSeaMissing.calls.length, 1);
  assert.equal(openSeaMissing.calls[0].url.origin, 'https://eth-mainnet.g.alchemy.com');
  const bothMissing = setup();
  bothMissing.env.ALCHEMY_MI_NOTE_API_KEY = '';
  bothMissing.env.OPENSEA_API_KEY = '';
  assert.equal((await bothMissing.run()).response.status, 502);
  assert.equal(bothMissing.calls.length, 0);
});

test('mi note overall timeout aborts both providers and cancels late responses', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers<void>();
  const pendingResponses: Array<{ signal: AbortSignal; response: ReturnType<typeof Promise.withResolvers<Response>> }> = [];
  const fixture = setup({ timeoutMs: 30, providerFetch: async (_input, init) => {
    const response = Promise.withResolvers<Response>();
    pendingResponses.push({ signal: init!.signal!, response });
    if (pendingResponses.length === 2) started.resolve();
    return response.promise;
  } });
  const pending = fixture.run();
  await started.promise;
  context.mock.timers.tick(30);
  const result = await pending;
  assert.equal(result.response.status, 504);
  assert.deepEqual(await result.response.json(), { ok: false, error: 'provider-timeout' });
  assert.ok(pendingResponses.every(({ signal }) => signal.aborted));
  let cancelled = 0;
  for (const item of pendingResponses) item.response.resolve(new Response(new ReadableStream({ cancel() { cancelled += 1; } })));
  await settle();
  assert.equal(cancelled, 2);
});

test('mi note JSON preserves completed OpenSea holdings when Alchemy times out', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers<void>();
  const fixture = setup({ timeoutMs: 30, nfts: async () => { started.resolve(); return new Promise(() => undefined); } });
  const pending = fixture.run();
  await started.promise;
  await settle();
  context.mock.timers.tick(30);
  const result = await pending;
  assert.equal(result.response.status, 200);
  const body = await result.response.json() as ReturnType<typeof ownership>;
  assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], success('opensea'));
  for (const contract of [MI_NOTE_2_CONTRACT_ADDRESS, MI_NOTE_3_CONTRACT_ADDRESS] as const) assert.deepEqual(body.resultsByContract[contract], failure('provider-timeout'));
});

test('mi note one deadline covers pagination and stalled response bodies', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const firstStarted = Promise.withResolvers<void>();
  const firstResponse = Promise.withResolvers<Response>();
  const bodyStarted = Promise.withResolvers<void>();
  let calls = 0;
  let cancelled = false;
  const fixture = setup({ timeoutMs: 30, nfts: async () => {
    calls += 1;
    if (calls === 1) { firstStarted.resolve(); return firstResponse.promise; }
    return new Response(new ReadableStream({ pull() { bodyStarted.resolve(); }, cancel() { cancelled = true; } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } });
  const pending = fixture.run();
  await firstStarted.promise;
  await settle();
  context.mock.timers.tick(20);
  firstResponse.resolve(page(['2'], 'next'));
  await bodyStarted.promise;
  context.mock.timers.tick(10);
  const body = await (await pending).response.json() as ReturnType<typeof ownership>;
  assert.equal(calls, 2);
  assert.equal(cancelled, true);
  assert.deepEqual(body.tokenIdsByContract[MI_NOTE_2_CONTRACT_ADDRESS], []);
  assert.deepEqual(body.resultsByContract[MI_NOTE_2_CONTRACT_ADDRESS], failure('provider-timeout'));
  assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], success('opensea'));
});

test('mi note request cancellation aborts providers and preserves its reason', async () => {
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  const started = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const fixture = setup({ providerFetch: async (_input, init) => {
    signals.push(init!.signal!);
    if (signals.length === 2) started.resolve();
    return new Promise(() => undefined);
  } });
  const pending = fixture.run(request(undefined, { signal: controller.signal }));
  await started.promise;
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(fixture.deferred.length, 0);
});

test('mi note already-aborted requests do not call providers', async () => {
  const controller = new AbortController();
  const reason = new Error('already cancelled');
  controller.abort(reason);
  const fixture = setup();
  await assert.rejects(fixture.run(request(undefined, { signal: controller.signal })), (error: unknown) => error === reason);
  assert.equal(fixture.metrics.upstreamCalls, 0);
});

test('mi note caches each successful collection including empty results with its fixed provider for 60 seconds', async () => {
  const { entries, cache } = memoryCache();
  const fixture = setup({ cache });
  const first = await fixture.run();
  assert.deepEqual(await first.response.json(), ownership());
  await Promise.all(fixture.deferred);
  assert.equal(entries.size, 3);
  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
    const cached = entries.get(cacheUrl(contract))!;
    assert.ok(cached);
    assert.deepEqual(await cached.clone().json(), collectionOwnership(contract, contract === MI_NOTE_2_CONTRACT_ADDRESS ? ['1'] : []));
    assert.equal(cached.headers.get('Cache-Control'), 'public, max-age=60');
    assert.equal(cached.headers.get(EXPIRY_HEADER), String(NOW + 60_000));
    assert.equal(cached.headers.has('Access-Control-Allow-Origin'), false);
    assert.equal(cached.headers.has('Vary'), false);
  }
  const second = await fixture.run(request(`?address=${OWNER.toLowerCase()}&version=1&version=2&unrelated=true`, { headers: { Origin: 'http://localhost:5173' } }));
  assert.deepEqual(await second.response.json(), ownership());
  assert.equal(fixture.metrics.upstreamCalls, 2);
  assert.equal(second.response.headers.has(EXPIRY_HEADER), false);
  assertCors(second.response, 'http://localhost:5173');
});

for (const cachedContract of [MI_NOTE_2_CONTRACT_ADDRESS, MI_NOTE_3_CONTRACT_ADDRESS] as const) {
  test(`mi note one modern cache hit keeps its data and queries Alchemy once for the other collection (${cachedContract})`, async () => {
    const { entries, cache } = memoryCache();
    entries.set(cacheUrl(cachedContract), cachedOwnership(cachedContract, ['8']));
    entries.set(cacheUrl(MI_NOTE_CONTRACT_ADDRESS), cachedOwnership(MI_NOTE_CONTRACT_ADDRESS, [ORIGINAL_IDS[0]]));
    const fixture = setup({ cache, nfts: async () => Response.json({ ownedNfts: [nft('2'), nft('3', '1', MI_NOTE_3_CONTRACT_ADDRESS)] }) });
    const body = await (await fixture.run()).response.json() as ReturnType<typeof ownership>;
    assert.deepEqual(body.tokenIdsByContract[cachedContract], ['8']);
    assert.deepEqual(body.tokenIdsByContract[cachedContract === MI_NOTE_2_CONTRACT_ADDRESS ? MI_NOTE_3_CONTRACT_ADDRESS : MI_NOTE_2_CONTRACT_ADDRESS], [cachedContract === MI_NOTE_2_CONTRACT_ADDRESS ? '3' : '2']);
    assert.deepEqual(body.tokenIdsByContract[MI_NOTE_CONTRACT_ADDRESS], [ORIGINAL_IDS[0]]);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].url.origin, 'https://eth-mainnet.g.alchemy.com');
    await Promise.all(fixture.deferred);
    assert.deepEqual(await entries.get(cacheUrl(cachedContract))!.json(), collectionOwnership(cachedContract, ['8']));
  });
}

test('mi note cached modern collections avoid Alchemy when only original ownership is missing', async () => {
  const { entries, cache } = memoryCache();
  entries.set(cacheUrl(MI_NOTE_2_CONTRACT_ADDRESS), cachedOwnership(MI_NOTE_2_CONTRACT_ADDRESS, ['2']));
  entries.set(cacheUrl(MI_NOTE_3_CONTRACT_ADDRESS), cachedOwnership(MI_NOTE_3_CONTRACT_ADDRESS, ['3']));
  const fixture = setup({ cache, opensea: async () => openSeaPage([ORIGINAL_IDS[0]]) });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership(['2'], ['3'], [ORIGINAL_IDS[0]]));
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].url.origin, 'https://api.opensea.io');
});

test('mi note caps accepted ownership at 10000 tokens across independently cached collections', async () => {
  const { entries, cache } = memoryCache();
  entries.set(cacheUrl(MI_NOTE_CONTRACT_ADDRESS), cachedOwnership(MI_NOTE_CONTRACT_ADDRESS));
  entries.set(cacheUrl(MI_NOTE_2_CONTRACT_ADDRESS), cachedOwnership(MI_NOTE_2_CONTRACT_ADDRESS, Array.from({ length: 6000 }, (_, index) => String(index))));
  entries.set(cacheUrl(MI_NOTE_3_CONTRACT_ADDRESS), cachedOwnership(MI_NOTE_3_CONTRACT_ADDRESS, Array.from({ length: 5000 }, (_, index) => String(index))));
  const fixture = setup({ cache });
  const body = await (await fixture.run()).response.json() as ReturnType<typeof ownership>;
  assert.ok(Object.values(body.tokenIdsByContract).reduce((total, ids) => total + ids.length, 0) <= 10_000);
  assert.ok(Object.values(body.resultsByContract).some((result) => result.status === 'error'));
  assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], success('opensea'));
  assert.equal(fixture.metrics.upstreamCalls, 0);
});

test('mi note caches successful collections without caching failed or partial provider pages', async () => {
  const { entries, cache } = memoryCache();
  let calls = 0;
  const fixture = setup({ cache, nfts: async () => ++calls === 1 ? page(['1'], 'next') : new Response(null, { status: 503 }) });
  await assertIndexedFailure((await fixture.run()).response);
  await Promise.all(fixture.deferred);
  assert.equal(entries.size, 1);
  assert.deepEqual(await entries.get(cacheUrl(MI_NOTE_CONTRACT_ADDRESS))!.json(), collectionOwnership(MI_NOTE_CONTRACT_ADDRESS));
});

for (const invalid of [
  { contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, tokenIds: ['1'], provider: 'alchemy' },
  collectionOwnership(MI_NOTE_2_CONTRACT_ADDRESS, ['01']),
  collectionOwnership(MI_NOTE_2_CONTRACT_ADDRESS, ['1', '1']),
  { ...collectionOwnership(MI_NOTE_2_CONTRACT_ADDRESS), visibilityLimited: true },
  collectionOwnership(MI_NOTE_2_CONTRACT_ADDRESS, ['8'], 'opensea'),
  collectionOwnership(MI_NOTE_3_CONTRACT_ADDRESS, ['8']),
  { type: 'collection', ...collectionOwnership(MI_NOTE_2_CONTRACT_ADDRESS, ['8']) },
  { ok: true, tokenIds: ['1'] },
  { type: 'error', contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, error: 'provider-unavailable' },
]) {
  test(`mi note rejects invalid cached collection data ${JSON.stringify(invalid).slice(0, 90)}`, async () => {
    const { entries, cache } = memoryCache();
    entries.set(cacheUrl(MI_NOTE_2_CONTRACT_ADDRESS), Response.json(invalid, { headers: { [EXPIRY_HEADER]: String(NOW + 60_000) } }));
    const fixture = setup({ cache });
    assert.deepEqual(await (await fixture.run()).response.json(), ownership());
    assert.equal(fixture.metrics.upstreamCalls, 2);
    await Promise.all(fixture.deferred);
  });
}

test('mi note original cache entries require OpenSea metadata', async () => {
  const { entries, cache } = memoryCache();
  entries.set(cacheUrl(MI_NOTE_CONTRACT_ADDRESS), cachedOwnership(MI_NOTE_CONTRACT_ADDRESS, [ORIGINAL_IDS[0]], 'alchemy'));
  const fixture = setup({ cache });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership());
  assert.equal(fixture.calls.filter(({ url }) => url.origin === 'https://api.opensea.io').length, 1);
});

for (const expiresAt of [undefined, NOW, NOW + 60_001]) {
  test(`mi note ownership rejects invalid cache expiry ${expiresAt}`, async () => {
    const { entries, cache } = memoryCache();
    entries.set(cacheUrl(MI_NOTE_2_CONTRACT_ADDRESS), Response.json(collectionOwnership(MI_NOTE_2_CONTRACT_ADDRESS, ['8']), {
      headers: expiresAt === undefined ? {} : { [EXPIRY_HEADER]: String(expiresAt) },
    }));
    assert.deepEqual(await (await setup({ cache }).run()).response.json(), ownership());
  });
}

test('mi note ownership ignores v3 caches with previous provider selection and event bodies', async () => {
  const { entries, cache } = memoryCache();
  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
    entries.set(cacheUrl(contract, 3), Response.json({ type: 'collection', ...collectionOwnership(contract, ['99'], contract === MI_NOTE_CONTRACT_ADDRESS ? 'alchemy' : 'opensea') }, {
      headers: { [EXPIRY_HEADER]: String(NOW + 60_000) },
    }));
  }
  const fixture = setup({ cache });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership());
  assert.equal(fixture.metrics.upstreamCalls, 2);
});

test('mi note cache and logging failures do not change successful ownership', async () => {
  const fixture = setup({
    cache: { match: async () => { throw new Error('read failed'); }, put: async () => { throw new Error('write failed'); } },
    log: () => { throw new Error('log failed'); },
  });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership());
  await Promise.all(fixture.deferred);
});

test('mi note cache expiry is rechecked after reading its body', async () => {
  let currentTime = NOW;
  const fixture = setup({ now: () => currentTime, cache: {
    match: async (input) => new Request(input).url === cacheUrl(MI_NOTE_2_CONTRACT_ADDRESS) ? new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        currentTime = NOW + 1;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(collectionOwnership(MI_NOTE_2_CONTRACT_ADDRESS, ['8']))));
        controller.close();
      },
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json', [EXPIRY_HEADER]: String(NOW + 1) } }) : undefined,
    put: async () => undefined,
  } });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership());
  await Promise.all(fixture.deferred);
});

test('mi note ownership preserves successful responses if deferred registration fails', async () => {
  const fixture = setup({ cache: { match: async () => undefined, put: async () => undefined } });
  const result = await handleMiNoteCards(request(), fixture.env, fixture.dependencies, fixture.metrics, () => { throw new Error('registration failed'); });
  assert.deepEqual(await result.response.json(), ownership());
});

test('mi note ownership does not turn observation-only rate limits into rejection', async () => {
  const fixture = setup();
  fixture.env.PUBLIC_SHOP_RATE_LIMITER.limit = async () => ({ success: false });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership());
  assert.equal(fixture.logs.some((entry) => entry.event === 'public_rate_limit_would_block'), true);
});
