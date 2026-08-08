import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BackgroundBlurPortal,
  BackgroundBlurProvider,
} from '../src/components/BackgroundBlurLayer.tsx';
import {
  ModalFocusScope,
  shouldMoveFocusIntoModalScope,
} from '../src/components/ModalFocusScope.tsx';
import { SuccessHud } from '../src/components/SuccessHud.tsx';
import { prepareWalletModalDialog } from '../src/wallet/walletModalFocus.ts';
import {
  combineBackgroundBlurStates,
  DEFAULT_BACKGROUND_BLUR_RADIUS,
  normalizeBackgroundBlurState,
  sameBackgroundBlurState,
  shouldRestoreBackgroundFocus,
  supportsMozElementCapture,
} from '../src/lib/backgroundBlur.ts';
import { canRestoreFocus, focusFirstControl } from '../src/lib/focusTrap.ts';
import {
  isModalLayerSuspended,
  MODAL_LAYER_PRIORITY,
  type ModalLayer,
  resolveActiveModalLayer,
  shouldToastAppearAboveModal,
} from '../src/lib/modalLayers.ts';

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

function cssZIndex(styles: string, selector: string) {
  const marker = `${selector} {`;
  let start = styles.indexOf(marker);
  let zIndex: number | undefined;
  while (start !== -1) {
    if (start === 0 || styles[start - 1] === '\n') {
      const end = styles.indexOf('}', start);
      assert.notEqual(end, -1, `Unclosed CSS rule: ${selector}`);
      const match = styles.slice(start, end + 1).match(/z-index:\s*(\d+)/);
      if (match) zIndex = Number(match[1]);
    }
    start = styles.indexOf(marker, start + marker.length);
  }
  assert.notEqual(zIndex, undefined, `Missing z-index in CSS rule: ${selector}`);
  return zIndex;
}

test('blur requests normalize active state and safe radii', () => {
  assert.deepEqual(normalizeBackgroundBlurState({ open: false, active: true }), {
    open: true,
    active: true,
    radius: DEFAULT_BACKGROUND_BLUR_RADIUS,
  });
  assert.equal(
    normalizeBackgroundBlurState({ open: true, active: true, radius: 0 }).radius,
    0,
  );
  assert.equal(
    normalizeBackgroundBlurState({ open: true, active: true, radius: -2 }).radius,
    DEFAULT_BACKGROUND_BLUR_RADIUS,
  );
  assert.equal(
    normalizeBackgroundBlurState({ open: true, active: true, radius: Number.NaN }).radius,
    DEFAULT_BACKGROUND_BLUR_RADIUS,
  );
});

test('blur aggregation uses only active radii and preserves small values', () => {
  assert.deepEqual(combineBackgroundBlurStates([]), {
    open: false,
    active: false,
    radius: DEFAULT_BACKGROUND_BLUR_RADIUS,
  });
  assert.deepEqual(
    combineBackgroundBlurStates([
      { open: true, active: false, radius: 80 },
      { open: false, active: true, radius: 2 },
      { open: true, active: true, radius: 12 },
    ]),
    { open: true, active: true, radius: 12 },
  );
  assert.equal(
    combineBackgroundBlurStates([{ open: false, active: true, radius: 0 }]).radius,
    0,
  );
});

test('resolved blur equality compares every rendered field', () => {
  const state = { open: true, active: true, radius: 2 };
  assert.equal(sameBackgroundBlurState(state, { ...state }), true);
  assert.equal(sameBackgroundBlurState(state, { ...state, open: false }), false);
  assert.equal(sameBackgroundBlurState(state, { ...state, active: false }), false);
  assert.equal(sameBackgroundBlurState(state, { ...state, radius: 18 }), false);
});

test('closing blur preserves valid foreground focus', () => {
  assert.equal(
    shouldRestoreBackgroundFocus({
      activeElementIsRestorable: true,
      activeElementIsInBackground: false,
    }),
    false,
  );
  assert.equal(
    shouldRestoreBackgroundFocus({
      activeElementIsRestorable: true,
      activeElementIsInBackground: true,
    }),
    true,
  );
  assert.equal(
    shouldRestoreBackgroundFocus({
      activeElementIsRestorable: false,
      activeElementIsInBackground: false,
    }),
    true,
  );
});

