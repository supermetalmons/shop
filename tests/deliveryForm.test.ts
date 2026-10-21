import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DropFamily } from '../shared/deploymentCore.ts';
import { parseShipStationShipTo } from '../shared/shipstationRates.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: dom.window.MutationObserver });
Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: dom.window.getComputedStyle });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { DeliveryForm } = await import('../src/components/DeliveryForm.tsx');

afterEach(() => cleanup());

type ShippingNoteCase = {
  itemsPerBox?: number;
  boxNamePrefix?: string;
  figureNamePrefix?: string;
  US: string;
  TR: string;
};

const defaultNotes = {
  US: 'Free US shipping',
  TR: 'International delivery: 0.25 SOL up to 1 figure. 0.05 SOL each additional figure.',
};
const binderNotes = {
  itemsPerBox: 0,
  boxNamePrefix: 'binder',
  US: 'Free US shipping',
  TR: 'International delivery: 0.25 SOL up to 1 binder. 0.05 SOL each additional binder.',
};
const cardNotes = {
  boxNamePrefix: 'pack',
  figureNamePrefix: 'card',
  US: 'US delivery: 0.12 SOL up to 3 cards. 0.03 SOL each additional card.',
  TR: 'International delivery: 0.24 SOL up to 3 cards. 0.03 SOL each additional card.',
};
const familyNotes: Record<DropFamily, ShippingNoteCase> = {
  default: defaultNotes,
  little_swag_boxes: {
    itemsPerBox: 3,
    US: 'US delivery: 0.1 SOL up to 3 figures. 0.025 SOL each additional figure.',
    TR: 'International delivery: 0.25 SOL up to 3 figures. 0.05 SOL each additional figure.',
  },
  poncho_drifella: {
    itemsPerBox: 1,
    boxNamePrefix: 'pack',
    figureNamePrefix: 'card',
    US: 'US delivery: 0.05 SOL flat.',
    TR: 'International delivery: 0.25 SOL up to 1 card. 0.05 SOL each additional card.',
  },
  drifella_binder: binderNotes,
  card_nft_binder: binderNotes,
  drifella_shirt: {
    itemsPerBox: 0,
    boxNamePrefix: 'shirt',
    US: 'US delivery: 0.1 SOL.',
    TR: 'International delivery: 0.25 SOL.',
  },
  little_swag_hoodies: {
    itemsPerBox: 0,
    boxNamePrefix: 'hoodie',
    US: 'Free US shipping',
    TR: 'International delivery: 0.6 SOL for the first hoodie. 0.5 SOL each additional hoodie.',
  },
  card_nft_2: { ...cardNotes, itemsPerBox: 3 },
  clear_cards: { ...cardNotes, itemsPerBox: 1 },
  mi_note_cards: {
    itemsPerBox: 2,
    boxNamePrefix: 'pack',
    figureNamePrefix: 'card',
    US: 'US delivery: 0.12 SOL up to 2 cards. 0.03 SOL each additional card.',
    TR: 'International delivery: 0.24 SOL up to 2 cards. 0.03 SOL each additional card.',
  },
  tbd: defaultNotes,
};

const noteCases = [
  ...Object.entries(familyNotes).map(([dropFamily, notes]) => ({
    name: dropFamily,
    dropFamily: dropFamily as DropFamily,
    ...notes,
  })),
  { name: 'unspecified family', dropFamily: undefined, ...defaultNotes },
  {
    name: 'default direct delivery',
    dropFamily: 'default' as const,
    itemsPerBox: 0,
    US: 'Free US shipping',
    TR: 'International delivery: 0.25 SOL up to 1 box. 0.05 SOL each additional box.',
  },
];

for (const { name, US, TR, ...props } of noteCases) {
  for (const [countryCode, expected] of Object.entries({ US, TR })) {
    test(`delivery form describes ${name} shipping to ${countryCode}`, () => {
      const markup = renderToStaticMarkup(createElement(DeliveryForm, {
        ...props,
        countryCode,
        onSubmit: async () => undefined,
      }));
      const note = JSDOM.fragment(markup).querySelector('form > div.muted.small')?.textContent;
      assert.equal(note, expected);
    });
  }
}

test('delivery form uses normalized countries and direct-delivery pricing for card families', () => {
  const cases = [
    { countryCode: 'us', itemsPerBox: 1, expected: cardNotes.US },
    { countryCode: ' US ', itemsPerBox: 1, expected: cardNotes.US },
    { countryCode: 'US', itemsPerBox: 0, expected: 'Free US shipping' },
  ];
  for (const { expected, ...props } of cases) {
    const markup = renderToStaticMarkup(createElement(DeliveryForm, {
      ...props,
      dropFamily: 'clear_cards',
      figureNamePrefix: 'card',
      onSubmit: async () => undefined,
    }));
    const note = JSDOM.fragment(markup).querySelector('form > div.muted.small')?.textContent;
    assert.equal(note, expected);
  }
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
    submitLabel: 'Send for 0.12 SOL',
  }));

  assert.match(view.container.textContent || '', /US delivery: 0\.12 SOL up to 3 cards/);
  view.rerender(createElement(DeliveryForm, {
    onSubmit,
    countryCode: 'TR',
    shipmentPending: true,
    submitLabel: 'Send',
  }));
  assert.match(view.container.textContent || '', /International delivery: 0\.24 SOL up to 3 cards/);
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
    submitLabel: 'Send for 0.12 SOL',
  }));
  assert.match(view.container.textContent || '', /US delivery: 0\.12 SOL up to 3 cards/);
  assert.match(view.container.textContent || '', /Send for 0\.12 SOL/);

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

