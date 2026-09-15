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
const SLUGS = {
  [MI_NOTE_CONTRACT_ADDRESS]: 'minote',
  [MI_NOTE_2_CONTRACT_ADDRESS]: 'mi-note2',
  [MI_NOTE_3_CONTRACT_ADDRESS]: 'mi-note-3',
};
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

function word(value: bigint | number | string) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function originalPage(ownedIndices: number[] = []) {
  return Response.json({
    jsonrpc: '2.0', id: 'mi-note-original',
    result: `0x${word(32)}${word(ORIGINAL_IDS.length)}${ORIGINAL_IDS.map((_, index) => word(ownedIndices.includes(index) ? 1 : 0)).join('')}`,
  });
}

function openSeaPage(contract: MiNoteContractAddress, tokenIds: string[] = [], next?: string | null) {
  return Response.json({
    nfts: tokenIds.map((identifier) => ({
      identifier, contract, collection: SLUGS[contract], token_standard: 'erc1155',
    })),
    next,
  });
}

function collectionEvent(contractAddress: MiNoteContractAddress, tokenIds: string[] = [], provider: Provider = 'alchemy') {
  return { type: 'collection', contractAddress, tokenIds, provider, visibilityLimited: provider === 'opensea' };
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
      [MI_NOTE_CONTRACT_ADDRESS]: original,
      [MI_NOTE_2_CONTRACT_ADDRESS]: two,
      [MI_NOTE_3_CONTRACT_ADDRESS]: three,
    },
    resultsByContract: {
      [MI_NOTE_CONTRACT_ADDRESS]: success(),
      [MI_NOTE_2_CONTRACT_ADDRESS]: success(),
      [MI_NOTE_3_CONTRACT_ADDRESS]: success(),
    },
  };
}

function request(search = `?address=${OWNER}`, options: RequestInit = {}) {
  return new Request(`https://api.mons.shop${MI_NOTE_CARDS_API_PATH}${search}`, {
    ...options,
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.1', ...options.headers },
  });
}

function streamRequest(options: RequestInit = {}) {
  return request(undefined, { ...options, headers: { Accept: 'application/x-ndjson', ...options.headers } });
}

function inputUrl(input: Parameters<ProviderFetch>[0]) {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}

