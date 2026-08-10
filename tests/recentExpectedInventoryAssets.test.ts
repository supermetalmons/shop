import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { QueryClient, isCancelledError } from '@tanstack/react-query';
import {
  loadInventoryQuery,
  refetchInventoryWithLatestExpectedAssets,
} from '../src/lib/inventoryQuery.ts';
import {
  RECENT_EXPECTED_INVENTORY_ASSET_MAX_ENTRIES,
  RECENT_EXPECTED_INVENTORY_ASSET_TTL_MS,
  prepareRecentExpectedInventoryAssets,
  reconcileRecentExpectedInventoryAssets,
  reconcileRecentExpectedInventoryAssetsInState,
  registerRecentExpectedInventoryAssets,
  registerRecentExpectedInventoryAssetsInState,
  shouldUseRecentExpectedInventoryAssets,
  takeRecentExpectedInventoryAssets,
  takeRecentExpectedInventoryAssetsFromState,
  type RecentExpectedInventoryAssetState,
  type SessionStorageLike,
} from '../src/lib/recentExpectedInventoryAssets.ts';

const OWNER_A = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const OWNER_B = '11111111111111111111111111111111';

class MemoryStorage implements SessionStorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function assetId(index: number): string {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(28, index + 1, false);
  return bs58.encode(bytes);
}

function emptyState(): RecentExpectedInventoryAssetState {
  return { cursor: 0, entries: [] };
}

function flattenedIds(expected: { 'mainnet-beta'?: string[]; devnet?: string[] } | undefined): string[] {
  return [...(expected?.['mainnet-beta'] ?? []), ...(expected?.devnet ?? [])];
}

test('recent expected assets are capped, newest-first, and rotate in request-sized batches', () => {
  const now = 1_000_000;
  const registered = registerRecentExpectedInventoryAssetsInState(
    emptyState(),
    'mainnet-beta',
    Array.from({ length: 70 }, (_, index) => assetId(index)),
    now,
  );
  assert.equal(registered.entries.length, RECENT_EXPECTED_INVENTORY_ASSET_MAX_ENTRIES);

  const batches: string[][] = [];
  let state = registered;
  for (let index = 0; index < 5; index += 1) {
    const result = takeRecentExpectedInventoryAssetsFromState(state, false, now);
    state = result.state;
    batches.push(flattenedIds(result.expectedAssetIds));
  }
  assert.deepEqual(batches.map((batch) => batch.length), [15, 15, 15, 15, 15]);
  assert.deepEqual(batches[0], Array.from({ length: 15 }, (_, index) => assetId(index)));
  assert.deepEqual(batches[3], Array.from({ length: 15 }, (_, index) => assetId(index + 45)));
  assert.deepEqual(batches[4], batches[0]);
});

test('registration resets rotation so an immediate refetch receives the newest asset IDs', () => {
  const now = 2_000_000;
  let state = registerRecentExpectedInventoryAssetsInState(
    emptyState(),
    'mainnet-beta',
    Array.from({ length: 30 }, (_, index) => assetId(index)),
    now,
  );
  state = takeRecentExpectedInventoryAssetsFromState(state, false, now).state;
  const newest = assetId(100);
  state = registerRecentExpectedInventoryAssetsInState(state, 'mainnet-beta', [newest], now + 1);
  const immediate = takeRecentExpectedInventoryAssetsFromState(state, false, now + 1);
  assert.equal(immediate.expectedAssetIds?.['mainnet-beta']?.[0], newest);
});