test('active blur portals render even when open is false', () => {
  const markup = renderToStaticMarkup(
    createElement(
      BackgroundBlurPortal,
      { open: false, active: true },
      createElement('span', null, 'Foreground'),
    ),
  );
  assert.equal(markup, '<span>Foreground</span>');
});

test('success HUD renders its announcement and visual content together', () => {
  const markup = renderToStaticMarkup(
    createElement(SuccessHud, {
      announcement: 'Transfer complete',
      className: 'success-hud--drif',
      phase: 'visible',
    }),
  );

  assert.match(markup, /role="status"/);
  assert.match(markup, />Transfer complete</);
  assert.match(markup, /class="success-hud success-hud--drif"/);
  assert.match(markup, /data-frosted-surface=""/);
});

test('background provider preserves header, page, and trailing control tab order', () => {
  const markup = renderToStaticMarkup(
    createElement(
      BackgroundBlurProvider,
      null,
      createElement('main', null, 'Page'),
    ),
  );
  const leadingPortal = markup.indexOf('id="background-blur-leading-portals-source"');
  const pageStage = markup.indexOf('id="background-blur-source"');
  const trailingPortal = markup.indexOf('id="background-blur-portals-source"');

  assert.ok(leadingPortal >= 0);
  assert.ok(pageStage > leadingPortal);
  assert.ok(trailingPortal > pageStage);
});

test('focus fallback skips non-tabbable and hidden controls', () => {
  let focused = '';
  let focusableSelector = '';
  const control = (
    name: string,
    { tabIndex = 0, hidden = false }: { tabIndex?: number; hidden?: boolean } = {},
  ) => ({
    tabIndex,
    isConnected: true,
    matches: () => false,
    closest: () => (hidden ? {} : null),
    focus: () => {
      focused = name;
    },
  });
  const spacerLink = control('spacer', { tabIndex: -1 });
  const hiddenButton = control('hidden', { hidden: true });
  const visibleButton = control('visible');
  const root = {
    querySelectorAll: (selector: string) => {
      focusableSelector = selector;
      return [spacerLink, hiddenButton, visibleButton];
    },
    focus: () => {
      focused = 'root';
    },
  };

  focusFirstControl(root as unknown as HTMLElement);
  assert.equal(focused, 'visible');
  assert.match(focusableSelector, /summary/);
});

test('focus restoration rejects controls hidden by closed details', () => {
  const summary = {
    matches: (selector: string) => selector === 'summary',
    contains: () => false,
  };
  const details = {
    matches: (selector: string) => selector === 'details:not([open])',
    children: [summary],
    parentElement: null,
  };
  const control = {
    isConnected: true,
    matches: () => false,
    closest: () => null,
    parentElement: details,
  };

  assert.equal(canRestoreFocus(control as unknown as HTMLElement), false);
});

test('Firefox element capture detection uses the CSS contract from the stylesheet', () => {
  let invocation: [string, string] | undefined;
  const supported = supportsMozElementCapture({
    supports: (property, value) => {
      invocation = [property, value];
      return true;
    },
  });

  assert.equal(supported, true);
  assert.deepEqual(invocation, [
    'background-image',
    '-moz-element(#background-blur-source)',
  ]);
  assert.equal(supportsMozElementCapture(undefined), false);
});