function setup(options: Partial<Dependencies> & { nfts?: ProviderFetch; original?: ProviderFetch; opensea?: ProviderFetch } = {}) {
  const { nfts = async () => page(), original = async () => originalPage(), opensea = async () => new Response(null, { status: 503 }), ...overrides } = options;
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
      if (url.origin === 'https://api.opensea.io') return opensea(input, init);
      assert.equal(url.origin, 'https://eth-mainnet.g.alchemy.com');
      if (url.pathname.startsWith('/nft/v3/')) return nfts(input, init);
      assert.equal(url.pathname, `/v2/${API_KEY}`);
      return original(input, init);
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

function cacheUrl(contract: MiNoteContractAddress) {
  return `https://api.mons.shop${MI_NOTE_CARDS_API_PATH}?address=${OWNER.toLowerCase()}&contract=${contract}&version=3`;
}

function cachedEvent(contract: MiNoteContractAddress, ids: string[] = [], provider: Provider = 'alchemy') {
  return Response.json(collectionEvent(contract, ids, provider), {
    headers: { [EXPIRY_HEADER]: String(NOW + 60_000), 'Cache-Control': 'public, max-age=60' },
  });
}

function assertCors(response: Response, origin = ORIGIN) {
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal(response.headers.get('Vary'), 'Origin, Accept');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}

async function assertIndexedFailure(response: Response) {
  assert.equal(response.status, 200);
  const body = await response.json() as ReturnType<typeof ownership>;
  assert.deepEqual(body.tokenIdsByContract[MI_NOTE_2_CONTRACT_ADDRESS], []);
  assert.deepEqual(body.tokenIdsByContract[MI_NOTE_3_CONTRACT_ADDRESS], []);
  assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], success());
  assert.deepEqual(body.resultsByContract[MI_NOTE_2_CONTRACT_ADDRESS], failure());
  assert.deepEqual(body.resultsByContract[MI_NOTE_3_CONTRACT_ADDRESS], failure());
  assertCors(response);
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function streamReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    cancel: (reason?: unknown) => reader.cancel(reason),
    next: async (): Promise<Record<string, unknown> | null> => {
      for (;;) {
        const newline = text.indexOf('\n');
        if (newline >= 0) {
          const line = text.slice(0, newline);
          text = text.slice(newline + 1);
          if (line) return JSON.parse(line) as Record<string, unknown>;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) {
          assert.equal(text, '');
          return null;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

async function readEvents(response: Response) {
  const reader = streamReader(response);
  const events: Record<string, unknown>[] = [];
  for (;;) {
    const event = await reader.next();
    if (!event) return events;
    events.push(event);
  }
}

test('mi note ownership fetches original balances and paginated Mi Note 2/3 holdings in parallel', async () => {
  const started = Promise.withResolvers<void>();
  const original = Promise.withResolvers<Response>();
  let pages = 0;
  const fixture = setup({
    original: async (_input, init) => {
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'manual');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.id, 'mi-note-original');
      assert.equal(body.method, 'eth_call');
      assert.equal(body.params[1], 'latest');
      assert.equal(body.params[0].to, MI_NOTE_CONTRACT_ADDRESS);
      const data = String(body.params[0].data);
      assert.equal(data.slice(0, 10), '0x4e1273f4');
      const words = data.slice(10).match(/.{64}/g)!;
      const ownerOffset = Number(BigInt(`0x${words[0]}`)) / 32;
      const tokenOffset = Number(BigInt(`0x${words[1]}`)) / 32;
      assert.equal(Number(BigInt(`0x${words[ownerOffset]}`)), 166);
      assert.equal(Number(BigInt(`0x${words[tokenOffset]}`)), 166);
      assert.deepEqual(words.slice(ownerOffset + 1, ownerOffset + 167), ORIGINAL_IDS.map(() => OWNER.toLowerCase().slice(2).padStart(64, '0')));
      assert.deepEqual(words.slice(tokenOffset + 1).map((value) => BigInt(`0x${value}`).toString()), ORIGINAL_IDS);
      started.resolve();
      return original.promise;
    },
    nfts: async (input, init) => {
      await started.promise;
      const url = inputUrl(input);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      assert.ok(init?.signal);
      assert.equal(url.pathname, `/nft/v3/${API_KEY}/getNFTsForOwner`);
      assert.equal(url.searchParams.get('owner'), OWNER.toLowerCase());
      assert.deepEqual(url.searchParams.getAll('contractAddresses[]'), [MI_NOTE_2_CONTRACT_ADDRESS, MI_NOTE_3_CONTRACT_ADDRESS]);
      assert.equal(url.searchParams.get('withMetadata'), 'false');
      assert.equal(url.searchParams.get('pageSize'), '100');
      pages += 1;
      assert.equal(url.searchParams.get('pageKey'), pages === 1 ? null : 'cursor +/&=?');
      if (pages === 2) original.resolve(originalPage([0, 165]));
      return Response.json({
        ownedNfts: pages === 1 ? [nft('12'), nft('0x02', '1', MI_NOTE_3_CONTRACT_ADDRESS)] : [nft('2'), nft('12'), nft('4', '1', MI_NOTE_3_CONTRACT_ADDRESS)],
        pageKey: pages === 1 ? 'cursor +/&=?' : null,
      });
    },
  });
  const result = await fixture.run();
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), ownership(['2', '12'], ['2', '4'], [ORIGINAL_IDS[0], ORIGINAL_IDS[165]]));
  assert.equal(fixture.metrics.upstreamCalls, 3);
  assert.deepEqual(fixture.rateKeys, [`${MI_NOTE_CARDS_API_PATH}:192.0.2.1`]);
  assertCors(result.response);
});

test('mi note ownership normalizes uint256 IDs, deduplicates, and excludes zero balances', async () => {
  const maxId = ((1n << 256n) - 1n).toString();
  const fixture = setup({
    nfts: async () => Response.json({ ownedNfts: [nft('0x0a'), nft('00010'), nft('0'), nft('4', '0'), nft(maxId)] }),
  });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership(['0', '10', maxId]));
});

