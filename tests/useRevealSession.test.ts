import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import type { InventoryItem, PendingOpenBox } from '../src/types.ts';
import type { RevealOverlayState } from '../src/shop/reveal/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

setupFrontendDom();

const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useRevealSession } = await import('../src/shop/reveal/useRevealSession.ts');

type Options = Parameters<typeof useRevealSession>[0];

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

function options(overrides: Partial<Options> = {}): Options {
  return {
    connectedWallet: 'wallet-a',
    owner: 'wallet-a',
    localAccountWallet: 'wallet-a',
    suspended: false,
    walletModalVisible: false,
    receiptTransferOpen: false,
    inventory: [],
    pendingOpenBoxes: [],
    assets: {
      usesClearCard3dRevealForDropId: () => false,
      usesAssetGatedRevealForDropId: () => false,
      dropRevealIsAnimated: () => false,
      revealFrameCountForDropId: () => 10,
      revealMediaStartForDropId: () => 7,
      revealRendererForDropId: () => undefined,
      boxAspectRatioForDropId: () => 1,
      clearRevealVideos: () => undefined,
      resetRevealAssets: () => undefined,
    },
    ...overrides,
  };
}

function overlay(overrides: Partial<RevealOverlayState> = {}): RevealOverlayState {
  return {
    id: 'box-a',
    dropId: 'drop-a',
    name: 'Box A',
    originRect: { left: 10, top: 20, width: 30, height: 40 },
    targetRect: { left: 100, top: 100, width: 200, height: 200 },
    phase: 'ready',
    frame: 1,
    advanceClicks: 0,
    ...overrides,
  };
}

function item(id: string): InventoryItem {
  return { id, dropId: 'drop-a', name: id, kind: 'box' };
}

function pending(id: string): PendingOpenBox {
  return { boxAssetId: id, dropId: 'drop-a', owner: 'wallet-a' } as PendingOpenBox;
}

