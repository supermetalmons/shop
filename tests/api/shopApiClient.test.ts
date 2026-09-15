import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { CARD_NFT_2_PACK_BASE_URL } from '../../src/config/dropMediaDefaults.ts';
import {
  SHOP_API_MAX_RESPONSE_ITEMS,
  SHOP_INVENTORY_BOX_ID_MAX_UTF8_BYTES,
  SHOP_INVENTORY_NAME_MAX_UTF8_BYTES,
  SHOP_INVENTORY_RAW_IMAGE_MAX_UTF8_BYTES,
  SHOP_PENDING_OPEN_MAX_DUDE_ASSET_IDS,
  isExactShopInventoryResponse,
  isExactShopPendingOpenBoxesResponse,
} from '../../shared/shopApi.ts';
import { createShopApiClient } from '../../src/api/shop.ts';
import { fetchInventory, fetchMiNoteHoldings, fetchPackStatus, fetchPendingOpenBoxes } from '../../src/lib/shopApi.ts';
import { rpcEndpointForCluster, SHOP_SOLANA_CONNECTION_CONFIG } from '../../src/lib/shopRpc.ts';
import {
  MAX_MI_NOTE_STREAM_BYTES,
  MI_NOTE_2_CONTRACT_ADDRESS,
  MI_NOTE_3_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESSES,
  type MiNoteCardsCollectionEvent,
  type MiNoteCardsEvent,
  type MiNoteCardsOutcome,
  type MiNoteContractAddress,
} from '../../shared/miNoteCards.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';

function miNoteCollection(contractAddress: MiNoteContractAddress, tokenIds: string[]): MiNoteCardsCollectionEvent {
  return {
    type: 'collection', contractAddress, tokenIds,
    provider: contractAddress === MI_NOTE_CONTRACT_ADDRESS ? 'opensea' : 'alchemy',
    visibilityLimited: contractAddress === MI_NOTE_CONTRACT_ADDRESS,
  };
}

function miNoteHoldings(miNote2: string[] = [], miNote3: string[] = [], original: string[] = []): MiNoteCardsEvent[] {
  return [
    miNoteCollection(MI_NOTE_2_CONTRACT_ADDRESS, miNote2),
    miNoteCollection(MI_NOTE_3_CONTRACT_ADDRESS, miNote3),
    miNoteCollection(MI_NOTE_CONTRACT_ADDRESS, original),
    { type: 'done' },
  ];
}

function miNoteStream(events: unknown[], separator = '\n'): Response {
  return new Response(events.map((event) => `${JSON.stringify(event)}${separator}`).join(''), {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  });
}

function openMiNoteStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { cancelled = true; },
  });
  return {
    response: new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    emit: (event: unknown) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)),
    close: () => controller.close(),
    get cancelled() { return cancelled; },
  };
}

const PACK_STATUS = {
  dropId: 'card_nft_2',
  total: 11133,
  totalInitialSupply: 3711,
  totalCards: 11133,
  cardsPerPack: 3,
  unsealedOnline: 2,
  unsealedCards: 6,
  redeemedIrl: 3,
  redeemedIrlNormal: 1,
  redeemedIrlStripe: 2,
  redeemedUnsealedCards: 1,
  redeemedCards: 10,
  items: [
    { key: 'unsealed', label: 'Unpacked', amount: 6, percentage: 0.05 },
    { key: 'redeemed', label: 'Redeemed', amount: 10, percentage: 0.09 },
    { key: 'total', label: 'Total', amount: 11133, percentage: 100 },
  ],
} as const;

test('frontend RPC endpoints and connection policy use the shared mons API origin', () => {
  assert.equal(rpcEndpointForCluster('mainnet-beta'), 'https://api.mons.shop/rpc/mainnet-beta');
  assert.equal(rpcEndpointForCluster('devnet'), 'https://api.mons.shop/rpc/devnet');
  assert.deepEqual(SHOP_SOLANA_CONNECTION_CONFIG, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  });
  assert.equal(Object.isFrozen(SHOP_SOLANA_CONNECTION_CONFIG), true);
});