test('mi note successful empty holdings remain authoritative and do not start backups', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = setup({ nfts: async () => page([]) });
  assert.deepEqual(await (await fixture.run()).response.json(), ownership([]));
  context.mock.timers.tick(1_000);
  await settle();
  assert.equal(fixture.calls.length, 2);
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

test('mi note ownership falls back immediately after primary failure and requests each OpenSea collection safely', async () => {
  const fixture = setup({
    backupDelayMs: 60_000,
    nfts: async () => { throw new Error('Alchemy failed'); },
    original: async () => { throw new Error('RPC failed'); },
    opensea: async (input, init) => {
      const url = inputUrl(input);
      assert.equal(url.pathname, `/api/v2/chain/ethereum/account/${OWNER.toLowerCase()}/nfts`);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('x-api-key'), OPENSEA_KEY);
      assert.equal(new Headers(init?.headers).get('Accept'), 'application/json');
      assert.equal(url.searchParams.get('include_auto_hidden'), 'true');
      assert.equal(url.searchParams.get('limit'), '100');
      const contract = MI_NOTE_CONTRACT_ADDRESSES.find((address) => SLUGS[address] === url.searchParams.get('collection'))!;
      assert.ok(contract);
      return openSeaPage(contract, contract === MI_NOTE_CONTRACT_ADDRESS ? [ORIGINAL_IDS[0]] : ['2']);
    },
  });
  const result = await fixture.run();
  const body = await result.response.json() as ReturnType<typeof ownership>;
  assert.equal(result.response.status, 200);
  assert.deepEqual(body.tokenIdsByContract, ownership(['2'], ['2'], [ORIGINAL_IDS[0]]).tokenIdsByContract);
  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) assert.deepEqual(body.resultsByContract[contract], success('opensea'));
  assert.equal(fixture.calls.filter(({ url }) => url.origin === 'https://api.opensea.io').length, 3);
});

test('mi note original OpenSea backup excludes shared-contract tokens outside the catalog', async () => {
  const fixture = setup({
    original: async () => { throw new Error('RPC failed'); },
    opensea: async () => openSeaPage(MI_NOTE_CONTRACT_ADDRESS, ['1', ORIGINAL_IDS[0], ORIGINAL_IDS[165]]),
  });
  const body = await (await fixture.run()).response.json() as ReturnType<typeof ownership>;
  assert.deepEqual(body.tokenIdsByContract[MI_NOTE_CONTRACT_ADDRESS], [ORIGINAL_IDS[0], ORIGINAL_IDS[165]]);
  assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], success('opensea'));
});

test('mi note backup starts at one second and a per-collection winner keeps the shared primary alive for its sibling', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const primaryStarted = Promise.withResolvers<void>();
  const primary = Promise.withResolvers<Response>();
  const backupThree = Promise.withResolvers<Response>();
  let primarySignal: AbortSignal | null | undefined;
  let backupThreeSignal: AbortSignal | null | undefined;
  const fixture = setup({
    nfts: async (_input, init) => {
      primarySignal = init?.signal;
      primaryStarted.resolve();
      return primary.promise;
    },
    opensea: async (input, init) => {
      if (inputUrl(input).searchParams.get('collection') === SLUGS[MI_NOTE_2_CONTRACT_ADDRESS]) return openSeaPage(MI_NOTE_2_CONTRACT_ADDRESS, ['8']);
      backupThreeSignal = init?.signal;
      return backupThree.promise;
    },
  });
  const pending = fixture.run();
  await primaryStarted.promise;
  await settle();
  context.mock.timers.tick(999);
  await settle();
  assert.equal(fixture.calls.filter(({ url }) => url.origin === 'https://api.opensea.io').length, 0);
  context.mock.timers.tick(1);
  await settle();
  assert.equal(fixture.calls.filter(({ url }) => url.origin === 'https://api.opensea.io').length, 2);
  assert.equal(primarySignal?.aborted, false);
  primary.resolve(Response.json({ ownedNfts: [nft('1'), nft('3', '1', MI_NOTE_3_CONTRACT_ADDRESS)] }));
  const result = await pending;
  const body = await result.response.json() as ReturnType<typeof ownership>;
  assert.deepEqual(body.tokenIdsByContract, ownership(['8'], ['3']).tokenIdsByContract);
  assert.deepEqual(body.resultsByContract[MI_NOTE_2_CONTRACT_ADDRESS], success('opensea'));
  assert.deepEqual(body.resultsByContract[MI_NOTE_3_CONTRACT_ADDRESS], success());
  assert.equal(backupThreeSignal?.aborted, true);
  let cancelled = false;
  backupThree.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await settle();
  assert.equal(cancelled, true);
});

test('mi note primary continues after a backup failure and only validated complete results can win', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const primaryStarted = Promise.withResolvers<void>();
  const primary = Promise.withResolvers<Response>();
  const fixture = setup({
    nfts: async () => { primaryStarted.resolve(); return primary.promise; },
    opensea: async () => Response.json({ nfts: [{ identifier: '2' }] }),
  });
  const pending = fixture.run();
  await primaryStarted.promise;
  await settle();
  context.mock.timers.tick(1_000);
  await settle();
  primary.resolve(Response.json({ ownedNfts: [nft('3'), nft('4', '1', MI_NOTE_3_CONTRACT_ADDRESS)] }));
  assert.deepEqual(await (await pending).response.json(), ownership(['3'], ['4']));
});