test('delivery form submits international addresses with only the required local fields', async () => {
  const cases = [
    { code: 'GB', city: 'London', region: '', postal: 'SW1A 1AA', line: 'London, , SW1A 1AA' },
    { code: 'GB', city: 'London', region: '', postal: 'SW1A  1AA', normalizedPostal: 'SW1A 1AA', line: 'London, , SW1A 1AA' },
    { code: 'HK', city: 'Hong Kong', region: 'Kowloon', postal: '', line: 'Hong Kong, Kowloon,' },
    { code: 'IE', city: 'Dublin', region: '', postal: '', line: 'Dublin, ,' },
    { code: 'IE', city: 'Dublin 1', region: '', postal: '', line: 'Dublin 1, ,' },
    { code: 'IE', city: 'Dublin', region: '', postal: 'D02  X285', normalizedPostal: 'D02 X285', line: 'Dublin, , D02 X285' },
    { code: 'AR', city: '9 de Julio', region: '', postal: '', line: '9 de Julio, ,' },
    { code: 'EG', city: '6th of October', region: '', postal: '', line: '6th of October, ,' },
    { code: 'HK', city: 'Hong Kong', region: 'District 1', postal: '', line: 'Hong Kong, District 1,' },
    { code: 'VN', city: 'Ho Chi Minh City', region: 'District 1', postal: '', line: 'Ho Chi Minh City, District 1,' },
    { code: 'IE', city: 'Dublin', region: 'Dublin, Leinster', postal: '', line: 'Dublin, Dublin, Leinster,' },
    { code: 'HK', city: 'Hong Kong', region: 'Kowloon, Hong Kong', postal: '', line: 'Hong Kong, Kowloon, Hong Kong,' },
    { code: 'HK', city: 'Hong Kong', region: 'District 1', postal: '000000', line: 'Hong Kong, District 1, 000000' },
    { code: 'IN', city: 'Bengaluru', region: 'Karnataka', postal: '560 001', line: 'Bengaluru, Karnataka, 560 001' },
  ];
  for (const { code, city, region, postal, normalizedPostal = postal, line } of cases) {
    const submissions: Array<{ formatted: string; countryCode: string }> = [];
    const view = render(createElement(DeliveryForm, {
      countryCode: code,
      onSubmit: async (payload) => { submissions.push(payload); },
    }));
    fireEvent.change(view.getByLabelText('Email'), { target: { value: 'recipient@example.com' } });
    fireEvent.change(view.getByLabelText('Full name'), { target: { value: 'Recipient' } });
    fireEvent.change(view.getByLabelText('Address line 1'), { target: { value: '1 Example Street' } });
    fireEvent.change(view.getByLabelText('City'), { target: { value: city } });
    if (region) fireEvent.change(view.getByLabelText(/^State \/ Region/), { target: { value: region } });
    if (postal) fireEvent.change(view.getByLabelText(/^Postal code/), { target: { value: postal } });
    fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => assert.equal(submissions.length, 1));
    assert.equal(submissions[0].countryCode, code);
    assert.equal(submissions[0].formatted.split('\n')[2], line);
    const parsed = parseShipStationShipTo(submissions[0].formatted, submissions[0].countryCode);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.shipTo?.city_locality, city);
    assert.equal(parsed.shipTo?.state_province, region);
    assert.equal(parsed.shipTo?.postal_code, normalizedPostal);
    view.unmount();
  }
});

test('a legacy international country selection must be replaced with a real destination', async () => {
  let countryCode = 'INTL';
  const submissions: Array<{ countryCode: string }> = [];
  const onSubmit = async (payload: { countryCode: string }) => { submissions.push(payload); };
  const onCountryCodeChange = (next: string) => { countryCode = next; };
  const view = render(createElement(DeliveryForm, { countryCode, onCountryCodeChange, onSubmit }));
  const countryPicker = view.getByLabelText('Country') as HTMLSelectElement;
  assert.equal(countryPicker.value, '');
  assert.equal(countryPicker.querySelector('option[value="INTL"]'), null);
  fireEvent.submit(view.container.querySelector('form')!);
  assert.equal(submissions.length, 0);
  assert.match(view.container.textContent || '', /Please select a country\./);

  fireEvent.change(countryPicker, { target: { value: 'JM' } });
  assert.equal(countryCode, 'JM');
  view.rerender(createElement(DeliveryForm, { countryCode, onCountryCodeChange, onSubmit }));
  assert.equal(countryPicker.value, 'JM');
  for (const [label, value] of [
    ['Email', 'recipient@example.com'], ['Full name', 'Recipient'], ['Address line 1', '1 Example Street'],
    ['City', 'Kingston'], ['State / Region', 'Kingston'],
  ]) fireEvent.change(view.getByLabelText(label), { target: { value } });
  fireEvent.submit(view.container.querySelector('form')!);
  await waitFor(() => assert.equal(submissions.length, 1));
  assert.equal(submissions[0].countryCode, 'JM');
});

test('delivery form keeps US state and postal requirements when switching destinations', () => {
  const onSubmit = async () => undefined;
  const view = render(createElement(DeliveryForm, { countryCode: 'IE', onSubmit }));
  assert.equal((view.getByLabelText(/^State \/ Region/) as HTMLInputElement).required, false);
  assert.equal((view.getByLabelText(/^Postal code/) as HTMLInputElement).required, false);
  view.rerender(createElement(DeliveryForm, { countryCode: 'US', onSubmit }));
  assert.equal((view.getByLabelText('State / Region') as HTMLInputElement).required, true);
  assert.equal((view.getByLabelText('Postal code') as HTMLInputElement).required, true);
});