async function withFetch(fetchImpl: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function stalledBodyResponse(signal: AbortSignal, onBodyStarted: () => void): Response {
  return {
    ok: true,
    status: 200,
    json: () => new Promise<never>((_resolve, reject) => {
      onBodyStarted();
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }),
  } as unknown as Response;
}

test('inventory client uses api.mons.shop, no-store, abort signals, and display-image normalization', async () => {
  await withFetch((async (input, init) => {
    assert.equal(String(input), 'https://api.mons.shop/inventory');
    assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal);
    assert.deepEqual(JSON.parse(String(init?.body)), { owner: OWNER });
    return Response.json({
      ok: true,
      items: [{
        id: 'pack-one',
        dropId: 'card_nft_2',
        name: 'pack 184',
        kind: 'box',
        rawImage: 'https://legacy.example/pack.webp',
        attributes: [{ trait_type: 'serial', value: '184' }],
        boxId: '184',
      }],
    });
  }) as typeof fetch, async () => {
    const items = await fetchInventory(OWNER);
    assert.equal(items[0].image, `${CARD_NFT_2_PACK_BASE_URL}/4/initial.webp`);
    assert.equal(items[0].boxId, '184');
    assert.equal(Object.prototype.hasOwnProperty.call(items[0], 'attributes'), false);
  });
});

test('inventory client serializes expected asset IDs by cluster without changing the default request', async () => {
  const mainnetAsset = '11111111111111111111111111111111';
  const devnetAsset = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
  await withFetch((async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), {
      owner: OWNER,
      includeDevnet: true,
      expectedAssetIds: {
        'mainnet-beta': [mainnetAsset],
        devnet: [devnetAsset],
      },
    });
    return Response.json({ ok: true, items: [] });
  }) as typeof fetch, async () => {
    await fetchInventory(OWNER, {
      includeDevnet: true,
      expectedAssetIds: {
        'mainnet-beta': [mainnetAsset],
        devnet: [devnetAsset],
      },
    });
  });
});

test('pack-status client uses api.mons.shop GET without browser caching', async () => {
  await withFetch((async (input, init) => {
    assert.equal(String(input), 'https://api.mons.shop/pack-status/card_nft_2');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.body, undefined);
    assert.ok(init?.signal);
    return Response.json({ ok: true, packStatus: PACK_STATUS });
  }) as typeof fetch, async () => {
    assert.deepEqual(await fetchPackStatus('card_nft_2'), PACK_STATUS);
  });
});

test('pack-status client accepts null and rejects malformed or mismatched responses', async () => {
  await withFetch((async () => Response.json({ ok: true, packStatus: null })) as typeof fetch, async () => {
    assert.equal(await fetchPackStatus('card_nft_2'), null);
  });
  for (const payload of [
    { ok: true, packStatus: { ...PACK_STATUS, extra: true } },
    { ok: true, packStatus: { ...PACK_STATUS, dropId: 'poncho_drifella' } },
    { ok: true, packStatus: { ...PACK_STATUS, items: PACK_STATUS.items.slice(0, 2) } },
  ]) {
    await withFetch((async () => Response.json(payload)) as typeof fetch, async () => {
      await assert.rejects(fetchPackStatus('card_nft_2'), /invalid pack-status response/);
    });
  }
});

test('pack-status client propagates aborts and API errors', async () => {
  await withFetch((async (_input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    throw new Error('unexpected');
  }) as typeof fetch, async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('aborted', 'AbortError'));
    await assert.rejects(fetchPackStatus('card_nft_2', controller.signal), { name: 'AbortError' });
  });
  await withFetch((async () => Response.json(
    { ok: false, error: 'provider-unavailable' },
    { status: 502 },
  )) as typeof fetch, async () => {
    await assert.rejects(fetchPackStatus('card_nft_2'), /provider-unavailable/);
  });
});

test('Mi Note cards client requests the worker with an encoded address, no-store, and an abort signal', async () => {
  const address = '0x000533f50ddd7f2fc4EfD06137b0c1A12CfB7Bb9';
  const events = miNoteHoldings(['2', '1154'], ['2', '117'], ['1']);
  await withFetch((async (input, init) => {
    assert.equal(String(input), `https://api.mons.shop/mi-note-cards?address=${encodeURIComponent(address)}`);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.cache, 'no-store');
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/x-ndjson');
    assert.equal(init?.body, undefined);
    assert.ok(init?.signal);
    return miNoteStream(events);
  }) as typeof fetch, async () => {
    const outcomes: MiNoteCardsOutcome[] = [];
    await fetchMiNoteHoldings(address, (outcome) => outcomes.push(outcome));
    assert.deepEqual(outcomes, events.slice(0, 3));
  });
});

