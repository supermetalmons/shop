import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestHarness } from 'wrangler';
import {
  MI_NOTE_2_CONTRACT_ADDRESS,
  MI_NOTE_3_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESSES,
  MI_NOTE_MODERN_CONTRACT_ADDRESSES,
  isExactMiNoteCardsEvent,
  isExactMiNoteCardsResponse,
  type MiNoteCardsEvent,
  type MiNoteContractAddress,
} from '../../../../shared/miNoteCards.js';

const ORIGIN = 'https://mons.shop';
const ALCHEMY_KEY = 'alchemy-runtime-test-key';
const OPENSEA_KEY = 'opensea-runtime-test-key';
const STREAM_TYPE = 'application/x-ndjson';
const catalogs = JSON.parse(readFileSync('mi_note_eth.json', 'utf8')) as {
  contractAddress: MiNoteContractAddress;
  openseaSlug: string;
  tokens: { id: string }[];
}[];
const originalIds = catalogs.find((collection) => collection.contractAddress === MI_NOTE_CONTRACT_ADDRESS)!.tokens.map((token) => token.id);
type OutboundFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function urlOf(input: RequestInfo | URL): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}

function requestUrl(owner: number): string {
  return `https://api.mons.shop/mi-note-cards?address=0x${owner.toString(16).padStart(40, '0')}`;
}

function collectionEvent(contractAddress: MiNoteContractAddress, tokenIds: string[]) {
  return { type: 'collection', contractAddress, tokenIds, provider: 'alchemy', visibilityLimited: false };
}

function originalBalances(): Response {
  const word = (value: number) => value.toString(16).padStart(64, '0');
  const balances = originalIds.map((_id, index) => word(index === 0 || index === 72 ? 1 : 0));
  return Response.json({
    jsonrpc: '2.0', id: 'mi-note-original', result: `0x${word(32)}${word(originalIds.length)}${balances.join('')}`,
  });
}

function modernPage(pageKey: string | null): Response {
  return Response.json({
    ownedNfts: [
      ...(pageKey === null ? ['12', '2'] : ['4', '12']).map((tokenId) => ({
        contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, tokenId, balance: '1',
      })),
      ...(pageKey === null ? ['2'] : ['12', '1']).map((tokenId) => ({
        contractAddress: MI_NOTE_3_CONTRACT_ADDRESS, tokenId, balance: '1',
      })),
    ],
    pageKey: pageKey === null ? 'next +/&=?' : null,
  });
}

function parseEvents(text: string): MiNoteCardsEvent[] {
  const events: unknown[] = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  assert.ok(events.every(isExactMiNoteCardsEvent));
  assert.equal(events.at(-1)?.type, 'done');
  assert.equal(events.length, 4);
  return events;
}

function assertHeaders(response: { headers: { get(name: string): string | null } }, stream = false): void {
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(new Set(response.headers.get('Vary')?.split(',').map((value) => value.trim())), new Set(['Origin', 'Accept']));
  assert.match(response.headers.get('Content-Type') || '', stream ? /^application\/x-ndjson/ : /^application\/json/);
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
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(new TextEncoder().encode(' '));
    },
  }), { headers: { 'Content-Type': 'application/json' } });
  return {
    response,
    finish(body: unknown) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      controller.close();
    },
  };
}

