import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  advanceClearCardGatedHit,
  beginClearCardRevealRequest,
  createClearCardGatedHitState,
  createClearCardRevealRequestState,
  isClearCardImpactKey,
  isClearCardImpactPointer,
  settleClearCardRevealRequest,
} from '../src/lib/clearCardReveal.ts';
import {
  CLEAR_CARD_MODEL_COUNT,
  clearCardModelLoadDecision,
  clearCardModelIdFromRevealResult,
  clearCardModelUrl,
} from '../src/lib/clearCardModels.ts';
import { CLEAR_CARDS_CARD_MODEL_BASE_URL } from '../src/config/dropMediaDefaults.ts';
import { calcClearCardRevealTargetRect } from '../src/lib/revealOverlayLayout.ts';

const source = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

function cssRule(styles: string, selector: string) {
  const marker = `${selector} {`;
  const start = styles.indexOf(marker);
  assert.notEqual(start, -1, `Missing CSS rule: ${selector}`);
  const end = styles.indexOf('}', start);
  assert.notEqual(end, -1, `Unclosed CSS rule: ${selector}`);
  return styles.slice(start, end + 1);
}

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

test('clear card overlays use a bounded ordinary-filter blur layer', () => {
  const appStyles = source('../src/styles.css');
  const wipStyles = source('../src/clearCardWip.css');
  const app = source('../src/App.tsx');
  const revealOverlay = source('../src/components/ClearCardRevealOverlay.tsx');
  const shopRoute = source('../src/ShopRoute.tsx');

  const activeBlurRule = cssRule(
    appStyles,
    '.shop-route__app--clear-card-blur-open > .shop-route__app-viewport--clear-card-blur-active',
  );
  const liveBackdropRule = cssRule(
    appStyles,
    '.clear-card-reveal-overlay .reveal-overlay__backdrop',
  );
  const stageRule = cssRule(
    appStyles,
    `.shop-route__app--clear-card-blur-open
  > .shop-route__app-viewport
  > .shop-route__app-stage`,
  );
  const wipBackdropRule = cssRule(wipStyles, '.clear-card-wip__backdrop');

  assert.match(activeBlurRule, /filter: blur\(18px\)/);
  assert.match(liveBackdropRule, /backdrop-filter: none/);
  assert.match(
    stageRule,
    /padding:\s+var\(--page-padding-top\)\s+var\(--page-padding-inline\)\s+var\(--page-padding-bottom\)/,
  );
  assert.doesNotMatch(wipBackdropRule, /backdrop-filter/);
  assert.match(revealOverlay, /return createPortal\(/);
  assert.match(revealOverlay, /document\.body/);
  assert.match(revealOverlay, /role="dialog"/);
  assert.match(revealOverlay, /aria-modal="true"/);
  assert.match(revealOverlay, /trapTabFocusWithin\(overlay, event\)/);
  assert.match(shopRoute, /backdropFilter: clearCard \? 'none' : 'blur\(18px\)'/);
  assert.match(shopRoute, /suspended={isWipRoute}/);
  assert.match(shopRoute, /inert={backgroundUnavailable \|\| undefined}/);
  assert.match(shopRoute, /getBoundingClientRect\(\)\.height/);
  assert.doesNotMatch(shopRoute, /document\.documentElement\.scrollHeight/);
  assert.match(
    app,
    /if \(!suspended \|\| !revealOverlayRef\.current\) return;\s+cancelRevealOverlayAnimationFrame\(\);\s+finalizeRevealOverlayDismissal\(\);/,
  );
});