test('Mi Note cards client accepts empty holdings and rejects invalid response data', async () => {
  await withFetch((async () => miNoteStream(miNoteHoldings())) as typeof fetch, async () => {
    const outcomes: MiNoteCardsOutcome[] = [];
    await fetchMiNoteHoldings(OWNER, (outcome) => outcomes.push(outcome));
    assert.deepEqual(outcomes, miNoteHoldings().slice(0, 3));
  });
  for (const event of [
    { ok: true, tokenIds: ['1'] },
    { ...miNoteCollection(MI_NOTE_2_CONTRACT_ADDRESS, []), tokenIds: [1] },
    miNoteCollection(MI_NOTE_2_CONTRACT_ADDRESS, ['1', '1']),
    miNoteCollection(MI_NOTE_3_CONTRACT_ADDRESS, ['0x1']),
    { ...miNoteCollection(MI_NOTE_CONTRACT_ADDRESS, ['1']), extra: true },
    { ...miNoteCollection(MI_NOTE_2_CONTRACT_ADDRESS, []), visibilityLimited: true },
    { ...miNoteCollection(MI_NOTE_CONTRACT_ADDRESS, []), visibilityLimited: false },
  ]) {
    await withFetch((async () => miNoteStream([event])) as typeof fetch, async () => {
      await assert.rejects(fetchMiNoteHoldings(OWNER, () => assert.fail('Invalid event was delivered')), /invalid Mi Note cards response/);
    });
  }
  await withFetch((async () => Response.json({ ok: true, tokenIds: ['1'] })) as typeof fetch, async () => {
    await assert.rejects(fetchMiNoteHoldings(OWNER, () => {}), /invalid Mi Note cards response/);
  });
});

test('Mi Note cards client propagates aborts and provider failures', async () => {
  await withFetch((async (_input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    throw new Error('unexpected');
  }) as typeof fetch, async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('aborted', 'AbortError'));
    await assert.rejects(fetchMiNoteHoldings(OWNER, () => {}, controller.signal), { name: 'AbortError' });
  });
  await withFetch((async () => Response.json(
    { ok: false, error: 'provider-unavailable' },
    { status: 502 },
  )) as typeof fetch, async () => {
    await assert.rejects(fetchMiNoteHoldings(OWNER, () => {}), /provider-unavailable/);
  });
});

test('Mi Note cards client delivers outcomes before the stream completes', async () => {
  const stream = openMiNoteStream();
  const outcomes: MiNoteCardsOutcome[] = [];
  let received!: () => void;
  const firstOutcome = new Promise<void>((resolve) => { received = resolve; });
  let finished = false;
  await withFetch((async () => stream.response) as typeof fetch, async () => {
    const request = fetchMiNoteHoldings(OWNER, (outcome) => { outcomes.push(outcome); received(); })
      .then(() => { finished = true; });
    const original = miNoteCollection(MI_NOTE_CONTRACT_ADDRESS, ['1']);
    stream.emit(original);
    await firstOutcome;
    assert.deepEqual(outcomes, [original]);
    assert.equal(finished, false);
    stream.emit({ type: 'error', contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, error: 'provider-timeout' });
    stream.emit(miNoteCollection(MI_NOTE_3_CONTRACT_ADDRESS, ['2']));
    stream.emit({ type: 'done' });
    stream.close();
    await request;
    assert.equal(outcomes.length, 3);
    assert.equal(outcomes[1].type, 'error');
  });
});

test('Mi Note cards client preserves delivered outcomes when a later event is invalid', async () => {
  const first = miNoteCollection(MI_NOTE_2_CONTRACT_ADDRESS, ['2']);
  const outcomes: MiNoteCardsOutcome[] = [];
  await withFetch((async () => miNoteStream([first, { type: 'collection', contractAddress: 'unknown' }])) as typeof fetch, async () => {
    await assert.rejects(fetchMiNoteHoldings(OWNER, (outcome) => outcomes.push(outcome)), /invalid Mi Note cards response/);
    assert.deepEqual(outcomes, [first]);
  });
});

test('Mi Note cards client decodes split chunks, CRLF lines, and an unterminated final line', async () => {
  const events = miNoteHoldings(['2'], ['2'], ['3']);
  const text = events.map((event) => JSON.stringify(event)).join('\r\n');
  const bytes = new TextEncoder().encode(text);
  await withFetch((async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'application/x-ndjson' } })) as typeof fetch, async () => {
    const outcomes: MiNoteCardsOutcome[] = [];
    await fetchMiNoteHoldings(OWNER, (outcome) => outcomes.push(outcome));
    assert.deepEqual(outcomes, events.slice(0, 3));
  });
});

