import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceClearCardGatedHit,
  beginClearCardRevealRequest,
  canStartClearCardPointerInteraction,
  createClearCardGatedHitState,
  createClearCardRevealRequestState,
  isClearCardFallbackImagePoint,
  isClearCardFreeMovementEnabled,
  isClearCardInteractionPoint,
  isClearCardImpactKey,
  isClearCardImpactPointer,
  settleClearCardRevealRequest,
  shouldProtectClearCardOverlayClick,
} from '../src/lib/clearCardReveal.ts';
import {
  CLEAR_CARD_MODEL_COUNT,
  clearCardModelLoadDecision,
  clearCardModelIdFromRevealResult,
  clearCardModelUrl,
} from '../src/lib/clearCardModels.ts';
import {
  CLEAR_CARDS_CARD_MODEL_BASE_URL,
  CLEAR_CARDS_PACK_PREVIEW_ASPECT_RATIO,
} from '../src/config/dropMediaDefaults.ts';
import {
  calcClearCardRevealTargetRect,
  calcContainedMediaRevealOriginRect,
} from '../src/lib/revealOverlayLayout.ts';
import { runDeferredOverlayActions } from '../src/lib/deferredOverlayActions.ts';

test('clear card model urls resolve only the 192 supported ids', () => {
  assert.equal(clearCardModelUrl(1), `${CLEAR_CARDS_CARD_MODEL_BASE_URL}/1.glb`);
  assert.equal(clearCardModelUrl(CLEAR_CARD_MODEL_COUNT), `${CLEAR_CARDS_CARD_MODEL_BASE_URL}/192.glb`);
  for (const invalidId of [undefined, null, 0, 193, 1.5, '1']) {
    assert.equal(clearCardModelUrl(invalidId), undefined);
  }
});

test('clear card reveal results require exactly one strict valid card id', () => {
  assert.equal(clearCardModelIdFromRevealResult([1]), 1);
  for (const result of [undefined, [], [1, 2], [0], [193], ['1'], [1, 'invalid']]) {
    assert.equal(clearCardModelIdFromRevealResult(result), undefined);
  }
});

test('clear card model loading waits for packed-viewer dimensions', () => {
  const modelUrl = clearCardModelUrl(1);
  const latestModelUrl = clearCardModelUrl(192);
  assert.equal(clearCardModelLoadDecision({ modelUrl: undefined, hasPackModel: true, packReady: false }), 'idle');
  assert.equal(clearCardModelLoadDecision({ modelUrl, hasPackModel: true, packReady: false }), 'defer');
  assert.equal(clearCardModelLoadDecision({ modelUrl: latestModelUrl, hasPackModel: true, packReady: false }), 'defer');
  assert.equal(clearCardModelLoadDecision({ modelUrl: latestModelUrl, hasPackModel: true, packReady: true }), 'load');
  assert.equal(clearCardModelLoadDecision({ modelUrl, hasPackModel: true, packReady: true }), 'load');
  assert.equal(clearCardModelLoadDecision({ modelUrl, hasPackModel: false, packReady: false }), 'load');
});

test('clear card impacts accept only the primary activation pointer', () => {
  assert.equal(isClearCardImpactPointer({ isPrimary: true, button: 0 }), true);
  assert.equal(isClearCardImpactPointer({ isPrimary: true, button: 1 }), false);
  assert.equal(isClearCardImpactPointer({ isPrimary: true, button: 2 }), false);
  assert.equal(isClearCardImpactPointer({ isPrimary: false, button: 0 }), false);
});

test('clear card free movement starts only after unpacking or in a dedicated viewer', () => {
  assert.equal(isClearCardFreeMovementEnabled(false, 'pack'), false);
  assert.equal(isClearCardFreeMovementEnabled(false, 'breaking'), false);
  assert.equal(isClearCardFreeMovementEnabled(false, 'revealed'), true);
  assert.equal(isClearCardFreeMovementEnabled(true, 'pack'), true);
  assert.equal(isClearCardFreeMovementEnabled(true, 'revealed'), true);
});