test('mi note empty backup success wins and aborts a shared primary once both collections resolve', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const primaryStarted = Promise.withResolvers<void>();
  let primarySignal: AbortSignal | null | undefined;
  const fixture = setup({
    nfts: async (_input, init) => { primarySignal = init?.signal; primaryStarted.resolve(); return new Promise(() => undefined); },
    opensea: async (input) => openSeaPage(inputUrl(input).searchParams.get('collection') === 'mi-note2' ? MI_NOTE_2_CONTRACT_ADDRESS : MI_NOTE_3_CONTRACT_ADDRESS),
  });
  const pending = fixture.run();
  await primaryStarted.promise;
  await settle();
  context.mock.timers.tick(1_000);
  const body = await (await pending).response.json() as ReturnType<typeof ownership>;
  assert.deepEqual(body.tokenIdsByContract, ownership([]).tokenIdsByContract);
  assert.deepEqual(body.resultsByContract[MI_NOTE_2_CONTRACT_ADDRESS], success('opensea'));
  assert.deepEqual(body.resultsByContract[MI_NOTE_3_CONTRACT_ADDRESS], success('opensea'));
  assert.equal(primarySignal?.aborted, true);
});

test('mi note OpenSea backup paginates encoded cursors and discards partial data if a later page fails', async () => {
  for (const complete of [true, false]) {
    let calls = 0;
    const fixture = setup({
      original: async () => { throw new Error('RPC failed'); },
      opensea: async (input) => {
        calls += 1;
        const url = inputUrl(input);
        assert.equal(url.searchParams.get('next'), calls === 1 ? null : 'next +/&=?');
        if (calls === 1) return openSeaPage(MI_NOTE_CONTRACT_ADDRESS, [ORIGINAL_IDS[0]], 'next +/&=?');
        return complete ? openSeaPage(MI_NOTE_CONTRACT_ADDRESS, [ORIGINAL_IDS[0], ORIGINAL_IDS[165]]) : Response.json({ error: 'failed' }, { status: 503 });
      },
    });
    const body = await (await fixture.run()).response.json() as ReturnType<typeof ownership>;
    assert.deepEqual(body.tokenIdsByContract[MI_NOTE_CONTRACT_ADDRESS], complete ? [ORIGINAL_IDS[0], ORIGINAL_IDS[165]] : []);
    assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], complete ? success('opensea') : failure());
  }
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
    const fixture = setup({
      original: async () => { throw new Error('RPC failed'); },
      opensea: async () => Response.json(invalid),
    });
    const body = await (await fixture.run()).response.json() as ReturnType<typeof ownership>;
    assert.deepEqual(body.tokenIdsByContract[MI_NOTE_CONTRACT_ADDRESS], []);
    assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], failure());
  });
}

test('mi note OpenSea permits 100 complete pages but rejects continued pagination', async () => {
  for (const complete of [true, false]) {
    let calls = 0;
    const fixture = setup({
      original: async () => { throw new Error('RPC failed'); },
      opensea: async () => {
        calls += 1;
        return openSeaPage(MI_NOTE_CONTRACT_ADDRESS, [ORIGINAL_IDS[0]], complete && calls === 100 ? null : String(calls));
      },
    });
    const body = await (await fixture.run()).response.json() as ReturnType<typeof ownership>;
    assert.equal(calls, 100);
    assert.deepEqual(body.tokenIdsByContract[MI_NOTE_CONTRACT_ADDRESS], complete ? [ORIGINAL_IDS[0]] : []);
    assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], complete ? success('opensea') : failure());
  }
});

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
    const fixture = setup({ nfts: async () => Response.json(invalid) });
    await assertIndexedFailure((await fixture.run()).response);
  });
}

for (const result of ['0x', `0x${word(64)}${word(166)}`, `0x${word(32)}${word(165)}${word(0).repeat(165)}`, `0x${word(32)}${word(166)}${word(0).repeat(167)}`]) {
  test(`mi note original rejects malformed balanceOfBatch output (${result.length} characters)`, async () => {
    const fixture = setup({ original: async () => Response.json({ jsonrpc: '2.0', id: 'mi-note-original', result }) });
    const body = await (await fixture.run()).response.json() as ReturnType<typeof ownership>;
    assert.deepEqual(body.tokenIdsByContract[MI_NOTE_CONTRACT_ADDRESS], []);
    assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], failure());
  });
}

