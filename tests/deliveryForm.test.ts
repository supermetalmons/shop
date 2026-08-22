import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: dom.window.MutationObserver });
Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: dom.window.getComputedStyle });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

const { cleanup, render } = await import('@testing-library/react');
const { DeliveryForm } = await import('../src/components/DeliveryForm.tsx');

afterEach(() => cleanup());

function renderDrifellaShirtDeliveryForm(countryCode: string): string {
  return renderToStaticMarkup(
    createElement(DeliveryForm, {
      onSubmit: async () => undefined,
      itemsPerBox: 0,
      boxNamePrefix: 'shirt',
      figureNamePrefix: 'shirt',
      dropFamily: 'drifella_shirt',
      countryCode,
    }),
  );
}

test('drifella shirt delivery form describes flat US and international shipping', () => {
  const usMarkup = renderDrifellaShirtDeliveryForm('US');
  assert.match(usMarkup, /US delivery: 0\.1 SOL\./);
  assert.doesNotMatch(usMarkup, /Free US shipping|additional shirt/);

  const internationalMarkup = renderDrifellaShirtDeliveryForm('TR');
  assert.match(internationalMarkup, /International delivery: 0\.25 SOL\./);
  assert.doesNotMatch(internationalMarkup, /up to 1 shirt|additional shirt/);
});

test('clear cards delivery form describes the card_nft_2 redeem fees', () => {
  const usMarkup = renderToStaticMarkup(
    createElement(DeliveryForm, {
      onSubmit: async () => undefined,
      itemsPerBox: 1,
      boxNamePrefix: 'pack',
      figureNamePrefix: 'card',
      dropFamily: 'clear_cards',
      countryCode: 'US',
    }),
  );
  assert.match(usMarkup, /US delivery: 0\.2 SOL up to 3 cards\. 0\.06 SOL each additional card\./);

  const internationalMarkup = renderToStaticMarkup(
    createElement(DeliveryForm, {
      onSubmit: async () => undefined,
      itemsPerBox: 1,
      boxNamePrefix: 'pack',
      figureNamePrefix: 'card',
      dropFamily: 'clear_cards',
      countryCode: 'TR',
    }),
  );
  assert.match(internationalMarkup, /International delivery: 0\.4 SOL up to 3 cards\. 0\.06 SOL each additional card\./);
});

test('delivery form keeps its initial shipping terms until it is reopened', () => {
  const onSubmit = async () => undefined;
  const view = render(createElement(DeliveryForm, {
    onSubmit,
    itemsPerBox: 1,
    boxNamePrefix: 'pack',
    figureNamePrefix: 'card',
    dropFamily: 'card_nft_2',
    countryCode: 'US',
    submitLabel: 'Send for 0.2 SOL',
  }));

  assert.match(view.container.textContent || '', /US delivery: 0\.2 SOL up to 3 cards/);
  view.rerender(createElement(DeliveryForm, {
    onSubmit,
    countryCode: 'TR',
    shipmentPending: true,
    submitLabel: 'Send',
  }));
  assert.match(view.container.textContent || '', /International delivery: 0\.4 SOL up to 3 cards/);
  assert.match(view.container.textContent || '', /Shipment pending…/);
  assert.equal((view.getByRole('button', { name: 'Shipment pending…' }) as HTMLButtonElement).disabled, true);
  assert.doesNotMatch(view.container.textContent || '', /Free US shipping/);

  view.unmount();
  const reopened = render(createElement(DeliveryForm, {
    onSubmit,
    itemsPerBox: 0,
    boxNamePrefix: 'shirt',
    figureNamePrefix: 'shirt',
    dropFamily: 'drifella_shirt',
    countryCode: 'US',
  }));
  assert.match(reopened.container.textContent || '', /US delivery: 0\.1 SOL\./);
});

test('delivery form captures shipping terms when its context becomes available', () => {
  const onSubmit = async () => undefined;
  const view = render(createElement(DeliveryForm, { onSubmit, countryCode: 'US' }));

  view.rerender(createElement(DeliveryForm, {
    onSubmit,
    itemsPerBox: 1,
    boxNamePrefix: 'pack',
    figureNamePrefix: 'card',
    dropFamily: 'card_nft_2',
    countryCode: 'US',
    submitLabel: 'Send for 0.2 SOL',
  }));
  assert.match(view.container.textContent || '', /US delivery: 0\.2 SOL up to 3 cards/);
  assert.match(view.container.textContent || '', /Send for 0\.2 SOL/);

  view.rerender(createElement(DeliveryForm, {
    onSubmit,
    itemsPerBox: 0,
    boxNamePrefix: 'shirt',
    figureNamePrefix: 'shirt',
    dropFamily: 'drifella_shirt',
    countryCode: 'US',
    submitLabel: 'Send for 0.1 SOL',
  }));
  assert.match(view.container.textContent || '', /US delivery: 0\.1 SOL\./);
  assert.match(view.container.textContent || '', /Send for 0\.1 SOL/);

  view.rerender(createElement(DeliveryForm, {
    onSubmit,
    countryCode: 'US',
    shipmentPending: true,
  }));
  assert.match(view.container.textContent || '', /US delivery: 0\.1 SOL\./);
  assert.match(view.container.textContent || '', /Shipment pending…/);
});

test('disabled delivery form does not infer a pending shipment', () => {
  const view = render(createElement(DeliveryForm, {
    onSubmit: async () => undefined,
    countryCode: 'US',
    submitDisabled: true,
    submitLabel: 'Unavailable',
  }));

  assert.match(view.container.textContent || '', /Unavailable/);
  assert.doesNotMatch(view.container.textContent || '', /Shipment pending…/);
});