test('clear card nominal interaction bounds include their edges', () => {
  const bounds = { left: 10, top: 20, right: 110, bottom: 220 };
  for (const point of [
    { clientX: 10, clientY: 20 },
    { clientX: 60, clientY: 120 },
    { clientX: 110, clientY: 220 },
  ]) {
    assert.equal(isClearCardInteractionPoint(point, bounds), true);
  }
  for (const point of [
    { clientX: 9, clientY: 120 },
    { clientX: 111, clientY: 120 },
    { clientX: 60, clientY: 19 },
    { clientX: 60, clientY: 221 },
  ]) {
    assert.equal(isClearCardInteractionPoint(point, bounds), false);
  }
});

test('clear card overlay clicks are protected by confirmed object or fallback hits', () => {
  assert.equal(shouldProtectClearCardOverlayClick(true), true);
  assert.equal(shouldProtectClearCardOverlayClick(false), false);
  assert.equal(shouldProtectClearCardOverlayClick(undefined), false);
  assert.equal(shouldProtectClearCardOverlayClick(false, true), true);
  assert.equal(shouldProtectClearCardOverlayClick(undefined, true), true);
});

test('clear card fallback hits follow the contained image instead of its full element', () => {
  const bounds = { left: 10, top: 20, width: 300, height: 200 };
  const portraitImage = { naturalWidth: 100, naturalHeight: 200 };
  for (const point of [
    { clientX: 110, clientY: 20 },
    { clientX: 160, clientY: 120 },
    { clientX: 210, clientY: 220 },
  ]) {
    assert.equal(isClearCardFallbackImagePoint(point, bounds, portraitImage), true);
  }
  for (const point of [
    { clientX: 109, clientY: 120 },
    { clientX: 211, clientY: 120 },
    { clientX: 160, clientY: 19 },
    { clientX: 160, clientY: 221 },
  ]) {
    assert.equal(isClearCardFallbackImagePoint(point, bounds, portraitImage), false);
  }
  assert.equal(
    isClearCardFallbackImagePoint(
      { clientX: 160, clientY: 120 },
      bounds,
      { naturalWidth: 0, naturalHeight: 0 },
    ),
    false,
  );
});

test('clear card pointer interactions accept nominal bounds or object overhangs', () => {
  assert.equal(
    canStartClearCardPointerInteraction({ withinBounds: true, objectHit: false }),
    true,
  );
  assert.equal(
    canStartClearCardPointerInteraction({ withinBounds: true, objectHit: undefined }),
    true,
  );
  assert.equal(
    canStartClearCardPointerInteraction({ withinBounds: false, objectHit: true }),
    true,
  );
  assert.equal(
    canStartClearCardPointerInteraction({ withinBounds: false, objectHit: false }),
    false,
  );
  assert.equal(
    canStartClearCardPointerInteraction({ withinBounds: false, objectHit: undefined }),
    false,
  );
});

test('clear card impacts accept normal keyboard activation only', () => {
  const activation = {
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  };
  assert.equal(isClearCardImpactKey({ ...activation, key: 'Enter' }), true);
  assert.equal(isClearCardImpactKey({ ...activation, key: ' ' }), true);
  assert.equal(isClearCardImpactKey({ ...activation, key: 'Spacebar' }), true);
  assert.equal(isClearCardImpactKey({ ...activation, key: 'Escape' }), false);
  assert.equal(isClearCardImpactKey({ ...activation, key: 'Enter', repeat: true }), false);
  assert.equal(isClearCardImpactKey({ ...activation, key: 'Enter', altKey: true }), false);
  assert.equal(isClearCardImpactKey({ ...activation, key: 'Enter', ctrlKey: true }), false);
  assert.equal(isClearCardImpactKey({ ...activation, key: 'Enter', metaKey: true }), false);
});

test('recoverable clear card hits never consume persistent progress', () => {
  let state = createClearCardGatedHitState();
  for (let index = 0; index < 12; index += 1) {
    const result = advanceClearCardGatedHit(state, false);
    assert.equal(result.effect, 'recoverable');
    assert.equal(result.hitIndex, (index % 5) + 1);
    state = result.state;
  }
  assert.equal(state.recoverableHits, 12);
  assert.equal(state.persistentHits, 0);

  const firstReadyHit = advanceClearCardGatedHit(state, true);
  assert.equal(firstReadyHit.effect, 'persistent');
  assert.equal(firstReadyHit.hitIndex, 6);
  assert.equal(firstReadyHit.state.persistentHits, 1);
});

