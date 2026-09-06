import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement, useState } from 'react';
import type { FulfillmentOrder, GetFulfillmentShipStationRatesResponse } from '../src/types.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mons.shop/' });
for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node'] as const) {
  const value = name === 'window' ? dom.window : dom.window[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
let scrollTop = 0;
Object.defineProperty(dom.window, 'scrollY', { configurable: true, get: () => scrollTop });
Object.defineProperty(dom.window, 'scrollTo', {
  configurable: true,
  value: (_left: number, top: number) => { scrollTop = top; },
});

const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { FulfillmentShipStationModal } = await import('../src/fulfillment/FulfillmentShipStationModal.tsx');
type ModalProps = Parameters<typeof FulfillmentShipStationModal>[0];
type Api = NonNullable<ModalProps['api']>;

afterEach(() => {
  cleanup();
  scrollTop = 0;
});

function order(): FulfillmentOrder {
  return {
    dropId: 'card_nft_2',
    deliveryId: 42,
    owner: 'wallet',
    status: 'processed',
    address: { countryCode: 'US' },
    boxes: [],
    looseDudes: [1],
    shipstationShipmentId: 'se-42',
    shipstationPackage: { length: 8, width: 6, height: 2, weight: 5 },
    shipstationPackageCount: 1,
  };
}

function api(overrides: Partial<Api> = {}): Api {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected ShipStation request'); };
  return {
    addFulfillmentOrderToShipStation: unexpected,
    getFulfillmentShipStationRates: unexpected,
    purchaseFulfillmentShipStationLabel: unexpected,
    voidFulfillmentShipStationLabel: unexpected,
    getFulfillmentShipStationLabel: unexpected,
    ...overrides,
  };
}

function Harness({ suspended = false, api: client }: { suspended?: boolean; api: Api }) {
  const [currentOrder, setOrder] = useState(order);
  const [open, setOpen] = useState(false);
  return createElement('div', null,
    createElement('button', { onClick: () => setOpen(true) }, 'Print order label'),
    createElement(FulfillmentShipStationModal, {
      order: open ? currentOrder : null,
      canManage: true,
      suspended,
      api: client,
      isCurrentScope: () => true,
      onClose: () => setOpen(false),
      onOrderUpdated: (_key, update) => setOrder(update),
    }),
  );
}

test('ShipStation modal blocks busy dismissal, then restores opener focus and page scroll on close', async () => {
  let resolveRates!: (response: GetFulfillmentShipStationRatesResponse) => void;
  const rates = new Promise<GetFulfillmentShipStationRatesResponse>((resolve) => { resolveRates = resolve; });
  const view = render(createElement(Harness, {
    api: api({ getFulfillmentShipStationRates: () => rates }),
  }), { reactStrictMode: true });
  const opener = view.getByRole('button', { name: 'Print order label' });
  scrollTop = 720;
  opener.focus();
  fireEvent.click(opener);
  const dialog = view.getByRole('dialog', { name: 'Print label · Order 42' });
  assert.equal(dialog.contains(document.activeElement), true);
  assert.equal(document.documentElement.classList.contains('overlay-scroll-lock'), true);
  fireEvent.click(view.getByRole('button', { name: 'Get rates' }));
  assert.equal((view.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled, true);
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(dialog.parentElement!);
  assert.equal(view.getByRole('dialog'), dialog);

  await act(async () => resolveRates({
    deliveryId: 42,
    shipmentId: 'se-42',
    rates: [],
    invalidRates: [],
    packageCount: 1,
  }));
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(document.activeElement, opener);
  assert.equal(document.documentElement.classList.contains('overlay-scroll-lock'), false);
  assert.equal(document.body.style.overflow, '');
  assert.equal(scrollTop, 720);
});

test('wallet suspension preserves package edits and resumes the same modal', () => {
  const client = api();
  const view = render(createElement(Harness, { api: client }));
  fireEvent.click(view.getByRole('button', { name: 'Print order label' }));
  fireEvent.change(view.getByRole('textbox', { name: 'Package weight in ounces' }), { target: { value: '12.5' } });
  const dialog = view.getByRole('dialog');

  view.rerender(createElement(Harness, { api: client, suspended: true }));
  assert.equal(dialog.hasAttribute('inert'), true);
  assert.equal(dialog.getAttribute('aria-hidden'), 'true');
  assert.equal(document.documentElement.classList.contains('overlay-scroll-lock'), false);
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(document.querySelector('[role="dialog"]'), dialog);

  view.rerender(createElement(Harness, { api: client, suspended: false }));
  assert.equal(view.getByRole('dialog'), dialog);
  assert.equal(document.documentElement.classList.contains('overlay-scroll-lock'), true);
  assert.equal((view.getByRole('textbox', { name: 'Package weight in ounces' }) as HTMLInputElement).value, '12.5');
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.queryByRole('dialog'), null);
});
