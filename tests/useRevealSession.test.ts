import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import type { InventoryItem, PendingOpenBox } from '../src/types.ts';
import type { RevealOverlayState, ViewerOverlayInput } from '../src/shop/reveal/types.ts';
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

function viewerInput(overrides: Partial<ViewerOverlayInput> = {}): ViewerOverlayInput {
  return {
    id: 'receipt-a',
    dropId: 'drop-a',
    name: 'Receipt A',
    originRect: { left: 10, top: 20, width: 30, height: 40 },
    targetRect: { left: 100, top: 100, width: 200, height: 200 },
    viewerMode: 'receipt-image',
    ...overrides,
  };
}

function item(id: string): InventoryItem {
  return { id, dropId: 'drop-a', name: id, kind: 'box' };
}

function pending(id: string): PendingOpenBox {
  return { dropId: 'drop-a', pendingPda: `pending-${id}`, boxAssetId: id, dudeAssetIds: [] };
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

for (const override of [undefined, [item('claimed')], []]) {
  test(`a viewer preserves ${override === undefined ? 'current' : override.length ? 'overridden' : 'empty'} inventory until animated dismissal`, () => {
    const clock = scheduler();
    const initial = options({ inventory: [item('old')], pendingOpenBoxes: [pending('old')] });
    const { result, rerender } = renderHook(useRevealSession, { initialProps: initial });
    act(() => {
      result.current.updateAssetGatedRevealComplete(true);
      result.current.updatePonchoDismissReady(true);
      assert.equal(result.current.presentViewerOverlay(viewerInput(), { inventorySnapshot: override }), true);
    });
    assert.equal(result.current.canDismissAssetGatedRevealOverlay({ revealedIds: [1] }), false);
    assert.equal(result.current.revealDismissLockedUntilRef.current, 0);
    act(() => clock.flushFrame());
    assert.equal(result.current.revealOverlayActive, false);
    act(() => clock.flushFrame());
    assert.equal(result.current.revealOverlayActive, true);
    const next = { ...initial, inventory: [item('new')], pendingOpenBoxes: [pending('new')] };
    rerender(next);
    assert.equal(result.current.inventoryView, override ?? initial.inventory);
    assert.equal(result.current.pendingOpenBoxesView, initial.pendingOpenBoxes);
    let reconciled = 0;
    act(() => {
      result.current.queueOverlayAction(() => { reconciled += 1; });
      result.current.closeRevealOverlay();
    });
    assert.equal(result.current.inventoryView, override ?? initial.inventory);
    assert.equal(reconciled, 0);
    act(() => clock.fireTimer(380));
    assert.equal(result.current.revealOverlay, null);
    assert.equal(result.current.inventoryView, next.inventory);
    assert.equal(result.current.pendingOpenBoxesView, next.pendingOpenBoxes);
    assert.equal(reconciled, 1);
    act(() => result.current.closeRevealOverlay());
    assert.equal(reconciled, 1);
  });
}

test('a suspended viewer attempt returns false without changing dismissal readiness or scheduling presentation', () => {
  const clock = scheduler();
  const sourceElement = document.createElement('button');
  sourceElement.style.setProperty('visibility', 'visible', 'important');
  const initial = options({ suspended: true, inventory: [item('old')], pendingOpenBoxes: [pending('old')] });
  const { result } = renderHook(useRevealSession, { initialProps: initial });
  act(() => {
    result.current.updateAssetGatedRevealComplete(true);
    result.current.updateClearCardDismissReady(true);
    assert.equal(result.current.presentViewerOverlay(viewerInput({ sourceElement }), { inventorySnapshot: [] }), false);
  });
  assert.equal(sourceElement.style.visibility, 'visible');
  assert.equal(sourceElement.style.getPropertyPriority('visibility'), 'important');
  assert.equal(result.current.revealOverlay, null);
  assert.equal(result.current.canDismissAssetGatedRevealOverlay({ revealedIds: [1] }), true);
  assert.equal(result.current.inventoryView, initial.inventory);
  assert.equal(result.current.pendingOpenBoxesView, initial.pendingOpenBoxes);
  assert.equal(clock.frames().size, 0);
  assert.equal(clock.timers.size, 0);
});

for (const completion of ['transition', 'fallback'] as const) {
  test(`a viewer hides its source until closing finishes by ${completion}`, (t) => {
    const clock = scheduler();
    const sourceElement = document.createElement('button');
    document.body.append(sourceElement);
    t.after(() => sourceElement.remove());
    const { result } = renderHook(useRevealSession, { initialProps: options() });
    act(() => {
      assert.equal(result.current.presentViewerOverlay(viewerInput({ sourceElement })), true);
    });
    assert.equal(result.current.revealOverlayActive, false);
    assert.equal(sourceElement.style.visibility, 'hidden');
    act(() => clock.flushFrame());
    assert.equal(sourceElement.style.visibility, 'hidden');
    act(() => clock.flushFrame());
    assert.equal(result.current.revealOverlayActive, true);
    assert.equal(sourceElement.style.visibility, 'hidden');
    act(() => result.current.closeRevealOverlay());
    assert.equal(result.current.revealOverlayClosing, true);
    assert.equal(result.current.revealOverlayCloseMode, 'return');
    assert.equal(sourceElement.style.visibility, 'hidden');
    act(() => {
      if (completion === 'transition') result.current.finalizeRevealOverlayDismissal();
      else clock.fireTimer(380);
    });
    assert.equal(result.current.revealOverlay, null);
    assert.equal(sourceElement.style.getPropertyValue('visibility'), '');
    assert.equal(sourceElement.style.getPropertyPriority('visibility'), '');
    assert.equal(clock.timers.size, 0);
  });
}

for (const reason of ['missing-source', 'identical-geometry'] as const) {
  test(`a viewer fades with ${reason} and leaves its source visible during closing`, (t) => {
    const clock = scheduler();
    const sourceElement = document.createElement('button');
    sourceElement.style.setProperty('visibility', 'visible', 'important');
    document.body.append(sourceElement);
    t.after(() => sourceElement.remove());
    const input = viewerInput({ sourceElement: reason === 'missing-source' ? undefined : sourceElement });
    if (reason === 'identical-geometry') input.originRect = { ...input.targetRect };
    const { result } = renderHook(useRevealSession, { initialProps: options() });
    act(() => result.current.presentViewerOverlay(input));
    assert.equal(sourceElement.style.visibility, reason === 'missing-source' ? 'visible' : 'hidden');
    act(() => clock.flushFrame());
    act(() => clock.flushFrame());
    act(() => result.current.closeRevealOverlay());
    assert.equal(result.current.revealOverlayClosing, true);
    assert.equal(result.current.revealOverlayCloseMode, 'fade');
    assert.notEqual(result.current.revealOverlay, null);
    assert.equal(sourceElement.style.visibility, 'visible');
    assert.equal(sourceElement.style.getPropertyPriority('visibility'), 'important');
    act(() => clock.fireTimer(380));
    assert.equal(result.current.revealOverlay, null);
    assert.equal(sourceElement.style.visibility, 'visible');
    assert.equal(clock.timers.size, 0);
    act(() => result.current.presentViewerOverlay(viewerInput({ sourceElement })));
    assert.equal(result.current.revealOverlayCloseMode, 'return');
    assert.equal(sourceElement.style.visibility, 'hidden');
  });
}

for (const dimension of ['left', 'top', 'width', 'height'] as const) {
  test(`a viewer fades when its connected source ${dimension} changes`, (t) => {
    const clock = scheduler();
    const sourceElement = document.createElement('button');
    let sourceRect = { left: 10, top: 20, width: 30, height: 40 };
    sourceElement.getBoundingClientRect = () => new window.DOMRect(sourceRect.left, sourceRect.top, sourceRect.width, sourceRect.height);
    document.body.append(sourceElement);
    t.after(() => sourceElement.remove());
    const { result } = renderHook(useRevealSession, { initialProps: options() });
    act(() => result.current.presentViewerOverlay(viewerInput({ sourceElement })));
    assert.deepEqual(result.current.revealOverlay?.originSourceRect, sourceRect);
    act(() => clock.flushFrame());
    act(() => clock.flushFrame());
    sourceRect = { ...sourceRect, [dimension]: sourceRect[dimension] + 2 };
    act(() => result.current.closeRevealOverlay());
    assert.equal(sourceElement.isConnected, true);
    assert.equal(result.current.revealOverlayClosing, true);
    assert.equal(result.current.revealOverlayCloseMode, 'fade');
    assert.equal(sourceElement.style.visibility, '');
  });
}

test('a viewer tolerates source bounds rounding within one CSS pixel', (t) => {
  const clock = scheduler();
  const sourceElement = document.createElement('button');
  let sourceRect = new window.DOMRect(10, 20, 30, 40);
  sourceElement.getBoundingClientRect = () => sourceRect;
  document.body.append(sourceElement);
  t.after(() => sourceElement.remove());
  const { result } = renderHook(useRevealSession, { initialProps: options() });
  act(() => result.current.presentViewerOverlay(viewerInput({ sourceElement })));
  act(() => clock.flushFrame());
  act(() => clock.flushFrame());
  sourceRect = new window.DOMRect(10.5, 19.5, 31, 39);
  act(() => result.current.closeRevealOverlay());
  assert.equal(result.current.revealOverlayCloseMode, 'return');
  assert.equal(sourceElement.style.visibility, 'hidden');
});

for (const interruption of ['early-close', 'discard', 'suspension', 'unmount'] as const) {
  test(`${interruption} restores the source visibility without waiting for an animation`, (t) => {
    const clock = scheduler();
    const sourceElement = document.createElement('button');
    sourceElement.style.setProperty('visibility', 'visible', 'important');
    document.body.append(sourceElement);
    t.after(() => sourceElement.remove());
    const initial = options();
    const { result, rerender, unmount } = renderHook(useRevealSession, { initialProps: initial });
    act(() => result.current.presentViewerOverlay(viewerInput({ sourceElement })));
    assert.equal(sourceElement.style.visibility, 'hidden');
    if (interruption !== 'early-close') {
      act(() => clock.flushFrame());
      act(() => clock.flushFrame());
      act(() => result.current.closeRevealOverlay());
      assert.equal(result.current.revealOverlayClosing, true);
      assert.equal(sourceElement.style.visibility, 'hidden');
    }
    if (interruption === 'suspension') rerender({ ...initial, suspended: true });
    else if (interruption === 'unmount') unmount();
    else act(() => {
      if (interruption === 'discard') result.current.discardRevealOverlay();
      else result.current.closeRevealOverlay();
    });
    assert.equal(sourceElement.style.visibility, 'visible');
    assert.equal(sourceElement.style.getPropertyPriority('visibility'), 'important');
    assert.equal(clock.frames().size, 0);
    assert.equal(clock.timers.size, 0);
  });
}

test('replacing a viewer restores its old source and preserves the new source inline visibility', () => {
  scheduler();
  const firstSource = document.createElement('button');
  const secondSource = document.createElement('button');
  secondSource.style.setProperty('visibility', 'collapse');
  const { result } = renderHook(useRevealSession, { initialProps: options() });
  act(() => result.current.presentViewerOverlay(viewerInput({ sourceElement: firstSource })));
  assert.equal(firstSource.style.visibility, 'hidden');
  act(() => result.current.presentViewerOverlay(viewerInput({ id: 'receipt-b', sourceElement: secondSource })));
  assert.equal(firstSource.style.getPropertyValue('visibility'), '');
  assert.equal(secondSource.style.visibility, 'hidden');
  act(() => result.current.dismissRevealOverlay());
  assert.equal(secondSource.style.visibility, 'collapse');
  assert.equal(secondSource.style.getPropertyPriority('visibility'), '');
});

test('transactional presentation preserves its preparing state during the opening request', () => {
  scheduler();
  const { result } = renderHook(useRevealSession, { initialProps: options() });
  const preparing = overlay({ phase: 'preparing', hasRevealAttempted: false });
  act(() => {
    result.current.setStartOpenLoading(preparing.id);
    result.current.presentRevealOverlay(preparing);
  });
  assert.equal(result.current.startOpenLoading, preparing.id);
  assert.equal(result.current.revealOverlay, preparing);
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