test('gated clear card reveal uses three persistent cracks and a fourth-hit break', () => {
  let state = createClearCardGatedHitState();
  for (const expectedHitIndex of [6, 7, 8]) {
    const result = advanceClearCardGatedHit(state, true);
    assert.equal(result.effect, 'persistent');
    assert.equal(result.hitIndex, expectedHitIndex);
    state = result.state;
  }
  const result = advanceClearCardGatedHit(state, true);
  assert.equal(result.effect, 'break');
  assert.equal(result.hitIndex, 9);
});

test('clear card reveal requests retry after failure and stop after success', () => {
  let state = createClearCardRevealRequestState();
  let request = beginClearCardRevealRequest(state);
  assert.equal(request.shouldRequest, true);
  assert.equal(request.state, 'pending');

  request = beginClearCardRevealRequest(request.state);
  assert.equal(request.shouldRequest, false);

  state = settleClearCardRevealRequest('retry');
  request = beginClearCardRevealRequest(state);
  assert.equal(request.shouldRequest, true);

  state = settleClearCardRevealRequest('resolved');
  request = beginClearCardRevealRequest(state);
  assert.equal(request.shouldRequest, false);
  assert.equal(request.state, 'sent');
});

test('resetting gated clear card progression starts persistent hits fresh', () => {
  let state = createClearCardGatedHitState();
  state = advanceClearCardGatedHit(state, true).state;
  state = advanceClearCardGatedHit(state, true).state;
  state = createClearCardGatedHitState();
  const result = advanceClearCardGatedHit(state, true);
  assert.equal(result.effect, 'persistent');
  assert.equal(result.hitIndex, 6);
});

test('clear card reveal target stays centered and within desktop and mobile viewports', () => {
  for (const [viewportWidth, viewportHeight] of [[1440, 900], [390, 844]]) {
    const rect = calcClearCardRevealTargetRect(viewportWidth, viewportHeight);
    assert.ok(rect.left >= 0);
    assert.ok(rect.top >= 0);
    assert.ok(rect.left + rect.width <= viewportWidth);
    assert.ok(rect.top + rect.height <= viewportHeight);
    assert.ok(Math.abs(rect.left * 2 + rect.width - viewportWidth) <= 1);
  }
});

test('clear card pack transition preserves the contained preview aspect ratio', () => {
  const source = { left: 100, top: 200, width: 300, height: 300 };
  const target = { left: 400, top: 50, width: 400, height: 560 };
  const origin = calcContainedMediaRevealOriginRect(
    source,
    target,
    CLEAR_CARDS_PACK_PREVIEW_ASPECT_RATIO,
  );
  const scaleX = origin.width / target.width;
  const scaleY = origin.height / target.height;
  const sourceMediaWidth = source.height * CLEAR_CARDS_PACK_PREVIEW_ASPECT_RATIO;
  const sourceMediaLeft = source.left + (source.width - sourceMediaWidth) / 2;
  const targetMediaHeight = target.width / CLEAR_CARDS_PACK_PREVIEW_ASPECT_RATIO;
  const targetMediaTop = (target.height - targetMediaHeight) / 2;

  assert.ok(Math.abs(scaleX - scaleY) < 1e-12);
  assert.ok(Math.abs(origin.left - sourceMediaLeft) < 1e-9);
  assert.ok(Math.abs(origin.top + targetMediaTop * scaleY - source.top) < 1e-9);
  assert.ok(Math.abs(target.width * scaleX - sourceMediaWidth) < 1e-9);
  assert.ok(Math.abs(targetMediaHeight * scaleY - source.height) < 1e-9);
});

test('suspending an overlay reconciles data without resuming presentation', () => {
  const completed: string[] = [];
  const actions = [
    { kind: 'reconcile' as const, run: () => completed.push('inventory') },
    { kind: 'presentation' as const, run: () => completed.push('overlay') },
    { kind: 'reconcile' as const, run: () => completed.push('pending') },
  ];

  runDeferredOverlayActions(actions, { includePresentation: false });
  assert.deepEqual(completed, ['inventory', 'pending']);

  completed.length = 0;
  runDeferredOverlayActions(actions);
  assert.deepEqual(completed, ['inventory', 'overlay', 'pending']);
});
