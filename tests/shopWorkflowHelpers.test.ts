import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCOUNT_USED_STORAGE_PREFIX,
  discountUsedKey,
  discountUsedScope,
  discountUsedVersion,
  hiddenInventoryKey,
  loadDiscountUsedCount,
  loadHiddenAssets,
  loadPendingReveals,
  loadRecentReveals,
  pendingRevealKey,
  persistDiscountUsedCount,
  persistHiddenAssets,
  persistPendingReveals,
  persistRecentReveals,
  recentRevealKey,
  type ShopStorage,
} from '../src/shop/persistedState.ts';
import {
  POST_ACTION_INVENTORY_POLL_INTERVAL_MS,
  startPostActionInventoryPolling,
} from '../src/shop/postActionPolling.ts';
import {
  applyRevealRequestRetry,
  requestRevealWithSubmissionRecovery,
  resolveRevealOverlayPhaseAfterReveal,
} from '../src/shop/reveal.ts';
import {
  persistPreparedReservationOrThrow,
  withBrowserLock,
  type BrowserLockManager,
} from '../src/shop/preparedSubmission.ts';

function memoryStorage(initial: Record<string, string> = {}): ShopStorage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    key: (index) => [...values.keys()][index] ?? null,
  };
}

test('shop persistence preserves wallet-scoped keys and malformed-data fallbacks', () => {
  const storage = memoryStorage();
  assert.equal(hiddenInventoryKey('wallet'), 'monsHiddenAssets:wallet');
  assert.equal(pendingRevealKey('wallet'), 'monsPendingReveals:wallet');
  assert.equal(recentRevealKey('wallet'), 'monsRecentReveals:wallet');

  persistHiddenAssets('wallet', new Set(['asset-a', 'asset-b']), storage);
  persistPendingReveals('wallet', [{
    id: 'box-a',
    createdAt: 123,
    dropId: 'card_nft_2',
    name: 'Pack',
    image: 'pack.webp',
    boxId: '7',
  }], storage);
  persistRecentReveals('wallet', ['box-a', 'box-b'], storage);

  assert.deepEqual([...loadHiddenAssets('wallet', storage)], ['asset-a', 'asset-b']);
  assert.deepEqual(loadPendingReveals('wallet', storage), [{
    id: 'box-a',
    createdAt: 123,
    dropId: 'card_nft_2',
    name: 'Pack',
    image: 'pack.webp',
    boxId: '7',
  }]);
  assert.deepEqual(loadRecentReveals('wallet', storage), ['box-a', 'box-b']);
  assert.deepEqual(loadHiddenAssets(undefined, storage), new Set());
  assert.deepEqual(loadPendingReveals(undefined, storage), []);
  assert.deepEqual(loadRecentReveals(undefined, storage), []);

  const malformed = memoryStorage({
    [hiddenInventoryKey('wallet')]: '{bad',
    [pendingRevealKey('wallet')]: JSON.stringify([
      null,
      { id: '', createdAt: 1 },
      { id: 'valid', createdAt: 2, dropId: 7, name: 'name', extra: true },
    ]),
    [recentRevealKey('wallet')]: JSON.stringify(['valid', '', 7]),
  });
  assert.deepEqual(loadHiddenAssets('wallet', malformed), new Set());
  assert.deepEqual(loadPendingReveals('wallet', malformed), [{
    id: 'valid',
    createdAt: 2,
    dropId: undefined,
    name: 'name',
    image: undefined,
    boxId: undefined,
  }]);
  assert.deepEqual(loadRecentReveals('wallet', malformed), ['valid']);
});

test('discount persistence removes stale versions only within the same wallet scope', () => {
  const drop = {
    dropId: ' CARD_NFT_2 ',
    boxMinterProgramId: 'program',
    discountMerkleRoot: 'root',
    discountMintsPerWallet: 2,
  };
  const version = discountUsedVersion(drop);
  const scope = discountUsedScope(drop);
  const keepKey = discountUsedKey(version, 'wallet-a');
  const staleKey = `${scope}:stale:wallet-a`;
  const otherWalletKey = `${scope}:stale:wallet-b`;
  const otherScopeKey = `${DISCOUNT_USED_STORAGE_PREFIX}:other:stale:wallet-a`;
  const storage = memoryStorage({
    [staleKey]: '4',
    [otherWalletKey]: '5',
    [otherScopeKey]: '6',
  });

  persistDiscountUsedCount(scope, version, 'wallet-a', 3.9, storage);
  assert.equal(loadDiscountUsedCount(scope, version, 'wallet-a', storage), 3);
  assert.equal(storage.getItem(keepKey), '3.9');
  assert.equal(storage.getItem(staleKey), null);
  assert.equal(storage.getItem(otherWalletKey), '5');
  assert.equal(storage.getItem(otherScopeKey), '6');

  persistDiscountUsedCount(scope, version, 'wallet-a', 0, storage);
  assert.equal(storage.getItem(keepKey), null);
  assert.equal(loadDiscountUsedCount(scope, version, 'wallet-a', null), 0);
});

test('post-action inventory polling never cancels an in-flight refresh', () => {
  const calls: Array<{ cancelRefetch: false }> = [];
  let scheduled: (() => void) | null = null;
  let delay = 0;
  let cleared: unknown;
  const stop = startPostActionInventoryPolling(
    (options) => {
      calls.push(options);
    },
    {
      setInterval: (run, delayMs) => {
        scheduled = run;
        delay = delayMs;
        return 'poll';
      },
      clearInterval: (timer) => {
        cleared = timer;
      },
    },
  );

  assert.deepEqual(calls, [{ cancelRefetch: false }]);
  assert.equal(delay, POST_ACTION_INVENTORY_POLL_INTERVAL_MS);
  scheduled?.();
  assert.deepEqual(calls, [
    { cancelRefetch: false },
    { cancelRefetch: false },
  ]);
  stop();
  scheduled?.();
  assert.equal(calls.length, 2);
  assert.equal(cleared, 'poll');
});