test('mi note ownership rejects repeating Alchemy and OpenSea pagination cursors', async () => {
  const fixture = setup({
    nfts: async () => page(['1'], 'repeat'),
    opensea: async (input) => openSeaPage(inputUrl(input).searchParams.get('collection') === 'mi-note2' ? MI_NOTE_2_CONTRACT_ADDRESS : MI_NOTE_3_CONTRACT_ADDRESS, ['1'], 'repeat'),
  });
  await assertIndexedFailure((await fixture.run()).response);
  assert.equal(fixture.metrics.upstreamCalls, 7);
});

test('mi note ownership accepts 100 complete Alchemy pages and rejects continued pagination', async () => {
  for (const complete of [true, false]) {
    let calls = 0;
    const fixture = setup({
      nfts: async () => {
        const offset = calls++ * 100;
        return Response.json({
          ownedNfts: Array.from({ length: 100 }, (_, index) => nft(String(offset + index), '1', index % 2 === 0 ? MI_NOTE_2_CONTRACT_ADDRESS : MI_NOTE_3_CONTRACT_ADDRESS)),
          pageKey: complete && calls === 100 ? null : String(calls),
        });
      },
    });
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

test('mi note ownership bounds declared and streamed provider pages without awaiting stalled cancellation', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const fixture = setup({
      nfts: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { if (!declared) controller.enqueue(new TextEncoder().encode(' '.repeat(256 * 1024 + 1))); },
        cancel() { cancelled = true; return new Promise<void>(() => undefined); },
      }), { headers: { 'Content-Type': 'application/json', ...(declared ? { 'Content-Length': String(256 * 1024 + 1) } : {}) } }),
    });
    await assertIndexedFailure((await fixture.run()).response);
    assert.equal(cancelled, true);
  }
});

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

test('mi note ownership returns generic errors when both providers fail and never logs credentials', async () => {
  const fixture = setup({ providerFetch: async () => { throw new Error(`https://eth-mainnet.g.alchemy.com/${API_KEY} https://api.opensea.io/${OPENSEA_KEY}`); } });
  const result = await fixture.run();
  assert.equal(result.response.status, 502);
  assert.deepEqual(await result.response.json(), { ok: false, error: 'provider-unavailable' });
  assert.equal(fixture.deferred.length, 0);
  assert.equal(JSON.stringify(fixture.logs).includes(API_KEY), false);
  assert.equal(JSON.stringify(fixture.logs).includes(OPENSEA_KEY), false);
  assertCors(result.response);
});

test('mi note ownership can use OpenSea when the Alchemy key is missing and fails without either key', async () => {
  const fixture = setup({ opensea: async (input) => {
    const contract = MI_NOTE_CONTRACT_ADDRESSES.find((address) => SLUGS[address] === inputUrl(input).searchParams.get('collection'))!;
    return openSeaPage(contract);
  } });
  fixture.env.ALCHEMY_MI_NOTE_API_KEY = '';
  const body = await (await fixture.run()).response.json() as ReturnType<typeof ownership>;
  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) assert.deepEqual(body.resultsByContract[contract], success('opensea'));
  assert.equal(fixture.calls.length, 3);
  fixture.env.OPENSEA_API_KEY = '';
  assert.equal((await fixture.run()).response.status, 502);
  assert.equal(fixture.calls.length, 3);
});

test('mi note ownership uses one overall deadline and aborts pending providers and late responses', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers<void>();
  const pendingResponses: Array<{ signal: AbortSignal; response: ReturnType<typeof Promise.withResolvers<Response>> }> = [];
  const fixture = setup({
    timeoutMs: 30,
    backupDelayMs: 10,
    providerFetch: async (_input, init) => {
      const response = Promise.withResolvers<Response>();
      pendingResponses.push({ signal: init!.signal!, response });
      if (pendingResponses.length === 2) started.resolve();
      return response.promise;
    },
  });
  const pending = fixture.run();
  await started.promise;
  context.mock.timers.tick(10);
  await settle();
  assert.equal(pendingResponses.length, 5);
  context.mock.timers.tick(20);
  const result = await pending;
  assert.equal(result.response.status, 504);
  assert.deepEqual(await result.response.json(), { ok: false, error: 'provider-timeout' });
  assert.ok(pendingResponses.every(({ signal }) => signal.aborted));
  let cancelled = 0;
  for (const item of pendingResponses) item.response.resolve(new Response(new ReadableStream({ cancel() { cancelled += 1; } })));
  await settle();
  assert.equal(cancelled, 5);
});