test('Mi Note cards client ignores blank keepalives before and between collection outcomes', async () => {
  const events = miNoteHoldings(['2'], ['3'], ['4']);
  const body = '\n\r\n \t\n' + events.map((event) => `${JSON.stringify(event)}\n\n\r\n \t\n`).join('');
  await withFetch((async () => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })) as typeof fetch, async () => {
    const outcomes: MiNoteCardsOutcome[] = [];
    await fetchMiNoteHoldings(OWNER, (outcome) => outcomes.push(outcome));
    assert.deepEqual(outcomes, events.slice(0, 3));
  });
});

test('Mi Note cards keepalives cannot replace required outcomes or terminal done', async () => {
  for (const body of [
    '\n\r\n \t\n',
    '\n{"type":"done"}\n',
    '\n' + miNoteHoldings().slice(0, 3).map((event) => `${JSON.stringify(event)}\n\n`).join(''),
  ]) {
    const outcomes: MiNoteCardsOutcome[] = [];
    await withFetch((async () => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })) as typeof fetch, async () => {
      await assert.rejects(fetchMiNoteHoldings(OWNER, (outcome) => outcomes.push(outcome)), /invalid Mi Note cards response/);
    });
    assert.equal(outcomes.length, body.includes('collection') ? 3 : 0);
  }
});

test('Mi Note cards client requires one unique outcome per contract followed by terminal done', async () => {
  const events = miNoteHoldings();
  const error = { type: 'error', contractAddress: MI_NOTE_2_CONTRACT_ADDRESS, error: 'provider-timeout' };
  for (const malformed of [
    [], [{ type: 'done' }], events.slice(0, 3), [...events.slice(0, 2), { type: 'done' }],
    [...events, { type: 'done' }], [...events, events[0]],
    [events[0], ...events], [error, ...events], [error, error, ...events.slice(1)],
    [{ type: 'error', contractAddress: 'unknown', error: 'provider-timeout' }, ...events],
    [events[0], { type: 'error', contractAddress: MI_NOTE_3_CONTRACT_ADDRESS, error: 'unknown' }, ...events.slice(2)],
  ]) {
    await withFetch((async () => miNoteStream(malformed)) as typeof fetch, async () => {
      await assert.rejects(fetchMiNoteHoldings(OWNER, () => {}), /invalid Mi Note cards response/);
    });
  }
  const errors = MI_NOTE_CONTRACT_ADDRESSES.map((contractAddress) => ({
    type: 'error', contractAddress, error: 'provider-unavailable',
  }));
  await withFetch((async () => miNoteStream([...errors, { type: 'done' }])) as typeof fetch, async () => {
    const outcomes: MiNoteCardsOutcome[] = [];
    await fetchMiNoteHoldings(OWNER, (outcome) => outcomes.push(outcome));
    assert.deepEqual(outcomes, errors);
  });
});

test('Mi Note cards client enforces the combined token limit before publishing an overflowing group', async () => {
  const ids = Array.from({ length: 5000 }, (_, index) => String(index));
  await withFetch((async () => miNoteStream(miNoteHoldings(ids, ids))) as typeof fetch, async () => {
    const outcomes: MiNoteCardsOutcome[] = [];
    await fetchMiNoteHoldings(OWNER, (outcome) => outcomes.push(outcome));
    assert.equal(outcomes.length, 3);
  });
  await withFetch((async () => miNoteStream(miNoteHoldings(ids, [...ids, '5000']))) as typeof fetch, async () => {
    const outcomes: MiNoteCardsOutcome[] = [];
    await assert.rejects(fetchMiNoteHoldings(OWNER, (outcome) => outcomes.push(outcome)), /invalid Mi Note cards response/);
    assert.deepEqual(outcomes, [miNoteCollection(MI_NOTE_2_CONTRACT_ADDRESS, ids)]);
  });
});