test('reveal ambiguity recovery observes confirmation before acknowledgement', async () => {
  const events: string[] = [];
  const originalError = new Error('submission unknown');
  const controller = new AbortController();
  let requests = 0;
  const result = await requestRevealWithSubmissionRecovery({
    request: async () => {
      requests += 1;
      events.push(`request:${requests}`);
      if (requests === 1) throw originalError;
      return { signature: 'acknowledged', dudeIds: [1, 2, 3] };
    },
    recoveryDetails: (error) => error === originalError
      ? { submission: { signature: 'submitted', recentBlockhash: 'blockhash', dudeIds: [1, 2, 3] } }
      : null,
    reconcile: async (submission, options) => {
      events.push('reconcile');
      assert.equal(submission.signature, 'submitted');
      assert.deepEqual({
        detectExpiry: options.detectExpiry,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      }, {
        detectExpiry: false,
        timeoutMs: 75_000,
        signal: controller.signal,
      });
      return 'confirmed';
    },
    isCurrent: () => true,
    signal: controller.signal,
  });

  assert.deepEqual(result, {
    status: 'success',
    response: { signature: 'acknowledged', dudeIds: [1, 2, 3] },
  });
  assert.deepEqual(events, ['request:1', 'reconcile', 'request:2']);
});

test('reveal recovery never acknowledges unresolved or stale submissions', async () => {
  const originalError = new Error('submission unknown');
  let requests = 0;
  await assert.rejects(
    requestRevealWithSubmissionRecovery({
      request: async () => {
        requests += 1;
        throw originalError;
      },
      recoveryDetails: () => ({ submission: 'submitted' }),
      reconcile: async () => 'unknown',
      isCurrent: () => true,
      signal: new AbortController().signal,
    }),
    (error) => error === originalError,
  );
  assert.equal(requests, 1);

  let current = true;
  const stale = await requestRevealWithSubmissionRecovery({
    request: async () => {
      current = false;
      return { dudeIds: [1] };
    },
    recoveryDetails: () => null,
    reconcile: async () => 'confirmed',
    isCurrent: () => current,
    signal: new AbortController().signal,
  });
  assert.deepEqual(stale, { status: 'stale' });
});

test('reveal retry resets only the matching unresolved ready overlay session', () => {
  const overlay = {
    id: 'box',
    dropId: 'card_nft_2',
    phase: 'ready' as const,
    revealedIds: [] as number[],
    hasRevealAttempted: true,
    frame: 2,
  };
  const args = {
    status: 'retry' as const,
    requestSession: 4,
    currentSession: 4,
    boxAssetId: 'box',
    dropId: 'card_nft_2',
  };
  assert.deepEqual(applyRevealRequestRetry(overlay, args), {
    ...overlay,
    hasRevealAttempted: false,
  });
  assert.equal(applyRevealRequestRetry(overlay, { ...args, currentSession: 5 }), overlay);
  const revealed = { ...overlay, phase: 'revealed' as const };
  const resolved = { ...overlay, revealedIds: [1] };
  assert.equal(applyRevealRequestRetry(revealed, args), revealed);
  assert.equal(applyRevealRequestRetry(resolved, args), resolved);
  assert.equal(applyRevealRequestRetry(overlay, { ...args, status: 'resolved' }), overlay);

  assert.equal(resolveRevealOverlayPhaseAfterReveal({
    currentPhase: 'ready',
    revealMode: 'static',
    usesAssetGatedFlow: false,
    frame: 0,
    mediaStart: 1,
    hasResults: true,
  }), 'revealed');
  assert.equal(resolveRevealOverlayPhaseAfterReveal({
    currentPhase: 'ready',
    revealMode: 'animated',
    usesAssetGatedFlow: true,
    frame: 10,
    mediaStart: 1,
    hasResults: true,
  }), 'ready');
});

test('prepared submission helpers require durable persistence and an available exclusive lock', async () => {
  const events: string[] = [];
  const reservation = { operationId: 'reservation' };
  persistPreparedReservationOrThrow(
    reservation,
    (entry) => {
      events.push(`persist:${entry.operationId}`);
      return true;
    },
    'Unable to save reservation',
  );
  events.push('sign');
  assert.deepEqual(events, ['persist:reservation', 'sign']);
  assert.throws(
    () => persistPreparedReservationOrThrow(reservation, () => false, 'Unable to save reservation'),
    /Unable to save reservation/,
  );

  await assert.rejects(
    withBrowserLock('wallet', async () => undefined, null),
    /cannot safely coordinate wallet transactions/,
  );
  const held = {
    request: async (_name, options, callback) => {
      assert.deepEqual(options, { ifAvailable: true });
      return callback(null);
    },
  } as BrowserLockManager;
  await assert.rejects(
    withBrowserLock('wallet', async () => undefined, held),
    /Another wallet transaction is already in progress/,
  );
  const available = {
    request: async (name, options, callback) => {
      assert.equal(name, 'wallet');
      assert.deepEqual(options, { ifAvailable: true });
      return callback({});
    },
  } as BrowserLockManager;
  assert.equal(await withBrowserLock('wallet', async () => 'submitted', available), 'submitted');
});