test('mi note JSON preserves successful collections when remaining providers time out', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers<void>();
  const fixture = setup({
    timeoutMs: 30,
    nfts: async () => { started.resolve(); return new Promise(() => undefined); },
    opensea: async () => new Promise(() => undefined),
  });
  const pending = fixture.run();
  await started.promise;
  await settle();
  context.mock.timers.tick(30);
  const result = await pending;
  assert.equal(result.response.status, 200);
  const body = await result.response.json() as ReturnType<typeof ownership>;
  assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], success());
  for (const contract of [MI_NOTE_2_CONTRACT_ADDRESS, MI_NOTE_3_CONTRACT_ADDRESS] as const) assert.deepEqual(body.resultsByContract[contract], failure('provider-timeout'));
});

test('mi note streaming delivers a completed collection before other providers finish and terminates once', async () => {
  const nfts = Promise.withResolvers<Response>();
  const fixture = setup({ nfts: async () => nfts.promise, original: async () => originalPage([0]) });
  const { response } = await fixture.run(streamRequest());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/x-ndjson/);
  assertCors(response);
  const reader = streamReader(response);
  assert.deepEqual(await reader.next(), collectionEvent(MI_NOTE_CONTRACT_ADDRESS, [ORIGINAL_IDS[0]]));
  nfts.resolve(Response.json({ ownedNfts: [nft('2'), nft('3', '1', MI_NOTE_3_CONTRACT_ADDRESS)] }));
  const remaining = [await reader.next(), await reader.next()];
  assert.deepEqual(remaining.sort((a, b) => String(a?.contractAddress).localeCompare(String(b?.contractAddress))), [
    collectionEvent(MI_NOTE_2_CONTRACT_ADDRESS, ['2']), collectionEvent(MI_NOTE_3_CONTRACT_ADDRESS, ['3']),
  ].sort((a, b) => a.contractAddress.localeCompare(b.contractAddress)));
  assert.deepEqual(await reader.next(), { type: 'done' });
  assert.equal(await reader.next(), null);
});

for (const ending of ['completion', 'cancellation'] as const) {
  test(`mi note idle stream keepalives stop after ${ending}`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const scheduleTimeout = globalThis.setTimeout;
    let ended = false;
    let timersAfterEnding = 0;
    context.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => scheduleTimeout(() => {
      if (ended) timersAfterEnding += 1;
      callback(...args);
    }, delay));
    const original = Promise.withResolvers<Response>();
    const nfts = Promise.withResolvers<Response>();
    const fixture = setup({
      backupDelayMs: 60_000,
      original: async () => original.promise,
      nfts: async () => nfts.promise,
    });
    const { response } = await fixture.run(streamRequest());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = false;
    const firstRead = reader.read().then((chunk) => {
      received = true;
      return chunk;
    });
    await settle();
    assert.equal(fixture.calls.length, 2);
    context.mock.timers.tick(999);
    await settle();
    assert.equal(received, false);
    context.mock.timers.tick(1);
    const firstKeepalive = await firstRead;
    assert.equal(firstKeepalive.done, false);
    assert.equal(decoder.decode(firstKeepalive.value), '\n');
    context.mock.timers.tick(1_000);
    const secondKeepalive = await reader.read();
    assert.equal(secondKeepalive.done, false);
    assert.equal(decoder.decode(secondKeepalive.value), '\n');

    if (ending === 'completion') {
      original.resolve(originalPage());
      nfts.resolve(page());
      let body = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value);
      }
      const events = body.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(events.length, 4);
      assert.equal(events.filter((event) => event.type === 'collection').length, 3);
      assert.deepEqual(events.at(-1), { type: 'done' });
    } else {
      await reader.cancel(new DOMException('Stream cancelled', 'AbortError'));
      assert.ok(fixture.calls.every(({ init }) => init?.signal?.aborted));
    }
    await Promise.all(fixture.deferred);
    ended = true;
    context.mock.timers.tick(60_000);
    await settle();
    assert.equal(timersAfterEnding, 0);
    assert.deepEqual(await reader.read(), { value: undefined, done: true });
    assert.equal(fixture.calls.length, 2);
  });
}

test('mi note streaming reports per-collection errors and done even if every provider fails', async () => {
  const fixture = setup({ providerFetch: async () => new Response(null, { status: 503 }) });
  const { response } = await fixture.run(streamRequest({ headers: { Accept: 'application/json, application/x-ndjson' } }));
  assert.equal(response.status, 200);
  const events = await readEvents(response);
  assert.deepEqual(events.at(-1), { type: 'done' });
  assert.equal(events.length, 4);
  assert.deepEqual(events.slice(0, -1).sort((a, b) => String(a.contractAddress).localeCompare(String(b.contractAddress))), MI_NOTE_CONTRACT_ADDRESSES.map((contractAddress) => ({
    type: 'error', contractAddress, error: 'provider-unavailable',
  })).sort((a, b) => a.contractAddress.localeCompare(b.contractAddress)));
});