test('expired and recovered expected assets are removed without crossing owner or cluster scope', () => {
  const storage = new MemoryStorage();
  const now = 3_000_000;
  const mainnetId = assetId(200);
  const recoveredId = assetId(201);
  const devnetId = assetId(202);
  registerRecentExpectedInventoryAssets(OWNER_A, 'mainnet-beta', [mainnetId, recoveredId], { storage, now });
  registerRecentExpectedInventoryAssets(OWNER_A, 'devnet', [devnetId], { storage, now: now + 1 });
  registerRecentExpectedInventoryAssets(OWNER_B, 'mainnet-beta', [assetId(203)], { storage, now });

  assert.deepEqual(takeRecentExpectedInventoryAssets(OWNER_A, false, { storage, now: now + 2 }), {
    'mainnet-beta': [mainnetId, recoveredId],
  });
  reconcileRecentExpectedInventoryAssets(OWNER_A, [recoveredId], { storage, now: now + 3 });
  assert.deepEqual(takeRecentExpectedInventoryAssets(OWNER_A, true, { storage, now: now + 4 }), {
    devnet: [devnetId],
    'mainnet-beta': [mainnetId],
  });
  assert.deepEqual(takeRecentExpectedInventoryAssets(OWNER_B, false, { storage, now: now + 4 }), {
    'mainnet-beta': [assetId(203)],
  });
  assert.equal(
    takeRecentExpectedInventoryAssets(OWNER_A, true, {
      storage,
      now: now + RECENT_EXPECTED_INVENTORY_ASSET_TTL_MS + 1,
    }),
    undefined,
  );
});

test('pure reconciliation prunes recovered IDs and TTL-expired entries', () => {
  const now = 4_000_000;
  const recovered = assetId(300);
  const retained = assetId(301);
  const state: RecentExpectedInventoryAssetState = {
    cursor: 1,
    entries: [
      { assetId: recovered, cluster: 'mainnet-beta', registeredAt: now - 1 },
      { assetId: retained, cluster: 'devnet', registeredAt: now - 2 },
      {
        assetId: assetId(302),
        cluster: 'mainnet-beta',
        registeredAt: now - RECENT_EXPECTED_INVENTORY_ASSET_TTL_MS,
      },
    ],
  };
  assert.deepEqual(
    reconcileRecentExpectedInventoryAssetsInState(state, new Set([recovered]), now),
    { cursor: 0, entries: [{ assetId: retained, cluster: 'devnet', registeredAt: now - 2 }] },
  );
});

test('partial reconciliation keeps the next unvisited batch position', () => {
  const now = 4_100_000;
  const ids = Array.from({ length: 30 }, (_, index) => assetId(index + 600));
  const registered = registerRecentExpectedInventoryAssetsInState(
    emptyState(),
    'mainnet-beta',
    ids,
    now,
  );
  const first = takeRecentExpectedInventoryAssetsFromState(registered, false, now);
  assert.deepEqual(first.expectedAssetIds?.['mainnet-beta'], ids.slice(0, 15));

  const reconciled = reconcileRecentExpectedInventoryAssetsInState(
    first.state,
    new Set([ids[0], ids[5]]),
    now,
  );
  const second = takeRecentExpectedInventoryAssetsFromState(reconciled, false, now);
  assert.deepEqual(second.expectedAssetIds?.['mainnet-beta'], ids.slice(15));
});

test('rotation cursor keeps its full-list meaning when devnet visibility changes', () => {
  const now = 4_200_000;
  const entries = Array.from({ length: 40 }, (_, index) => ({
    assetId: assetId(index + 700),
    cluster: index % 2 === 0 ? ('mainnet-beta' as const) : ('devnet' as const),
    registeredAt: now - index,
  }));
  const mainnetOnly = takeRecentExpectedInventoryAssetsFromState({ cursor: 0, entries }, false, now);
  assert.deepEqual(
    mainnetOnly.expectedAssetIds?.['mainnet-beta'],
    entries.filter((entry) => entry.cluster === 'mainnet-beta').slice(0, 15).map((entry) => entry.assetId),
  );
  assert.equal(mainnetOnly.state.cursor, 29);

  const withDevnet = takeRecentExpectedInventoryAssetsFromState(mainnetOnly.state, true, now);
  const wrappedEntries = [...entries.slice(29), ...entries.slice(0, 4)];
  assert.deepEqual(
    withDevnet.expectedAssetIds?.devnet,
    wrappedEntries.filter((entry) => entry.cluster === 'devnet').map((entry) => entry.assetId),
  );
  assert.deepEqual(
    withDevnet.expectedAssetIds?.['mainnet-beta'],
    wrappedEntries.filter((entry) => entry.cluster === 'mainnet-beta').map((entry) => entry.assetId),
  );
  assert.equal(flattenedIds(withDevnet.expectedAssetIds).length, 15);
  assert.equal(withDevnet.state.cursor, 4);

  const seenDevnetIds = new Set(withDevnet.expectedAssetIds?.devnet ?? []);
  let state = withDevnet.state;
  for (let iteration = 0; iteration < entries.length; iteration += 1) {
    state = takeRecentExpectedInventoryAssetsFromState(state, false, now).state;
    const result = takeRecentExpectedInventoryAssetsFromState(state, true, now);
    for (const id of result.expectedAssetIds?.devnet ?? []) seenDevnetIds.add(id);
    state = result.state;
  }
  assert.deepEqual(
    entries.filter((entry) => entry.cluster === 'devnet').map((entry) => entry.assetId).every((id) => seenDevnetIds.has(id)),
    true,
  );
});

