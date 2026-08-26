import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QueryClient } from '@tanstack/react-query';
import { CARD_NFT_2_PACK_BASE_URL } from '../src/config/dropMediaDefaults.ts';
import {
  SHOP_API_MAX_RESPONSE_ITEMS,
  SHOP_INVENTORY_BOX_ID_MAX_UTF8_BYTES,
  SHOP_INVENTORY_NAME_MAX_UTF8_BYTES,
  SHOP_INVENTORY_RAW_IMAGE_MAX_UTF8_BYTES,
  SHOP_PENDING_OPEN_MAX_DUDE_ASSET_IDS,
  isExactShopInventoryResponse,
  isExactShopPendingOpenBoxesResponse,
} from '../shared/shopApi.ts';
import { fetchInventory, fetchPackStatus, fetchPendingOpenBoxes } from '../src/lib/shopApi.ts';
import { rpcEndpointForCluster, SHOP_SOLANA_CONNECTION_CONFIG } from '../src/lib/shopRpc.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
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

test('pack-status frontend facade has no direct Commerce fallback', () => {
  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function getDropPackStatus');
  const end = source.indexOf('export async function listFulfillmentOrders', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const implementation = source.slice(start, end);
  assert.match(implementation, /fetchPackStatus\(normalizedDropId\)/);
  assert.doesNotMatch(implementation, /auth\/commerce|getCommerce|getDoc/);
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