test('modal focus scopes expose active, suspended, and nested semantics', () => {
  const activeMarkup = renderToStaticMarkup(
    createElement(
      ModalFocusScope,
      { ariaLabel: 'Card viewer' },
      createElement('button', { type: 'button' }, 'Bookmark'),
    ),
  );
  const suspendedMarkup = renderToStaticMarkup(
    createElement(ModalFocusScope, { ariaLabel: 'Exporting', suspended: true }),
  );
  const nestedMarkup = renderToStaticMarkup(
    createElement(ModalFocusScope, { ariaLabel: 'Nested', enabled: false }),
  );

  assert.match(activeMarkup, /role="dialog"/);
  assert.match(activeMarkup, /aria-modal="true"/);
  assert.match(activeMarkup, /<button type="button">Bookmark<\/button>/);
  assert.match(suspendedMarkup, /role="dialog"/);
  assert.match(suspendedMarkup, /aria-hidden="true"/);
  assert.match(suspendedMarkup, /inert=""/);
  assert.doesNotMatch(suspendedMarkup, /aria-modal=/);
  assert.doesNotMatch(nestedMarkup, /role=|aria-modal=|aria-hidden=|inert=/);
});

test('modal focus scopes retry autofocus from the root or an invalid descendant', () => {
  assert.equal(
    shouldMoveFocusIntoModalScope({
      enabled: true,
      suspended: false,
      activeElementIsScope: true,
      activeElementIsInScope: true,
      activeElementIsTabbable: true,
    }),
    true,
  );
  assert.equal(
    shouldMoveFocusIntoModalScope({
      enabled: true,
      suspended: false,
      activeElementIsScope: false,
      activeElementIsInScope: true,
      activeElementIsTabbable: true,
    }),
    false,
  );
  assert.equal(
    shouldMoveFocusIntoModalScope({
      enabled: true,
      suspended: false,
      activeElementIsScope: false,
      activeElementIsInScope: true,
      activeElementIsTabbable: false,
    }),
    true,
  );
  assert.equal(
    shouldMoveFocusIntoModalScope({
      enabled: true,
      suspended: true,
      activeElementIsScope: true,
      activeElementIsInScope: true,
      activeElementIsTabbable: true,
    }),
    false,
  );
});

test('modal layer policy resolves complete priority and fallback ordering', () => {
  const state = (openLayers: readonly ModalLayer[]) =>
    Object.fromEntries(
      MODAL_LAYER_PRIORITY.map((layer) => [layer, openLayers.includes(layer)]),
    ) as Record<ModalLayer, boolean>;

  assert.deepEqual(MODAL_LAYER_PRIORITY, [
    'wallet',
    'transfer',
    'reveal',
    'claim',
    'shipment',
    'notify',
  ]);
  assert.equal(resolveActiveModalLayer(state([])), null);

  MODAL_LAYER_PRIORITY.forEach((layer, index) => {
    assert.equal(resolveActiveModalLayer(state([layer])), layer);
    assert.equal(
      resolveActiveModalLayer(state(MODAL_LAYER_PRIORITY.slice(index))),
      layer,
    );
  });
});

test('modal suspension respects app state and layer priority', () => {
  assert.equal(
    isModalLayerSuspended({
      activeLayer: null,
      appSuspended: true,
      layer: 'notify',
      open: false,
    }),
    true,
  );

  MODAL_LAYER_PRIORITY.forEach((layer, layerIndex) => {
    assert.equal(
      isModalLayerSuspended({ activeLayer: 'wallet', layer, open: false }),
      false,
    );
    MODAL_LAYER_PRIORITY.forEach((activeLayer, activeIndex) => {
      assert.equal(
        isModalLayerSuspended({ activeLayer, layer, open: true }),
        activeIndex < layerIndex,
        `${activeLayer} against ${layer}`,
      );
    });
  });
});

test('toast elevation covers transfers, viewers, and fulfillment dialogs', () => {
  const elevation = (
    activeLayer: ModalLayer | null,
    receiptTransferOpen = false,
    receiptViewerOpen = false,
  ) =>
    shouldToastAppearAboveModal({
      activeLayer,
      receiptTransferOpen,
      receiptViewerOpen,
    });

  assert.equal(elevation(null), false);
  assert.equal(elevation('wallet'), false);
  assert.equal(elevation('reveal'), false);
  assert.equal(elevation(null, true), true);
  assert.equal(elevation(null, false, true), true);
  assert.equal(elevation('claim'), true);
  assert.equal(elevation('shipment'), true);
  assert.equal(elevation('notify'), true);
});

