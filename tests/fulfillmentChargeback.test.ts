import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createElement } from 'react';
import { fulfillmentOrderFromRecord } from '../shared/fulfillmentReadModel.ts';
import { FulfillmentOrderTitle } from '../src/fulfillment/FulfillmentOrderTitle.tsx';
import { setupFrontendDom } from './helpers/frontendDom.ts';

setupFrontendDom();

const { cleanup, render } = await import('@testing-library/react');

afterEach(cleanup);

test('fulfillment read model only exposes explicitly enriched Stripe dispute history', () => {
  const fields = { source: 'stripe_offchain', stripeChargeback: true, status: 'ready_to_ship', items: [] };
  const options = { canViewSensitiveAddress: false, decryptAddress: () => null, dropId: 'card_nft_2' };
  const ordinary = fulfillmentOrderFromRecord('1', fields, options);
  assert.equal(ordinary?.stripeChargeback, undefined);
  assert.deepEqual(
    fulfillmentOrderFromRecord('1', fields, { ...options, stripeChargeback: true }),
    { ...ordinary, stripeChargeback: true },
  );
  for (const source of ['admin_irl_redeem', 'onchain', undefined]) {
    assert.equal(
      fulfillmentOrderFromRecord('1', { ...fields, source }, { ...options, stripeChargeback: true })?.stripeChargeback,
      undefined,
    );
  }
});

test('order title labels dispute history accessibly and leaves ordinary orders unlabelled', () => {
  const view = render(createElement('div', null,
    createElement(FulfillmentOrderTitle, { order: { deliveryId: 1, stripeChargeback: true } }),
    createElement(FulfillmentOrderTitle, { order: { deliveryId: 2 } }),
    createElement(FulfillmentOrderTitle, { order: { deliveryId: 3, stripeChargeback: false } }),
  ));
  const badge = view.getByRole('note', { name: /CHARGEBACK: Stripe dispute history/ });
  assert.equal(badge.textContent, 'CHARGEBACK');
  assert.match(badge.getAttribute('title') || '', /preliminary inquiries and resolved disputes/);
  assert.equal(badge.parentElement?.textContent, 'Order 1CHARGEBACK');
  assert.equal(view.getAllByRole('note').length, 1);
  assert.equal(view.getByText('Order 2').parentElement?.textContent, 'Order 2');
  assert.equal(view.queryByRole('button'), null);
});