test('mi note streaming preserves completed collections and times out stalled provider bodies', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const bodyStarted = Promise.withResolvers<void>();
  let cancelled = false;
  const fixture = setup({
    timeoutMs: 30,
    backupDelayMs: 10,
    nfts: async () => new Response(new ReadableStream({
      pull() { bodyStarted.resolve(); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json' } }),
  });
  const { response } = await fixture.run(streamRequest());
  const reader = streamReader(response);
  assert.deepEqual(await reader.next(), collectionEvent(MI_NOTE_CONTRACT_ADDRESS));
  await bodyStarted.promise;
  context.mock.timers.tick(10);
  await settle();
  assert.equal(cancelled, false);
  context.mock.timers.tick(20);
  const errors = [await reader.next(), await reader.next()];
  assert.deepEqual(errors.sort((a, b) => String(a?.contractAddress).localeCompare(String(b?.contractAddress))), [
    { type: 'error', contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, error: 'provider-timeout' },
    { type: 'error', contractAddress: MI_NOTE_3_CONTRACT_ADDRESS, error: 'provider-timeout' },
  ].sort((a, b) => a.contractAddress.localeCompare(b.contractAddress)));
  assert.deepEqual(await reader.next(), { type: 'done' });
  assert.equal(await reader.next(), null);
  assert.equal(cancelled, true);
});

test('mi note stream cancellation aborts all pending primary requests', async () => {
  const started = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const fixture = setup({ providerFetch: async (_input, init) => {
    signals.push(init!.signal!);
    if (signals.length === 2) started.resolve();
    return new Promise(() => undefined);
  } });
  const { response } = await fixture.run(streamRequest());
  await started.promise;
  await response.body!.cancel();
  await settle();
  assert.ok(signals.every((signal) => signal.aborted));
  await Promise.all(fixture.deferred);
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

test('mi note ownership caches each successful collection including empty results for 60 seconds', async () => {
  const { entries, cache } = memoryCache();
  const fixture = setup({ cache });
  const first = await fixture.run();
  assert.deepEqual(await first.response.json(), ownership());
  await Promise.all(fixture.deferred);
  assert.equal(entries.size, 3);
  for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
    const cached = entries.get(cacheUrl(contract))!;
    assert.ok(cached);
    assert.deepEqual(await cached.clone().json(), collectionEvent(contract, contract === MI_NOTE_2_CONTRACT_ADDRESS ? ['1'] : []));
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

test('mi note partial cache hits stream immediately and preserve OpenSea visibility metadata', async () => {
  const { entries, cache } = memoryCache();
  entries.set(cacheUrl(MI_NOTE_2_CONTRACT_ADDRESS), cachedEvent(MI_NOTE_2_CONTRACT_ADDRESS, ['8'], 'opensea'));
  const original = Promise.withResolvers<Response>();
  const nfts = Promise.withResolvers<Response>();
  const fixture = setup({ cache, original: async () => original.promise, nfts: async () => nfts.promise });
  const { response } = await fixture.run(streamRequest());
  const reader = streamReader(response);
  assert.deepEqual(await reader.next(), collectionEvent(MI_NOTE_2_CONTRACT_ADDRESS, ['8'], 'opensea'));
  original.resolve(originalPage());
  nfts.resolve(Response.json({ ownedNfts: [nft('1'), nft('3', '1', MI_NOTE_3_CONTRACT_ADDRESS)] }));
  const remaining = [await reader.next(), await reader.next(), await reader.next()];
  assert.deepEqual(remaining.at(-1), { type: 'done' });
  assert.equal(remaining.filter((event) => event?.contractAddress === MI_NOTE_2_CONTRACT_ADDRESS).length, 0);
  assert.equal(await reader.next(), null);
  await Promise.all(fixture.deferred);
  assert.deepEqual(await entries.get(cacheUrl(MI_NOTE_2_CONTRACT_ADDRESS))!.json(), collectionEvent(MI_NOTE_2_CONTRACT_ADDRESS, ['8'], 'opensea'));
});

test('mi note streaming caps accepted ownership at 10000 tokens across separately cached collections', async () => {
  const { entries, cache } = memoryCache();
  entries.set(cacheUrl(MI_NOTE_CONTRACT_ADDRESS), cachedEvent(MI_NOTE_CONTRACT_ADDRESS));
  entries.set(cacheUrl(MI_NOTE_2_CONTRACT_ADDRESS), cachedEvent(MI_NOTE_2_CONTRACT_ADDRESS, Array.from({ length: 6000 }, (_, index) => String(index))));
  entries.set(cacheUrl(MI_NOTE_3_CONTRACT_ADDRESS), cachedEvent(MI_NOTE_3_CONTRACT_ADDRESS, Array.from({ length: 5000 }, (_, index) => String(index))));
  const fixture = setup({ cache });
  const events = await readEvents((await fixture.run(streamRequest())).response);
  const collections = events.filter((event) => event.type === 'collection');
  const errors = events.filter((event) => event.type === 'error');
  assert.ok(collections.reduce((total, event) => total + (event.tokenIds as string[]).length, 0) <= 10_000);
  assert.equal(collections.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, 'provider-unavailable');
  assert.deepEqual(events.at(-1), { type: 'done' });
  assert.equal(fixture.metrics.upstreamCalls, 0);
});

test('mi note caches successful collections without caching failed or partial provider results', async () => {
  const { entries, cache } = memoryCache();
  let calls = 0;
  const fixture = setup({ cache, nfts: async () => ++calls === 1 ? page(['1'], 'next') : new Response(null, { status: 503 }) });
  await assertIndexedFailure((await fixture.run()).response);
  await Promise.all(fixture.deferred);
  assert.equal(entries.size, 1);
  assert.deepEqual(await entries.get(cacheUrl(MI_NOTE_CONTRACT_ADDRESS))!.json(), collectionEvent(MI_NOTE_CONTRACT_ADDRESS));
});

for (const invalid of [
  { type: 'collection', contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, tokenIds: ['1'], provider: 'alchemy' },
  collectionEvent(MI_NOTE_2_CONTRACT_ADDRESS, ['01']),
  collectionEvent(MI_NOTE_2_CONTRACT_ADDRESS, ['1', '1']),
  { ...collectionEvent(MI_NOTE_2_CONTRACT_ADDRESS), visibilityLimited: true },
  { ...collectionEvent(MI_NOTE_2_CONTRACT_ADDRESS, [], 'opensea'), visibilityLimited: false },
  { ok: true, tokenIds: ['1'] },
  { type: 'error', contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, error: 'provider-unavailable' },
]) {
  test(`mi note ownership rejects invalid cached collection data ${JSON.stringify(invalid).slice(0, 90)}`, async () => {
    const { entries, cache } = memoryCache();
    entries.set(cacheUrl(MI_NOTE_2_CONTRACT_ADDRESS), Response.json(invalid, { headers: { [EXPIRY_HEADER]: String(NOW + 60_000) } }));
    const fixture = setup({ cache });
    assert.deepEqual(await (await fixture.run()).response.json(), ownership());
    assert.equal(fixture.metrics.upstreamCalls, 2);
    await Promise.all(fixture.deferred);
  });
}

for (const expiresAt of [undefined, NOW, NOW + 60_001]) {
  test(`mi note ownership rejects invalid cache expiry ${expiresAt}`, async () => {
    const { entries, cache } = memoryCache();
    entries.set(cacheUrl(MI_NOTE_2_CONTRACT_ADDRESS), Response.json(collectionEvent(MI_NOTE_2_CONTRACT_ADDRESS, ['8']), {
      headers: expiresAt === undefined ? {} : { [EXPIRY_HEADER]: String(expiresAt) },
    }));
    assert.deepEqual(await (await setup({ cache }).run()).response.json(), ownership());
  });
}

test('mi note ownership does not reuse older combined cache entries', async () => {
  const { entries, cache } = memoryCache();
  const oldUrl = `https://api.mons.shop${MI_NOTE_CARDS_API_PATH}?address=${OWNER.toLowerCase()}&version=2`;
  entries.set(oldUrl, Response.json(ownership(['99']), { headers: { [EXPIRY_HEADER]: String(NOW + 60_000) } }));
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
  const fixture = setup({
    now: () => currentTime,
    cache: {
      match: async (input) => new Request(input).url === cacheUrl(MI_NOTE_2_CONTRACT_ADDRESS) ? new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          currentTime = NOW + 1;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(collectionEvent(MI_NOTE_2_CONTRACT_ADDRESS, ['8']))));
          controller.close();
        },
      }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json', [EXPIRY_HEADER]: String(NOW + 1) } }) : undefined,
      put: async () => undefined,
    },
  });
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