test('wallet dialog preparation repairs labels and prefers a usable wallet choice', () => {
  const element = ({
    attributes = {},
    id = '',
    tabIndex = 0,
    textContent = '',
    matches = () => false,
  }: {
    attributes?: Record<string, string>;
    id?: string;
    tabIndex?: number;
    textContent?: string;
    matches?: (selector: string) => boolean;
  } = {}) => {
    const values = new Map(Object.entries(attributes));
    return {
      id,
      tabIndex,
      textContent,
      isConnected: true,
      ownerDocument: null,
      getAttribute: (name: string) => values.get(name) ?? null,
      setAttribute: (name: string, value: string) => values.set(name, value),
      matches,
      closest: () => null,
      querySelector: () => null,
    };
  };

  const title = element({ textContent: 'Connect a wallet' });
  const closeButton = element();
  const disabledChoice = element({
    matches: (selector) => selector === ':disabled',
  });
  const untabbableChoice = element({ tabIndex: -1 });
  const ariaDisabledChoice = element({
    matches: (selector) => selector === '[aria-disabled="true"]',
  });
  const cssHiddenChoice = {
    ...element(),
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      },
    },
    getClientRects: () => [],
  };
  const walletChoice = element();
  const dialogAttributes = new Map([
    ['aria-labelledby', 'wallet-adapter-modal-title'],
  ]);
  const dialog = {
    getAttribute: (name: string) => dialogAttributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => dialogAttributes.set(name, value),
    querySelector: (selector: string) => {
      if (selector === '.wallet-adapter-modal-title') return title;
      if (selector === '.wallet-adapter-modal-button-close') return closeButton;
      return null;
    },
    querySelectorAll: () => [
      disabledChoice,
      untabbableChoice,
      ariaDisabledChoice,
      cssHiddenChoice,
      walletChoice,
    ],
  };

  const preferred = prepareWalletModalDialog(dialog as unknown as HTMLElement);

  assert.equal(title.id, 'wallet-adapter-modal-title');
  assert.equal(closeButton.getAttribute('aria-label'), 'Close wallet selector');
  assert.equal(preferred, walletChoice);

  const labelledCloseButton = element({
    attributes: { 'aria-label': 'Dismiss wallet chooser' },
  });
  const labelledTitle = element({ id: 'custom-wallet-title' });
  const labelledDialog = {
    getAttribute: (name: string) =>
      name === 'aria-labelledby' ? 'custom-wallet-title' : null,
    setAttribute: () => {
      throw new Error('Existing dialog label must not be overwritten');
    },
    querySelector: (selector: string) =>
      selector === '.wallet-adapter-modal-title' ? labelledTitle : labelledCloseButton,
    querySelectorAll: () => [],
  };

  assert.equal(
    prepareWalletModalDialog(labelledDialog as unknown as HTMLElement),
    null,
  );
  assert.equal(labelledCloseButton.getAttribute('aria-label'), 'Dismiss wallet chooser');
  assert.equal(labelledTitle.id, 'custom-wallet-title');
});

test('blur viewport background is route-overridable without retheming portals', () => {
  const styles = source('../src/styles.css');
  const drifStyles = source('../src/drif.css');
  const viewportRule = cssRule(
    styles,
    '.background-blur-layer--open > .background-blur-layer__viewport',
  );

  assert.match(
    viewportRule,
    /background: var\(--background-blur-background, var\(--bg\)\)/,
  );
  assert.match(
    cssRule(drifStyles, '.drif-body'),
    /--background-blur-background: #000/,
  );
  assert.match(
    cssRule(drifStyles, '.drif-body .background-blur-layer__stage'),
    /height: calc\(100vh - var\(--page-padding-top\) - var\(--page-padding-bottom\)\)/,
  );
  assert.match(
    cssRule(drifStyles, '.drif-body .background-blur-layer__stage'),
    /height: calc\(100svh - var\(--page-padding-top\) - var\(--page-padding-bottom\)\)/,
  );
  assert.doesNotMatch(
    cssRule(drifStyles, '.drif-body .background-blur-layer__stage'),
    /--background-blur-container-height/,
  );
});