test('Mi Note cards client bounds incremental stream bytes and rejects malformed UTF-8', async () => {
  const body = miNoteHoldings().map((event) => `${JSON.stringify(event)}\n`).join('');
  const exact = ' '.repeat(MAX_MI_NOTE_STREAM_BYTES - body.length) + body;
  await withFetch((async () => new Response(exact, { headers: { 'Content-Type': 'application/x-ndjson' } })) as typeof fetch, async () => {
    const outcomes: MiNoteCardsOutcome[] = [];
    await fetchMiNoteHoldings(OWNER, (outcome) => outcomes.push(outcome));
    assert.equal(outcomes.length, 3);
  });
  for (const chunks of [
    [new TextEncoder().encode(exact), new Uint8Array([32])],
    [new Uint8Array([0xff])],
    [new TextEncoder().encode('{broken}\n')],
  ]) {
    let cancelled = false;
    await withFetch((async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/x-ndjson' } })) as typeof fetch, async () => {
      await assert.rejects(fetchMiNoteHoldings(OWNER, () => {}));
      assert.equal(cancelled, true);
    });
  }
});

test('Mi Note cards client cancels and rejects an open stream on external abort', async () => {
  const stream = openMiNoteStream();
  const controller = new AbortController();
  const outcomes: MiNoteCardsOutcome[] = [];
  let received!: () => void;
  const first = new Promise<void>((resolve) => { received = resolve; });
  await withFetch((async () => stream.response) as typeof fetch, async () => {
    const request = fetchMiNoteHoldings(OWNER, (outcome) => { outcomes.push(outcome); received(); }, controller.signal);
    stream.emit(miNoteCollection(MI_NOTE_2_CONTRACT_ADDRESS, ['2']));
    await first;
    controller.abort(new DOMException('aborted', 'AbortError'));
    await assert.rejects(request, { name: 'AbortError' });
    assert.equal(stream.cancelled, true);
    assert.equal(outcomes.length, 1);
  });
});

test('Mi Note cards timeout remains active after an early collection arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = openMiNoteStream();
  let received!: () => void;
  const first = new Promise<void>((resolve) => { received = resolve; });
  await withFetch((async () => stream.response) as typeof fetch, async () => {
    const outcomes: MiNoteCardsOutcome[] = [];
    const request = fetchMiNoteHoldings(OWNER, (outcome) => { outcomes.push(outcome); received(); });
    stream.emit(miNoteCollection(MI_NOTE_2_CONTRACT_ADDRESS, ['2']));
    await first;
    t.mock.timers.tick(70_000);
    await assert.rejects(request, { name: 'TimeoutError' });
    assert.equal(stream.cancelled, true);
    assert.equal(outcomes.length, 1);
  });
});