test('TTL trimming an oldest suffix wraps an out-of-range cursor to the start', () => {
  const now = 4_300_000;
  const freshIds = Array.from({ length: 10 }, (_, index) => assetId(index + 800));
  const expiredIds = Array.from({ length: 10 }, (_, index) => assetId(index + 900));
  const state: RecentExpectedInventoryAssetState = {
    cursor: 15,
    entries: [
      ...freshIds.map((id, index) => ({
        assetId: id,
        cluster: 'mainnet-beta' as const,
        registeredAt: now - index,
      })),
      ...expiredIds.map((id) => ({
        assetId: id,
        cluster: 'mainnet-beta' as const,
        registeredAt: now - RECENT_EXPECTED_INVENTORY_ASSET_TTL_MS,
      })),
    ],
  };

  const result = takeRecentExpectedInventoryAssetsFromState(state, false, now);
  assert.deepEqual(result.expectedAssetIds?.['mainnet-beta'], freshIds);
  assert.equal(result.state.cursor, 0);
});

test('invalid registered or persisted IDs never enter an expected-asset request', () => {
  const now = 4_500_000;
  const registered = registerRecentExpectedInventoryAssetsInState(
    emptyState(),
    'mainnet-beta',
    ['not-an-asset-id'],
    now,
  );
  assert.deepEqual(registered, emptyState());
  const persisted: RecentExpectedInventoryAssetState = {
    cursor: 0,
    entries: [{ assetId: 'also-invalid', cluster: 'devnet', registeredAt: now }],
  };
  assert.equal(
    takeRecentExpectedInventoryAssetsFromState(persisted, true, now).expectedAssetIds,
    undefined,
  );
});

test('inventory query reads registered hints synchronously and reconciles a successful response', async () => {
  const storage = new MemoryStorage();
  const now = 5_000_000;
  const expectedId = assetId(400);
  registerRecentExpectedInventoryAssets(OWNER_A, 'mainnet-beta', [expectedId], { storage, now });
  const events: string[] = [];

  const items = await loadInventoryQuery(
    OWNER_A,
    { includeDevnet: false, useRecentExpectedAssets: true },
    {
      prepare: (owner, includeDevnet) => {
        events.push('prepare');
        const selection = prepareRecentExpectedInventoryAssets(owner, includeDevnet, { storage, now });
        return {
          ...selection,
          commit: () => {
            events.push('commit');
            selection.commit();
          },
        };
      },
      fetchInventory: async (owner, options) => {
        events.push('fetch');
        assert.equal(owner, OWNER_A);
        assert.deepEqual(options.expectedAssetIds, { 'mainnet-beta': [expectedId] });
        return [{ id: expectedId, dropId: 'card_nft_2', name: 'pack 1', kind: 'box' }];
      },
      reconcile: (owner, recoveredIds) => {
        events.push('reconcile');
        reconcileRecentExpectedInventoryAssets(owner, recoveredIds, { storage, now });
      },
    },
  );
  assert.deepEqual(events, ['prepare', 'fetch', 'commit', 'reconcile']);
  assert.deepEqual(items.map((item) => item.id), [expectedId]);
  assert.equal(takeRecentExpectedInventoryAssets(OWNER_A, false, { storage, now }), undefined);
});