test('Mi Note ownership streams and races providers through native workerd fetch', { timeout: 60_000 }, async (context) => {
  const productionConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  assert.ok(productionConfig.secrets.required.includes('OPENSEA_API_KEY'));
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'mons-mi-note-runtime-'));
  const fixturePath = join(fixtureDirectory, 'mi-note-runtime.mjs');
  await writeFile(fixturePath, `
import { handleRequest } from ${JSON.stringify(resolve('cloud/workers/api/src/index.ts'))};
const state = { requestAborted: false, providerAborted: false };
export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/test-cancellation-status') return Response.json(state);
    const watched = url.searchParams.get('address') === '0x0000000000000000000000000000000000000004';
    if (watched) request.signal.addEventListener('abort', () => { state.requestAborted = true; }, { once: true });
    return handleRequest(request, env, (promise) => ctx.waitUntil(promise), {
      providerFetch(input, init) {
        if (watched && String(input).includes('/nft/v3/')) {
          init.signal.addEventListener('abort', () => { state.providerAborted = true; }, { once: true });
        }
        return fetch(input, init);
      },
    });
  },
};
`, 'utf8');
  const server = createTestHarness({
    root: resolve('.'),
    workers: [{ config: {
      name: 'mi-note-cards-runtime',
      main: fixturePath,
      compatibility_date: productionConfig.compatibility_date,
      compatibility_flags: productionConfig.compatibility_flags,
      vars: { ALCHEMY_MI_NOTE_API_KEY: ALCHEMY_KEY, OPENSEA_API_KEY: OPENSEA_KEY },
    } }],
  });
  let provider: OutboundFetch = async () => { throw new Error('Unexpected provider request'); };
  try {
    const { url: serverUrl } = await server.listen();
    context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => provider(input, init));
    const worker = server.getWorker('mi-note-cards-runtime');

    await context.test('returns all three collections as JSON and reuses native cache for NDJSON', async () => {
      const outboundUrls: URL[] = [];
      provider = async (input, init) => {
        const url = urlOf(input);
        outboundUrls.push(url);
        assert.equal(url.origin, 'https://eth-mainnet.g.alchemy.com');
        assert.equal(new Headers(init?.headers).has('x-api-key'), false);
        if (url.pathname === `/v2/${ALCHEMY_KEY}`) {
          assert.equal(init?.method, 'POST');
          const body = await new Response(init?.body).json() as {
            jsonrpc: string; id: string; method: string; params: [{ to: string; data: string }, string];
          };
          assert.equal(body.method, 'eth_call');
          assert.equal(body.params[0].to, MI_NOTE_CONTRACT_ADDRESS);
          assert.equal(body.params[1], 'latest');
          assert.ok(body.params[0].data.startsWith('0x4e1273f4'));
          const words = body.params[0].data.slice(10).match(/.{64}/g)!;
          assert.equal(BigInt(`0x${words[2]}`), BigInt(originalIds.length));
          assert.deepEqual(words.slice(3, 3 + originalIds.length), Array(originalIds.length).fill('1'.padStart(64, '0')));
          assert.deepEqual(words.slice(4 + originalIds.length).map((word) => BigInt(`0x${word}`).toString()), originalIds);
          return originalBalances();
        }
        assert.equal(url.pathname, `/nft/v3/${ALCHEMY_KEY}/getNFTsForOwner`);
        assert.equal(init?.method, 'GET');
        assert.deepEqual(url.searchParams.getAll('contractAddresses[]'), [...MI_NOTE_MODERN_CONTRACT_ADDRESSES]);
        assert.equal(url.searchParams.get('withMetadata'), 'false');
        assert.equal(url.searchParams.get('pageSize'), '100');
        assert.ok(url.searchParams.get('pageKey') === null || url.searchParams.get('pageKey') === 'next +/&=?');
        return modernPage(url.searchParams.get('pageKey'));
      };
      const response = await worker.fetch(requestUrl(1), { headers: { Origin: ORIGIN } });
      assert.equal(response.status, 200);
      assertHeaders(response);
      const body: unknown = await response.json();
      assert.ok(isExactMiNoteCardsResponse(body));
      assert.deepEqual(body.tokenIdsByContract, {
        [MI_NOTE_2_CONTRACT_ADDRESS]: ['2', '4', '12'],
        [MI_NOTE_3_CONTRACT_ADDRESS]: ['1', '2', '12'],
        [MI_NOTE_CONTRACT_ADDRESS]: [originalIds[0], originalIds[72]],
      });
      for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
        assert.deepEqual(body.resultsByContract[contract], { status: 'success', provider: 'alchemy', visibilityLimited: false });
      }
      assert.equal(outboundUrls.length, 3);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      const stream = await worker.fetch(requestUrl(1), { headers: { Origin: ORIGIN, Accept: STREAM_TYPE } });
      assert.equal(stream.status, 200);
      assertHeaders(stream, true);
      const events = parseEvents(await stream.text());
      for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
        assert.deepEqual(events.find((event) => event.type === 'collection' && event.contractAddress === contract), collectionEvent(contract, body.tokenIdsByContract[contract]));
      }
      assert.equal(outboundUrls.length, 3);
    });

    await context.test('emits a completed collection before another provider body finishes', async () => {
      const pending = pendingJson();
      const started = Promise.withResolvers<void>();
      provider = async (input) => {
        const url = urlOf(input);
        if (url.pathname.startsWith('/v2/')) return originalBalances();
        if (url.origin === 'https://api.opensea.io') return new Response(null, { status: 503 });
        started.resolve();
        return pending.response;
      };
      const response = await worker.fetch(requestUrl(2), { headers: { Origin: ORIGIN, Accept: STREAM_TYPE } });
      assert.equal(response.status, 200);
      assertHeaders(response, true);
      const reader = response.body!.getReader();
      await within(started.promise);
      const decoder = new TextDecoder();
      let text = '';
      while (!text.trim() || !text.endsWith('\n')) {
        const first = await within(reader.read());
        assert.equal(first.done, false);
        text += decoder.decode(first.value);
      }
      assert.deepEqual(JSON.parse(text.trim()), collectionEvent(MI_NOTE_CONTRACT_ADDRESS, [originalIds[0], originalIds[72]]));
      pending.finish({ ownedNfts: [{ contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, tokenId: '7', balance: '1' }], pageKey: null });
      for (;;) {
        const chunk = await within(reader.read());
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
      const events = parseEvents(text);
      assert.deepEqual(events.find((event) => event.type === 'collection' && event.contractAddress === MI_NOTE_2_CONTRACT_ADDRESS), collectionEvent(MI_NOTE_2_CONTRACT_ADDRESS, ['7']));
      assert.deepEqual(events.find((event) => event.type === 'collection' && event.contractAddress === MI_NOTE_3_CONTRACT_ADDRESS), collectionEvent(MI_NOTE_3_CONTRACT_ADDRESS, []));
    });

    await context.test('uses the OpenSea header key and preserves collection metadata on fallback', async () => {
      const seen = new Set<string>();
      provider = async (input, init) => {
        const url = urlOf(input);
        if (url.origin === 'https://eth-mainnet.g.alchemy.com') return new Response(null, { status: 503 });
        assert.equal(url.origin, 'https://api.opensea.io');
        assert.equal(init?.method, 'GET');
        assert.equal(new Headers(init?.headers).get('x-api-key'), OPENSEA_KEY);
        assert.equal(url.href.includes(OPENSEA_KEY), false);
        assert.equal(url.searchParams.get('include_auto_hidden'), 'true');
        assert.equal(url.searchParams.get('limit'), '100');
        const catalog = catalogs.find((collection) => collection.openseaSlug === url.searchParams.get('collection'))!;
        assert.ok(catalog);
        seen.add(catalog.contractAddress);
        return Response.json({ nfts: [{
          contract: catalog.contractAddress, collection: catalog.openseaSlug, token_standard: 'erc1155', identifier: catalog.tokens[0].id,
        }], next: null });
      };
      const response = await worker.fetch(requestUrl(3), { headers: { Origin: ORIGIN } });
      assert.equal(response.status, 200);
      assertHeaders(response);
      const body: unknown = await response.json();
      assert.ok(isExactMiNoteCardsResponse(body));
      assert.deepEqual(seen, new Set(MI_NOTE_CONTRACT_ADDRESSES));
      for (const catalog of catalogs) {
        assert.deepEqual(body.tokenIdsByContract[catalog.contractAddress], [catalog.tokens[0].id]);
        assert.deepEqual(body.resultsByContract[catalog.contractAddress], { status: 'success', provider: 'opensea', visibilityLimited: true });
      }
    });

    await context.test('aborts the native provider signal after a client socket disconnects', async () => {
      const pending = pendingJson();
      provider = async (input) => {
        const url = urlOf(input);
        if (url.pathname.startsWith('/v2/')) return originalBalances();
        if (url.origin === 'https://api.opensea.io') return new Response(null, { status: 503 });
        return pending.response;
      };
      let socket: Socket | undefined;
      try {
        socket = createConnection({ host: serverUrl.hostname, port: Number(serverUrl.port) });
        await within(new Promise<void>((resolveReady, reject) => {
          let received = '';
          socket!.on('data', (chunk: Buffer) => {
            received += chunk.toString('utf8');
            if (received.includes(MI_NOTE_CONTRACT_ADDRESS)) {
              assert.match(received, /HTTP\/1\.1 200/);
              assert.match(received, /application\/x-ndjson/);
              resolveReady();
            }
          });
          socket!.once('error', reject);
          socket!.once('connect', () => {
            const url = new URL(requestUrl(4));
            socket!.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${serverUrl.host}\r\nOrigin: ${ORIGIN}\r\nAccept: ${STREAM_TYPE}\r\nConnection: keep-alive\r\n\r\n`);
          });
        }));
        const before = await worker.fetch('https://api.mons.shop/test-cancellation-status');
        assert.deepEqual(await before.json(), { requestAborted: false, providerAborted: false });
        socket.resetAndDestroy();
        let state = { requestAborted: false, providerAborted: false };
        for (let attempt = 0; attempt < 100 && !state.providerAborted; attempt += 1) {
          const status = await worker.fetch('https://api.mons.shop/test-cancellation-status');
          state = await status.json() as typeof state;
          if (!state.providerAborted) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        }
        assert.deepEqual(state, { requestAborted: true, providerAborted: true });
      } finally {
        socket?.destroy();
      }
    });

    await context.test('rejects native redirects for both providers and emits complete stream errors', async () => {
      for (const status of [301, 302, 303, 307, 308]) {
        const requests: URL[] = [];
        provider = async (input, init) => {
          const url = urlOf(input);
          requests.push(url);
          assert.ok(url.origin === 'https://eth-mainnet.g.alchemy.com' || url.origin === 'https://api.opensea.io');
          if (url.origin === 'https://api.opensea.io') {
            assert.equal(new Headers(init?.headers).get('x-api-key'), OPENSEA_KEY);
          }
          return new Response(null, { status, headers: { Location: 'https://redirect-target.example/ownership' } });
        };
        const response = await worker.fetch(requestUrl(status), { headers: { Origin: ORIGIN } });
        assert.equal(response.status, 502);
        assertHeaders(response);
        assert.deepEqual(await response.json(), { ok: false, error: 'provider-unavailable' });
        assert.equal(requests.length, 5);
        const stream = await worker.fetch(requestUrl(status), { headers: { Origin: ORIGIN, Accept: STREAM_TYPE } });
        assert.equal(stream.status, 200);
        assertHeaders(stream, true);
        const events = parseEvents(await stream.text());
        for (const contractAddress of MI_NOTE_CONTRACT_ADDRESSES) {
          assert.ok(events.some((event) => event.type === 'error' && event.contractAddress === contractAddress && event.error === 'provider-unavailable'));
        }
        assert.equal(requests.length, 10);
      }
    });
  } finally {
    await server.close();
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});
