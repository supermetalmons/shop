import assert from 'node:assert/strict';
import { setImmediate as waitForTurn } from 'node:timers/promises';
import bs58 from 'bs58';
import {
  HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES,
  HELIUS_SEARCH_ASSETS_MAX_TOTAL_BYTES,
  HELIUS_SEARCH_ASSETS_PAGE_LIMITS,
} from '../../../../shared/heliusDas.js';
import { listShopCollectionQueryRuntimes } from '../../../../shared/shopDomain.js';
import type { ProviderFetch } from '../src/workerPublicRoutes.js';
import { MAX_INVENTORY_RESPONSE_BODY_BYTES } from '../src/inventoryLimits.js';
import { loadApiWorkerIndex } from '../test/cloudflareWorkersTestLoader.js';
import { failOnDeferredWork } from '../test/deferredWork.js';

const { handleRequest } = await loadApiWorkerIndex();

const MIB = 1024 * 1024;
const DATA_PAGE_COUNT = 32;
const ITEMS_PER_PAGE = 64;
const ATTRIBUTE_PADDING_BYTES = 28_000;
const TARGET_RAW_BYTES_MIN = 50 * MIB;
const TARGET_RAW_BYTES_MAX = 60 * MIB;
const owner = bs58.encode(new Uint8Array(32).fill(7));
const scopes = listShopCollectionQueryRuntimes(true);
const targetScopeCandidate = scopes.find((scope) => scope.dropId === 'card_nft_2');
if (!targetScopeCandidate) throw new Error('Missing card_nft_2 inventory scope');
const targetScope = targetScopeCandidate;
const padding = 'x'.repeat(ATTRIBUTE_PADDING_BYTES);
const assetIds = Array.from({ length: DATA_PAGE_COUNT * ITEMS_PER_PAGE }, (_, index) => {
  const bytes = new Uint8Array(32).fill(3);
  new DataView(bytes.buffer).setUint32(28, index + 1, false);
  return bs58.encode(bytes);
}).sort();

assert.ok(scopes.length > 1);

let providerResponseBytes = 0;
let providerCalls = 0;
let activeProviderCalls = 0;
let maxActiveProviderCalls = 0;
let activeProviderBodyReads = 0;
let maxActiveProviderBodyReads = 0;
const requestedCursors = new Set<string>();

function responseFor(id: unknown, result: unknown): Response {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  const byteLength = Buffer.byteLength(body, 'utf8');
  assert.ok(byteLength <= HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES);
  providerResponseBytes += byteLength;
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  let reading = false;
  let finished = false;
  const finishReading = () => {
    if (!reading || finished) return;
    finished = true;
    activeProviderBodyReads -= 1;
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!reading) {
        reading = true;
        activeProviderBodyReads += 1;
        maxActiveProviderBodyReads = Math.max(maxActiveProviderBodyReads, activeProviderBodyReads);
      }
      await waitForTurn();
      const end = Math.min(offset + 256 * 1024, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
      if (offset === bytes.byteLength) {
        controller.close();
        finishReading();
      }
    },
    cancel() {
      finishReading();
    },
  }, { highWaterMark: 0 });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Length': String(byteLength),
      'Content-Type': 'application/json',
    },
  });
}

function pageAssets(pageIndex: number): unknown[] {
  const firstAsset = pageIndex * ITEMS_PER_PAGE;
  return assetIds.slice(firstAsset, firstAsset + ITEMS_PER_PAGE).map((id, offset) => {
    const assetNumber = firstAsset + offset + 1;
    return {
      id,
      grouping: [{ group_key: 'collection', group_value: targetScope.collectionMint }],
      content: {
        json_uri: `${targetScope.metadataBase}/b${assetNumber}.json`,
        metadata: {
          name: `Memory Box #${assetNumber}`,
          attributes: [
            { trait_type: 'type', value: 'box' },
            { trait_type: 'fixture_padding', value: padding },
          ],
        },
      },
    };
  });
}