test('Firefox live surfaces composite trailing UI, header UI, then the page', () => {
  const styles = source('../src/styles.css');
  const surfaceRule = cssRule(styles, `.toast::before,
  .success-hud::before`);
  const trailingPortal = surfaceRule.indexOf(
    '-moz-element(#background-blur-portals-source)',
  );
  const leadingPortal = surfaceRule.indexOf(
    '-moz-element(#background-blur-leading-portals-source)',
  );
  const pageStage = surfaceRule.indexOf('-moz-element(#background-blur-source)');

  assert.ok(trailingPortal >= 0);
  assert.ok(leadingPortal > trailingPortal);
  assert.ok(pageStage > leadingPortal);
  assert.match(
    cssRule(styles, '.toast.toast--above-modal'),
    /background: var\(--card\)/,
  );
  assert.match(
    cssRule(styles, '.toast.toast--above-modal::before'),
    /content: none/,
  );
  assert.match(
    cssRule(
      styles,
      '.receipt-viewer-overlay [data-frosted-surface]',
    ),
    /background: var\(--card\)/,
  );
  assert.match(
    cssRule(
      styles,
      '.receipt-viewer-overlay [data-frosted-surface]::before',
    ),
    /content: none/,
  );
  assert.doesNotMatch(styles, /receipt-viewer-blur-source/);
});

test('global foreground layers have deterministic stacking', () => {
  const styles = source('../src/styles.css');
  const orderedLayers = [
    cssZIndex(styles, '.background-blur-layer__portals'),
    cssZIndex(styles, '.fulfillment-export-progress'),
    cssZIndex(styles, '.modal-overlay--suspended'),
    cssZIndex(styles, '.modal-overlay'),
    cssZIndex(
      styles,
      '.modal-overlay.receipt-transfer-modal-overlay.modal-overlay--suspended',
    ),
    cssZIndex(styles, '.reveal-overlay'),
    cssZIndex(styles, '.modal-overlay.receipt-transfer-modal-overlay'),
    cssZIndex(styles, '.toast.toast--above-modal'),
    cssZIndex(styles, 'body .wallet-adapter-modal'),
  ];

  assert.deepEqual(orderedLayers, [900, 950, 990, 1000, 1100, 1110, 1200, 1210, 1300]);
  assert.match(cssRule(styles, '.modal-overlay--suspended'), /filter: blur\(18px\)/);
  assert.ok(
    styles.indexOf('.modal-overlay.receipt-transfer-modal-overlay.modal-overlay--suspended') >
      styles.indexOf('.modal-overlay.receipt-transfer-modal-overlay {'),
  );
});

test('suspended blur filtering stays scoped to static viewers', () => {
  const styles = source('../src/styles.css');
  const genericRule = cssRule(styles, '.reveal-overlay--suspended');
  const staticViewerRule = cssRule(
    styles,
    `.receipt-viewer-overlay.reveal-overlay--suspended,
.poncho-card-viewer-overlay.reveal-overlay--suspended`,
  );

  assert.doesNotMatch(genericRule, /filter:/);
  assert.match(staticViewerRule, /filter: blur\(18px\)/);
  assert.doesNotMatch(
    cssRule(
      styles,
      '.modal-overlay.receipt-transfer-modal-overlay.modal-overlay--suspended',
    ),
    /filter:/,
  );
});

test('Clear Card lighting stays opaque without a blur implementation', () => {
  const styles = source('../src/clearCardWip.css');

  assert.match(
    styles,
    /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\) or \(background-image: -moz-element\(#clear-card-wip-blur-source\)\)\)/,
  );
  assert.match(
    styles,
    /@supports not [^{]+\{\s*\.lighting-lab \{\s*background: var\(--lighting-lab-panel-solid\)/,
  );
});