function scheduler() {
  let nextId = 0;
  let frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = ++nextId;
    frames.set(id, callback);
    return id;
  };
  const cancelFrame = (id: number) => { frames.delete(id); };
  const setTimer = (callback: TimerHandler, delay = 0) => {
    assert.equal(typeof callback, 'function');
    const id = ++nextId;
    timers.set(id, { callback: callback as () => void, delay });
    return id;
  };
  const clearTimer = (id: number | undefined) => { if (id !== undefined) timers.delete(id); };
  mock.method(globalThis, 'requestAnimationFrame', requestFrame);
  mock.method(globalThis, 'cancelAnimationFrame', cancelFrame);
  mock.method(window, 'requestAnimationFrame', requestFrame);
  mock.method(window, 'cancelAnimationFrame', cancelFrame);
  mock.method(window, 'setTimeout', setTimer);
  mock.method(window, 'clearTimeout', clearTimer);
  mock.method(globalThis, 'clearTimeout', clearTimer);
  return {
    frames: () => frames,
    timers,
    flushFrame() {
      const pending = frames;
      frames = new Map();
      pending.forEach((callback) => callback(0));
    },
    fireTimer(delay: number) {
      const entry = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(entry, `Missing timer with delay ${delay}`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

test('a reveal holds both inventory snapshots until dismissal and flushes queued work once', () => {
  scheduler();
  const initialInventory = [item('old')];
  const initialPending = [pending('old')];
  const initial = options({ inventory: initialInventory, pendingOpenBoxes: initialPending });
  const { result, rerender } = renderHook(useRevealSession, { initialProps: initial });
  act(() => {
    result.current.setInventorySnapshot(initialInventory);
    result.current.setPendingOpenSnapshot(initialPending);
    result.current.presentRevealOverlay(overlay());
  });
  const nextInventory = [item('new')];
  const nextPending = [pending('new')];
  rerender({ ...initial, inventory: nextInventory, pendingOpenBoxes: nextPending });
  const calls: string[] = [];
  act(() => {
    result.current.queueOverlayAction(() => calls.push('reconcile'));
    result.current.queueOverlayAction(() => calls.push('presentation'), 'presentation');
  });
  assert.equal(result.current.inventoryView, initialInventory);
  assert.equal(result.current.pendingOpenBoxesView, initialPending);
  assert.deepEqual(calls, []);
  act(() => result.current.closeRevealOverlay());
  assert.equal(result.current.revealOverlay, null);
  assert.equal(result.current.inventoryView, nextInventory);
  assert.equal(result.current.pendingOpenBoxesView, nextPending);
  assert.deepEqual(calls, ['reconcile', 'presentation']);
  act(() => result.current.closeRevealOverlay());
  assert.deepEqual(calls, ['reconcile', 'presentation']);
});

test('suspension reconciles data immediately and defers presentation until the feature resumes', () => {
  scheduler();
  const initial = options();
  const { result, rerender } = renderHook(useRevealSession, { initialProps: initial });
  const calls: string[] = [];
  act(() => {
    result.current.presentRevealOverlay(overlay());
    result.current.queueOverlayAction(() => calls.push('presentation'), 'presentation');
    result.current.queueOverlayAction(() => calls.push('reconcile'));
  });
  rerender({ ...initial, suspended: true });
  assert.equal(result.current.revealOverlay, null);
  assert.deepEqual(calls, ['reconcile']);
  rerender(initial);
  assert.deepEqual(calls, ['reconcile', 'presentation']);
});

test('a wallet change aborts the previous reveal session and discards its deferred actions', () => {
  scheduler();
  const initial = options();
  const { result, rerender } = renderHook(useRevealSession, { initialProps: initial });
  const request = new AbortController();
  const requestSession = result.current.revealOverlaySessionRef.current;
  const calls: string[] = [];
  act(() => {
    result.current.presentRevealOverlay(overlay());
    result.current.revealSubmissionReconciliationAbortControllerRef.current = request;
    result.current.revealLoadingRequestIdRef.current = 5;
    result.current.setRevealLoading('box-a');
    result.current.queueOverlayAction(() => calls.push('reconcile'));
    result.current.queueOverlayAction(() => calls.push('presentation'), 'presentation');
  });
  rerender({ ...initial, connectedWallet: 'wallet-b', owner: 'wallet-b', localAccountWallet: 'wallet-b' });
  assert.equal(request.signal.aborted, true);
  assert.ok(result.current.revealOverlaySessionRef.current > requestSession);
  assert.equal(result.current.connectedWalletRef.current, 'wallet-b');
  assert.equal(result.current.revealLoadingRequestIdRef.current, null);
  assert.equal(result.current.revealLoading, null);
  assert.equal(result.current.revealOverlay, null);
  assert.deepEqual(calls, []);
});

test('presentation queued during an opening request waits until loading clears', () => {
  scheduler();
  const { result } = renderHook(useRevealSession, { initialProps: options() });
  const calls: string[] = [];
  act(() => result.current.setStartOpenLoading('box-a'));
  act(() => {
    result.current.queueOverlayAction(() => calls.push('presentation'), 'presentation');
    result.current.queueOverlayAction(() => calls.push('reconcile'));
  });
  assert.deepEqual(calls, ['reconcile']);
  act(() => result.current.setStartOpenLoading(null));
  assert.deepEqual(calls, ['reconcile', 'presentation']);
});

test('animated closing keeps snapshots until its fallback completes and releases them once', () => {
  const clock = scheduler();
  const { result } = renderHook(useRevealSession, { initialProps: options() });
  const calls: string[] = [];
  act(() => result.current.presentRevealOverlay(overlay()));
  act(() => clock.flushFrame());
  assert.equal(result.current.revealOverlayActive, false);
  act(() => clock.flushFrame());
  assert.equal(result.current.revealOverlayActive, true);
  act(() => {
    result.current.queueOverlayAction(() => calls.push('reconciled'));
    result.current.closeRevealOverlay();
  });
  assert.equal(result.current.revealOverlayClosing, true);
  assert.notEqual(result.current.revealOverlay, null);
  assert.deepEqual(calls, []);
  act(() => clock.fireTimer(380));
  assert.equal(result.current.revealOverlay, null);
  assert.deepEqual(calls, ['reconciled']);
});

test('unmount cancels reveal frames, resize work, closing fallback, and request reconciliation', () => {
  const clock = scheduler();
  const { result, unmount } = renderHook(useRevealSession, { initialProps: options() });
  act(() => result.current.presentRevealOverlay(overlay()));
  act(() => clock.flushFrame());
  act(() => clock.flushFrame());
  const request = new AbortController();
  act(() => {
    result.current.revealSubmissionReconciliationAbortControllerRef.current = request;
    window.dispatchEvent(new window.Event('resize'));
    result.current.closeRevealOverlay();
  });
  const revealFrames = [...clock.frames().keys()];
  const closeTimer = [...clock.timers.keys()];
  assert.ok(revealFrames.length > 0);
  assert.ok(closeTimer.length > 0);
  unmount();
  assert.equal(request.signal.aborted, true);
  assert.ok(revealFrames.every((id) => !clock.frames().has(id)));
  assert.ok(closeTimer.every((id) => !clock.timers.has(id)));
});