const providerFetch: ProviderFetch = async (_input, init) => {
  providerCalls += 1;
  activeProviderCalls += 1;
  maxActiveProviderCalls = Math.max(maxActiveProviderCalls, activeProviderCalls);
  try {
    await waitForTurn();
    const requestBody = init?.body;
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body');
    const rpc = JSON.parse(requestBody) as {
      id: unknown;
      method: string;
      params: Record<string, unknown>;
    };
    assert.equal(rpc.method, 'searchAssets');
    const params = rpc.params;
    assert.deepEqual(params.sortBy, { sortBy: 'id', sortDirection: 'asc' });
    assert.equal(typeof params.limit, 'number');
    assert.ok((HELIUS_SEARCH_ASSETS_PAGE_LIMITS as readonly number[]).includes(params.limit as number));
    assert.equal(Object.hasOwn(params, 'page'), false);
    const grouping = params.grouping;
    assert.ok(Array.isArray(grouping));
    assert.equal(grouping[0], 'collection');
    const collectionMint = grouping[1];
    if (collectionMint !== targetScope.collectionMint) {
      assert.equal(params.cursor, undefined);
      return responseFor(rpc.id, { items: [], total: 0, limit: params.limit });
    }

    const cursor = params.cursor;
    const pageIndex = cursor === undefined
      ? 0
      : typeof cursor === 'string' && /^memory-page-\d+$/.test(cursor)
        ? Number(cursor.slice('memory-page-'.length))
        : Number.NaN;
    assert.ok(Number.isSafeInteger(pageIndex) && pageIndex >= 0 && pageIndex <= DATA_PAGE_COUNT);
    const cursorKey = cursor === undefined ? 'initial' : String(cursor);
    assert.equal(requestedCursors.has(cursorKey), false);
    requestedCursors.add(cursorKey);
    if (pageIndex === DATA_PAGE_COUNT) {
      return responseFor(rpc.id, {
        items: [],
        total: assetIds.length + 1,
        limit: params.limit,
      });
    }
    return responseFor(rpc.id, {
      items: pageAssets(pageIndex),
      cursor: `memory-page-${pageIndex + 1}`,
      total: assetIds.length + (pageIndex % 2),
      limit: params.limit,
    });
  } finally {
    activeProviderCalls -= 1;
  }
};

const env: Env = {
  DATA_DB: {} as D1Database,
  OPS_DB: {} as D1Database,
  COMMERCE_DB: {} as D1Database,
  ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW: {} as Env['ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW'],
  STAFF_AUTH_CHALLENGE_RATE_LIMITER: { limit: async () => ({ success: true }) },
  STAFF_AUTH_SESSION_RATE_LIMITER: { limit: async () => ({ success: true }) },
  ANONYMOUS_AUTH_SESSION_RATE_LIMITER: { limit: async () => ({ success: true }) },
  PUBLIC_RPC_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
  PUBLIC_RPC_WRITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
  PUBLIC_SHOP_RATE_LIMITER: { limit: async () => ({ success: true }) },
  PUBLIC_NOTIFICATION_RATE_LIMITER: { limit: async () => ({ success: true }) },
  NOTIFICATION_EMAIL_QUEUE: {
    send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  },
  REVEAL_BACKGROUND_QUEUE: {
    send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  },
  STRIPE_FULFILLMENT_QUEUE: {
    send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  },
  HELIUS_API_KEY: 'memory-test-key',
  RESEND_API_KEY: '',
  RESEND_CONTACTS_API_KEY: 'memory-resend-test-key',
  NOTIFICATION_ENQUEUE_SECRET: 'memory-notification-enqueue-secret',
  ADDRESS_DECRYPTION_SECRET: '',
  COSIGNER_SECRET: '',
  SHIPSTATION_API_KEY: '',
  SHIPSTATION_SHIP_FROM: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_RESTRICTED_KEY: '',
  STRIPE_SECRET_KEY_LIVE: '',
  STRIPE_RESTRICTED_KEY_LIVE: '',
  STRIPE_WEBHOOK_SECRET_DEVNET: 'whsec_memory_devnet',
  STRIPE_WEBHOOK_SECRET: 'whsec_memory_mainnet',
};
const response = await handleRequest(new Request('https://api.mons.shop/inventory', {
  method: 'POST',
  headers: {
    'CF-Connecting-IP': '203.0.113.10',
    'Content-Type': 'application/json',
    Origin: 'https://mons.shop',
  },
  body: JSON.stringify({ owner, includeDevnet: true }),
}), env, failOnDeferredWork, {
  providerFetch,
  randomUint32: () => 0,
  sleep: async () => undefined,
  log: () => undefined,
});

assert.equal(response.status, 200, await response.clone().text());
const responseBody = await response.text();
const responseBytes = Buffer.byteLength(responseBody, 'utf8');
assert.ok(responseBytes <= MAX_INVENTORY_RESPONSE_BODY_BYTES);
const payload = JSON.parse(responseBody) as { ok: boolean; items: Array<Record<string, unknown>> };
assert.equal(payload.ok, true);
assert.equal(payload.items.length, assetIds.length);
assert.ok(payload.items.every((item) => !Object.hasOwn(item, 'attributes')));
assert.ok(providerResponseBytes >= TARGET_RAW_BYTES_MIN);
assert.ok(providerResponseBytes <= TARGET_RAW_BYTES_MAX);
assert.ok(providerResponseBytes <= HELIUS_SEARCH_ASSETS_MAX_TOTAL_BYTES);
assert.equal(maxActiveProviderCalls, 3);
assert.equal(maxActiveProviderBodyReads, 1);
assert.equal(requestedCursors.size, DATA_PAGE_COUNT + 1);
assert.equal(providerCalls, DATA_PAGE_COUNT + 1 + scopes.length - 1);

process.stdout.write(`${JSON.stringify({
  providerCalls,
  providerResponseBytes,
  responseBytes,
  items: payload.items.length,
  maxActiveProviderCalls,
  maxActiveProviderBodyReads,
})}\n`);