test('Mi Note cards client aborts a stalled fetch and cancels a late response body', async () => {
  const stream = openMiNoteStream();
  const controller = new AbortController();
  let resolveFetch!: (response: Response) => void;
  await withFetch((() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as typeof fetch, async () => {
    const request = fetchMiNoteHoldings(OWNER, () => assert.fail('Aborted response was delivered'), controller.signal);
    controller.abort(new DOMException('aborted', 'AbortError'));
    await assert.rejects(request, { name: 'AbortError' });
    resolveFetch(stream.response);
    await Promise.resolve();
    assert.equal(stream.cancelled, true);
  });
});

test('pack-status frontend client delegates only to the shop transport', async () => {
  const calls: string[] = [];
  const client = createShopApiClient({
    fetchPackStatus: async (dropId) => {
      calls.push(dropId);
      return null;
    },
  });
  assert.equal(await client.getDropPackStatus(' CARD_NFT_2 '), null);
  assert.deepEqual(calls, ['card_nft_2']);
});

test('inventory client accepts exact string bounds and rejects each over-limit field', async () => {
  const boundaryItem = {
    id: 'boundary-item',
    dropId: 'card_nft_2',
    name: 'é'.repeat(SHOP_INVENTORY_NAME_MAX_UTF8_BYTES / 2),
    kind: 'box',
    rawImage: 'i'.repeat(SHOP_INVENTORY_RAW_IMAGE_MAX_UTF8_BYTES),
    boxId: 'b'.repeat(SHOP_INVENTORY_BOX_ID_MAX_UTF8_BYTES),
  } as const;
  await withFetch((async () => Response.json({ ok: true, items: [boundaryItem] })) as typeof fetch, async () => {
    const items = await fetchInventory(OWNER);
    assert.equal(items[0].name, boundaryItem.name);
    assert.equal(items[0].boxId, boundaryItem.boxId);
  });

  for (const item of [
    { ...boundaryItem, name: `${boundaryItem.name}n` },
    { ...boundaryItem, rawImage: `${boundaryItem.rawImage}i` },
    { ...boundaryItem, boxId: `${boundaryItem.boxId}b` },
  ]) {
    await withFetch((async () => Response.json({ ok: true, items: [item] })) as typeof fetch, async () => {
      await assert.rejects(fetchInventory(OWNER), /invalid inventory response/);
    });
  }
});

test('shop response decoders enforce protocol array bounds', () => {
  const inventoryItem = {
    id: 'bounded-item',
    dropId: 'card_nft_2',
    name: 'Bounded item',
    kind: 'box',
  } as const;
  assert.equal(isExactShopInventoryResponse({
    ok: true,
    items: Array(SHOP_API_MAX_RESPONSE_ITEMS).fill(inventoryItem),
  }), true);
  assert.equal(isExactShopInventoryResponse({
    ok: true,
    items: Array(SHOP_API_MAX_RESPONSE_ITEMS + 1).fill(inventoryItem),
  }), false);

  const pendingItem = {
    dropId: 'card_nft_2',
    pendingPda: 'pending',
    boxAssetId: 'box',
    dudeAssetIds: Array(SHOP_PENDING_OPEN_MAX_DUDE_ASSET_IDS).fill('dude'),
  };
  assert.equal(isExactShopPendingOpenBoxesResponse({ ok: true, items: [pendingItem] }), true);
  assert.equal(isExactShopPendingOpenBoxesResponse({
    ok: true,
    items: [{ ...pendingItem, dudeAssetIds: [] }],
  }), false);
  assert.equal(isExactShopPendingOpenBoxesResponse({
    ok: true,
    items: [{ ...pendingItem, dudeAssetIds: [...pendingItem.dudeAssetIds, 'extra'] }],
  }), false);
});

test('client rejects malformed success responses', async () => {
  await withFetch((async () => Response.json({ ok: true, items: [{ id: 'missing-fields' }] })) as typeof fetch, async () => {
    await assert.rejects(fetchInventory(OWNER), /invalid inventory response/);
  });
  await withFetch((async () => Response.json({
    ok: true,
    items: [{ id: 'dude-zero', dropId: 'drop', name: 'Dude #0', kind: 'dude', dudeId: 0 }],
  })) as typeof fetch, async () => {
    await assert.rejects(fetchInventory(OWNER), /invalid inventory response/);
  });
  await withFetch((async () => Response.json({ ok: true, items: [{ dropId: 'x', pendingPda: 'p', boxAssetId: 'b', dudeAssetIds: [], extra: true }] })) as typeof fetch, async () => {
    await assert.rejects(fetchPendingOpenBoxes(OWNER), /invalid pending-open response/);
  });
});

test('external abort remains active while the shop API response body is stalled', async () => {
  const controller = new AbortController();
  let bodyStarted!: () => void;
  const bodyStartedPromise = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  await withFetch((async (_input, init) => {
    assert.ok(init?.signal);
    return stalledBodyResponse(init.signal, bodyStarted);
  }) as typeof fetch, async () => {
    const pending = fetchInventory(OWNER, { signal: controller.signal });
    await bodyStartedPromise;
    controller.abort(new DOMException('aborted', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
  });
});

test('shop API timeout remains active while the response body is stalled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyStarted!: () => void;
  const bodyStartedPromise = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  await withFetch((async (_input, init) => {
    assert.ok(init?.signal);
    return stalledBodyResponse(init.signal, bodyStarted);
  }) as typeof fetch, async () => {
    const pending = fetchInventory(OWNER);
    await bodyStartedPromise;
    t.mock.timers.tick(70_000);
    await assert.rejects(pending, { name: 'TimeoutError' });
  });
});

test('client propagates aborts and React Query preserves last-good inventory after a refresh failure', async () => {
  await withFetch((async (_input, init) => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    throw new Error('unexpected');
  }) as typeof fetch, async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetchInventory(OWNER, { signal: controller.signal }), { name: 'AbortError' });
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ['inventory', OWNER, false];
  const lastGood = [{ id: 'last-good' }];
  queryClient.setQueryData(key, lastGood);
  await assert.rejects(queryClient.fetchQuery({ queryKey: key, queryFn: async () => { throw new Error('refresh failed'); } }));
  assert.deepEqual(queryClient.getQueryData(key), lastGood);
});
