import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestHarness } from 'wrangler';
import { MI_NOTE_SESSION_HEADER } from '../../../../shared/miNoteAuth.ts';
import { sha256Hex } from '../src/sessionSecrets.ts';
import {
  MI_NOTE_2_CONTRACT_ADDRESS,
  MI_NOTE_3_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESSES,
  MI_NOTE_MODERN_CONTRACT_ADDRESSES,
  isExactMiNoteCardsResponse,
  type MiNoteCardsResponse,
} from '../../../../shared/miNoteCards.js';

const ORIGIN = 'https://mons.shop';
const ALCHEMY_KEY = 'alchemy-runtime-test-key';
const OPENSEA_KEY = 'opensea-runtime-test-key';
const ORIGINAL_ID = (JSON.parse(readFileSync('mi_note_eth.json', 'utf8')) as {
  contractAddress: string; tokens: { id: string }[];
}[]).find((collection) => collection.contractAddress === MI_NOTE_CONTRACT_ADDRESS)!.tokens[72].id;
const ALLOW_HEADERS = { Origin: ORIGIN };
type Provider = (url: URL) => Promise<Response>;

function requestUrl(owner: number, path = '/mi-note-cards'): string {
  return `https://api.mons.shop${path}?preorderId=mi_note_cards_devnet&address=0x${owner.toString(16).padStart(40, '0')}`;
}

function originalBody() {
  return { nfts: [{
    contract: MI_NOTE_CONTRACT_ADDRESS, collection: 'minote', token_standard: 'erc1155', identifier: ORIGINAL_ID,
  }], next: null };
}

function modernBody(pageKey: string | null = 'complete') {
  return {
    ownedNfts: [
      ...(pageKey === null ? ['12', '2'] : ['4', '12']).map((tokenId) => ({
        contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, tokenId, balance: '1',
      })),
      ...(pageKey === null ? ['2'] : ['12', '1']).map((tokenId) => ({
        contractAddress: MI_NOTE_3_CONTRACT_ADDRESS, tokenId, balance: '1',
      })),
    ],
    pageKey: pageKey === null ? 'next +/&=?' : null,
  };
}

function assertHeaders(response: { headers: { get(name: string): string | null } }): void {
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Vary'), 'Origin');
  assert.match(response.headers.get('Content-Type') || '', /^application\/json/);
}

async function within<T>(promise: Promise<T>, milliseconds = 3_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Native Mi Note operation did not finish in time')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function pendingJson() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(new TextEncoder().encode(' '));
    },
  }), { headers: { 'Content-Type': 'application/json' } });
  return {
    response,
    finish(body: unknown) {
      if (finished) return;
      finished = true;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      controller.close();
    },
  };
}