test('inventory query preserves the selected hint batch when its request fails', async () => {
  const storage = new MemoryStorage();
  const now = 5_100_000;
  const expectedIds = Array.from({ length: 30 }, (_, index) => assetId(index + 450));
  registerRecentExpectedInventoryAssets(OWNER_A, 'mainnet-beta', expectedIds, { storage, now });

  await assert.rejects(
    () => loadInventoryQuery(
      OWNER_A,
      { includeDevnet: false, useRecentExpectedAssets: true },
      {
        prepare: (owner, includeDevnet) =>
          prepareRecentExpectedInventoryAssets(owner, includeDevnet, { storage, now }),
        fetchInventory: async (_owner, options) => {
          assert.deepEqual(options.expectedAssetIds, { 'mainnet-beta': expectedIds.slice(0, 15) });
          throw new Error('injected inventory failure');
        },
        reconcile: () => assert.fail('failed inventory request reconciled hint storage'),
      },
    ),
    /injected inventory failure/,
  );

  const retry = prepareRecentExpectedInventoryAssets(OWNER_A, false, { storage, now });
  assert.deepEqual(retry.expectedAssetIds, { 'mainnet-beta': expectedIds.slice(0, 15) });
  retry.commit();
  assert.deepEqual(
    prepareRecentExpectedInventoryAssets(OWNER_A, false, { storage, now }).expectedAssetIds,
    { 'mainnet-beta': expectedIds.slice(15) },
  );
});

test('older successful selections do not advance past a concurrent registration', () => {
  const storage = new MemoryStorage();
  const now = 5_200_000;
  const existingIds = Array.from({ length: 30 }, (_, index) => assetId(index + 500));
  const newestId = assetId(600);
  registerRecentExpectedInventoryAssets(OWNER_A, 'mainnet-beta', existingIds, { storage, now });
  const olderSelection = prepareRecentExpectedInventoryAssets(OWNER_A, false, { storage, now });
  registerRecentExpectedInventoryAssets(OWNER_A, 'mainnet-beta', [newestId], { storage, now: now + 1 });
  olderSelection.commit(now + 1);
  assert.equal(
    prepareRecentExpectedInventoryAssets(OWNER_A, false, { storage, now: now + 1 })
      .expectedAssetIds?.['mainnet-beta']?.[0],
    newestId,
  );
});

test('post-registration refresh cancels a hintless in-flight query before refetching', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = ['inventory', OWNER_A, false] as const;
  let registered = false;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const observations: boolean[] = [];
  const initial = queryClient.fetchQuery({
    queryKey,
    queryFn: ({ signal }) => new Promise<never>((_resolve, reject) => {
      observations.push(registered);
      started();
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
  });
  const initialOutcome = initial.catch((error) => error);
  await startedPromise;
  registered = true;

  const refreshed = await refetchInventoryWithLatestExpectedAssets(
    queryClient,
    queryKey,
    () => queryClient.fetchQuery({
      queryKey,
      queryFn: async () => {
        observations.push(registered);
        return ['fresh'];
      },
    }),
  );

  assert.deepEqual(refreshed, ['fresh']);
  assert.deepEqual(observations, [false, true]);
  assert.equal(isCancelledError(await initialOutcome), true);
});

test('recent expected assets are used only for the connected owner, never a viewed owner', () => {
  assert.equal(shouldUseRecentExpectedInventoryAssets(OWNER_A, OWNER_A), true);
  assert.equal(shouldUseRecentExpectedInventoryAssets(OWNER_B, OWNER_A), false);
  assert.equal(shouldUseRecentExpectedInventoryAssets(OWNER_A, undefined), false);
});

test('viewer-mode inventory loading neither reads nor reconciles owner hint storage', async () => {
  let hintCalls = 0;
  await loadInventoryQuery(
    OWNER_B,
    { includeDevnet: false, useRecentExpectedAssets: false },
    {
      prepare: () => {
        hintCalls += 1;
        return {
          commit: () => {
            hintCalls += 1;
          },
          expectedAssetIds: { 'mainnet-beta': [assetId(500)] },
        };
      },
      fetchInventory: async (_owner, options) => {
        assert.equal(options.expectedAssetIds, undefined);
        return [];
      },
      reconcile: () => {
        hintCalls += 1;
      },
    },
  );
  assert.equal(hintCalls, 0);
});