test('Mi Note ownership uses fixed providers and one bounded JSON response in workerd', { timeout: 60_000 }, async (context) => {
  const productionConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  assert.ok(productionConfig.secrets.required.includes('OPENSEA_API_KEY'));
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'mons-mi-note-runtime-'));
  const fixturePath = join(fixtureDirectory, 'mi-note-runtime.mjs');
  await writeFile(fixturePath, `
import { handleRequest } from ${JSON.stringify(resolve('cloud/workers/api/src/index.ts'))};
import { handleMiNoteCards } from ${JSON.stringify(resolve('cloud/workers/api/src/miNoteCards.ts'))};
import { apiServiceRequest } from ${JSON.stringify(resolve('cloud/workers/frontend/src/index.ts'))};
export default {
  async fetch(request, env, ctx) {
    request = apiServiceRequest(request) || request;
    const url = new URL(request.url);
    if (url.pathname === '/test-cache') {
      const entries = await request.json();
      await Promise.all(entries.map(({ version = '4', ...body }) => {
        const key = new URL('/mi-note-cards', request.url);
        key.searchParams.set('address', url.searchParams.get('address'));
        key.searchParams.set('contract', body.contractAddress);
        key.searchParams.set('version', version);
        return caches.default.put(new Request(key), Response.json(body, { headers: {
          'Cache-Control': 'public, max-age=60', 'X-Mi-Note-Cards-Expires-At': String(Date.now() + 60_000),
        } }));
      }));
      return Response.json({ ok: true });
    }
    if (url.pathname !== '/test-bounded') return handleRequest(request, env, (promise) => ctx.waitUntil(promise));
    const controller = new AbortController();
    const input = new Request(request, { signal: AbortSignal.any([request.signal, controller.signal]) });
    const aborted = new Set();
    const timeout = url.searchParams.has('abort') ? setTimeout(() => controller.abort(new DOMException('Client cancelled', 'AbortError')), 150) : undefined;
    const metrics = { upstreamCalls: 0, providerDurationMs: 0, expectedAssetIds: 0, expectedAssetRecoveryFailures: 0, expectedAssetResolved: 0 };
    let response;
    try {
      ({ response } = await handleMiNoteCards(input, env, {
        cache: null, log() {}, timeoutMs: url.searchParams.has('abort') ? 1000 : 150,
        providerFetch(input, init) {
          const host = new URL(String(input)).hostname;
          init.signal.addEventListener('abort', () => aborted.add(host), { once: true });
          return fetch(input, init);
        },
      }, metrics, (promise) => ctx.waitUntil(promise)));
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      response = new Response(null, { status: 499 });
    } finally {
      clearTimeout(timeout);
    }
    response.headers.set('X-Test-Aborted-Providers', String(aborted.size));
    response.headers.set('X-Test-Request-Aborted', String(input.signal.aborted));
    return response;
  },
};
`, 'utf8');
  const server = createTestHarness({
    root: resolve('.'),
    workers: [{ config: {
      name: 'mi-note-cards-runtime', main: fixturePath,
      compatibility_date: productionConfig.compatibility_date,
      compatibility_flags: productionConfig.compatibility_flags,
      vars: { ALCHEMY_MI_NOTE_API_KEY: ALCHEMY_KEY, OPENSEA_API_KEY: OPENSEA_KEY },
      d1_databases: productionConfig.d1_databases.filter((database: Record<string, unknown>) => database.binding === 'OPS_DB')
        .map((database: Record<string, unknown>) => ({ ...database, migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)) })),
    } }],
  });
  let provider: Provider = async () => { throw new Error('Unexpected provider request'); };
  const requests: { url: URL; method: string | undefined; headers: Headers }[] = [];
  try {
    await server.listen();
    context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      requests.push({ url, method: init?.method, headers: new Headers(init?.headers) });
      return provider(url);
    });
    const nativeWorker = server.getWorker<Env>('mi-note-cards-runtime');
    await nativeWorker.applyD1Migrations('OPS_DB');
    const runtimeEnv = await nativeWorker.getEnv();
    const sessions = new Map<string, string>();
    const worker = { fetch: async (urlValue: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const url = new URL(urlValue);
      if (url.pathname === '/test-cache') return nativeWorker.fetch(urlValue, init);
      const address = url.searchParams.get('address')!;
      let token = sessions.get(address);
      if (!token) {
        const sessionId = crypto.randomUUID();
        const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
        const now = Date.now();
        await runtimeEnv.OPS_DB.prepare('INSERT INTO mi_note_auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(sessionId, crypto.randomUUID(), await sha256Hex(secret), address, 'mi_note_cards_devnet', ORIGIN, now, now + 3_600_000).run();
        token = `mons_mi_note_v1.${sessionId}.${secret}`;
        sessions.set(address, token);
      }
      const headers = new Headers(init?.headers);
      headers.set(MI_NOTE_SESSION_HEADER, token);
      return nativeWorker.fetch(urlValue, { ...init, headers: Object.fromEntries(headers) });
    } };

    await context.test('ownership refuses unverified callers before contacting providers', async () => {
      const before = requests.length;
      const denied = await nativeWorker.fetch(requestUrl(1), { headers: ALLOW_HEADERS });
      assert.equal(denied.status, 401);
      assert.equal(requests.length, before);
    });

    await context.test('frontend service proxy accepts same-origin GET without an Origin header', async () => {
      provider = async (url) => Response.json(url.hostname === 'api.opensea.io' ? originalBody() : modernBody());
      const response = await worker.fetch(requestUrl(9, '/api/mi-note-cards').replace('https://api.mons.shop', ORIGIN));
      assert.equal(response.status, 200);
      assert.ok(isExactMiNoteCardsResponse(await response.json()));
    });

    await context.test('paginates only assigned providers and returns JSON for the old Accept header', async () => {
      const before = requests.length;
      provider = async (url) => Response.json(url.hostname === 'api.opensea.io' ? originalBody() : modernBody(url.searchParams.get('pageKey')));
      const response = await worker.fetch(requestUrl(1), { headers: { ...ALLOW_HEADERS, Accept: 'application/x-ndjson' } });
      assert.equal(response.status, 200);
      assertHeaders(response);
      const body: unknown = await response.json();
      assert.ok(isExactMiNoteCardsResponse(body));
      assert.deepEqual(body.tokenIdsByContract, {
        [MI_NOTE_3_CONTRACT_ADDRESS]: ['1', '2', '12'],
        [MI_NOTE_2_CONTRACT_ADDRESS]: ['2', '4', '12'],
        [MI_NOTE_CONTRACT_ADDRESS]: [ORIGINAL_ID],
      });
      for (const contract of MI_NOTE_MODERN_CONTRACT_ADDRESSES) {
        assert.deepEqual(body.resultsByContract[contract], { status: 'success', provider: 'alchemy', visibilityLimited: false });
      }
      assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], { status: 'success', provider: 'opensea', visibilityLimited: true });
      assert.equal(requests.length - before, 3);
      assert.equal(requests.slice(before).filter(({ url }) => url.hostname === 'api.opensea.io').length, 1);
      assert.deepEqual(requests.slice(before).filter(({ url }) => url.hostname !== 'api.opensea.io').map(({ url }) => url.searchParams.get('pageKey')), [null, 'next +/&=?']);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      const cached = await worker.fetch(requestUrl(1), { headers: ALLOW_HEADERS });
      assertHeaders(cached);
      assert.deepEqual(await cached.json(), body);
      assert.equal(requests.length - before, 3);
    });

    await context.test('starts both lookups together and waits for both before response headers', async () => {
      const modern = pendingJson();
      const original = pendingJson();
      const starts = new Map(['alchemy', 'opensea'].map((name) => [name, Promise.withResolvers<void>()]));
      provider = async (url) => {
        const name = url.hostname === 'api.opensea.io' ? 'opensea' : 'alchemy';
        starts.get(name)!.resolve();
        return name === 'opensea' ? original.response : modern.response;
      };
      let responded = false;
      const response = worker.fetch(requestUrl(2), { headers: { ...ALLOW_HEADERS, Accept: 'application/x-ndjson' } }).then((value) => {
        responded = true;
        return value;
      });
      try {
        await within(Promise.all([...starts.values()].map(({ promise }) => promise)));
        assert.equal(responded, false);
        original.finish(originalBody());
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
        assert.equal(responded, false);
        modern.finish(modernBody());
        const completed = await within(response);
        assertHeaders(completed);
        assert.ok(isExactMiNoteCardsResponse(await completed.json()));
      } finally {
        original.finish(originalBody());
        modern.finish(modernBody());
      }
    });

    await context.test('keeps complete collection results when the other fixed provider fails', async () => {
      for (const modernFails of [false, true]) {
        const before = requests.length;
        provider = async (url) => {
          const original = url.hostname === 'api.opensea.io';
          return original === modernFails ? Response.json(original ? originalBody() : modernBody()) : new Response(null, { status: 503 });
        };
        const response = await worker.fetch(requestUrl(modernFails ? 4 : 3), { headers: ALLOW_HEADERS });
        assert.equal(response.status, 200);
        const body: unknown = await response.json();
        assert.ok(isExactMiNoteCardsResponse(body));
        for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
          const failed = contract === MI_NOTE_CONTRACT_ADDRESS ? !modernFails : modernFails;
          if (failed) {
            assert.deepEqual(body.tokenIdsByContract[contract], []);
            assert.deepEqual(body.resultsByContract[contract], { status: 'error', error: 'provider-unavailable' });
          } else assert.equal(body.resultsByContract[contract].status, 'success');
        }
        assert.equal(requests.length - before, 2);
      }
    });

    await context.test('rejects v4 cache entries from the wrong provider and preserves valid neighboring entries', async () => {
      const owner = 5;
      const seeded = await worker.fetch(requestUrl(owner, '/test-cache'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, tokenIds: ['999'], provider: 'opensea', visibilityLimited: true },
          { contractAddress: MI_NOTE_3_CONTRACT_ADDRESS, tokenIds: ['98'], provider: 'alchemy', visibilityLimited: false },
          { contractAddress: MI_NOTE_CONTRACT_ADDRESS, tokenIds: [ORIGINAL_ID], provider: 'alchemy', visibilityLimited: false },
        ]),
      });
      assert.equal(seeded.status, 200);
      const before = requests.length;
      provider = async (url) => Response.json(url.hostname === 'api.opensea.io' ? originalBody() : modernBody());
      const response = await worker.fetch(requestUrl(owner), { headers: ALLOW_HEADERS });
      assert.equal(response.status, 200);
      const body = await response.json() as MiNoteCardsResponse;
      assert.deepEqual(body.tokenIdsByContract, {
        [MI_NOTE_3_CONTRACT_ADDRESS]: ['98'],
        [MI_NOTE_2_CONTRACT_ADDRESS]: ['4', '12'],
        [MI_NOTE_CONTRACT_ADDRESS]: [ORIGINAL_ID],
      });
      assert.equal(requests.length - before, 2);
      assert.equal(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS].status, 'success');
    });

    await context.test('bounds a valid oversized provider page and rejects native redirects', async () => {
      provider = async (url) => url.hostname === 'api.opensea.io'
        ? Response.json({ ...originalBody(), padding: 'x'.repeat(256 * 1024) })
        : Response.json(modernBody());
      const oversized = await worker.fetch(requestUrl(6), { headers: ALLOW_HEADERS });
      assert.equal(oversized.status, 200);
      const body = await oversized.json() as MiNoteCardsResponse;
      assert.deepEqual(body.resultsByContract[MI_NOTE_CONTRACT_ADDRESS], { status: 'error', error: 'provider-unavailable' });
      assert.equal(body.resultsByContract[MI_NOTE_2_CONTRACT_ADDRESS].status, 'success');
      for (const status of [301, 302, 303, 307, 308]) {
        const before = requests.length;
        provider = async () => new Response(null, { status, headers: { Location: 'https://redirect-target.example/ownership' } });
        const response = await worker.fetch(requestUrl(status), { headers: ALLOW_HEADERS });
        assert.equal(response.status, 502);
        assertHeaders(response);
        assert.deepEqual(await response.json(), { ok: false, error: 'provider-unavailable' });
        assert.equal(requests.length - before, 2);
      }
    });

    await context.test('aborts native provider reads on deadline and explicit incoming cancellation', async () => {
      for (const cancel of [false, true]) {
        const before = requests.length;
        provider = async () => pendingJson().response;
        const response = await within(worker.fetch(`${requestUrl(cancel ? 8 : 7, '/test-bounded')}${cancel ? '&abort=1' : ''}`, { headers: ALLOW_HEADERS }));
        assert.equal(response.status, cancel ? 499 : 504);
        assert.equal(response.headers.get('X-Test-Aborted-Providers'), '2');
        assert.equal(response.headers.get('X-Test-Request-Aborted'), String(cancel));
        if (!cancel) assert.deepEqual(await response.json(), { ok: false, error: 'provider-timeout' });
        assert.equal(requests.length - before, 2);
      }
    });

    for (const { url, method, headers } of requests) {
      assert.equal(method, 'GET');
      if (url.hostname === 'api.opensea.io') {
        assert.match(url.pathname, /^\/api\/v2\/chain\/ethereum\/account\/0x[0-9a-f]{40}\/nfts$/);
        assert.equal(url.searchParams.get('collection'), 'minote');
        assert.equal(url.searchParams.get('include_auto_hidden'), 'true');
        assert.equal(url.searchParams.get('limit'), '100');
        assert.equal(headers.get('x-api-key'), OPENSEA_KEY);
        assert.equal(url.href.includes(OPENSEA_KEY), false);
      } else {
        assert.equal(url.origin, 'https://eth-mainnet.g.alchemy.com');
        assert.equal(url.pathname, `/nft/v3/${ALCHEMY_KEY}/getNFTsForOwner`);
        assert.deepEqual(url.searchParams.getAll('contractAddresses[]'), [...MI_NOTE_MODERN_CONTRACT_ADDRESSES]);
        assert.equal(url.searchParams.get('withMetadata'), 'false');
        assert.equal(url.searchParams.get('pageSize'), '100');
        assert.equal(headers.has('x-api-key'), false);
      }
    }
  } finally {
    await server.close();
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});
