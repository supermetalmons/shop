import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createElement } from 'react';
import { FRONTEND_DROPS } from '../src/config/deployment.ts';
import { figureMetadataCacheKey } from '../src/lib/figureMetadata.ts';
import type { FulfillmentOrder } from '../src/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

setupFrontendDom();

const { cleanup, fireEvent, render, within } = await import('@testing-library/react');
const { FulfillmentOrderCard } = await import('../src/fulfillment/FulfillmentOrderCard.tsx');
const { FulfillmentFigureTiles } = await import('../src/fulfillment/FulfillmentMedia.tsx');
type Props = Parameters<typeof FulfillmentOrderCard>[0];
const cardDrop = FRONTEND_DROPS.card_nft_2;

afterEach(cleanup);

function order(overrides: Partial<FulfillmentOrder> = {}): FulfillmentOrder {
  return {
    dropId: cardDrop.dropId,
    deliveryId: 42,
    owner: 'owner-wallet',
    status: 'processed',
    fulfillmentStatus: 'Preparing',
    address: {
      full: 'Ada Example\n123 Main Street\nUS',
      countryCode: 'US',
      email: 'ada@example.com',
      phone: '+1 555 0100',
    },
    boxes: [],
    looseDudes: [],
    ...overrides,
  };
}

function props(overrides: Partial<Props> = {}): Props {
  return {
    order: order(),
    drop: cardDrop,
    figureMetadataByKey: {},
    canAdminEditFulfillmentAddress: true,
    secretCodeDownloadDisabled: false,
    onMetadataResolved: () => undefined,
    onEditAddress: () => undefined,
    onEditStatus: () => undefined,
    onPrintLabel: () => undefined,
    onDownloadSecretCode: () => undefined,
    ...overrides,
  };
}

function figureMetadata(...ids: number[]): Props['figureMetadataByKey'] {
  return Object.fromEntries(ids.map((id) => [
    figureMetadataCacheKey(cardDrop.dropId, id),
    { dropId: cardDrop.dropId, id, name: `Card ${id}`, image: `https://assets.example.com/${id}.png` },
  ]));
}

test('an unknown drop renders no order or actions', () => {
  const view = render(createElement(FulfillmentOrderCard, props({ drop: undefined })));
  assert.equal(view.container.childElementCount, 0);
});

test('grouped orders show shared contact once while retaining each order’s own actions', (t) => {
  const onEditAddress = t.mock.fn<Props['onEditAddress']>();
  const onEditStatus = t.mock.fn<Props['onEditStatus']>();
  const onPrintLabel = t.mock.fn<Props['onPrintLabel']>();
  const first = order();
  const second = order({ deliveryId: 43 });
  const common = props({ onEditAddress, onEditStatus, onPrintLabel });
  const view = render(createElement('div', null,
    createElement(FulfillmentOrderCard, { ...common, order: first }),
    createElement(FulfillmentOrderCard, { ...common, order: second, showContactInfo: false, showFullAddress: false }),
  ));
  assert.equal(view.getAllByText('ada@example.com').length, 1);
  assert.equal(view.getAllByText('+1 555 0100').length, 1);
  assert.equal(view.getAllByText('Ada Example 123 Main Street United States').length, 1);
  fireEvent.click(view.getByRole('button', { name: 'Edit address for order 42' }));
  assert.equal(view.queryByRole('button', { name: 'Edit address for order 43' }), null);
  view.getAllByRole('button', { name: 'Edit status' }).forEach((button) => fireEvent.click(button));
  view.getAllByRole('button', { name: 'Print Label' }).forEach((button) => fireEvent.click(button));
  assert.deepEqual(onEditAddress.mock.calls.map((call) => call.arguments), [[first]]);
  assert.deepEqual(onEditStatus.mock.calls.map((call) => call.arguments), [['card_nft_2:42'], ['card_nft_2:43']]);
  assert.deepEqual(onPrintLabel.mock.calls.map((call) => call.arguments), [['card_nft_2:42'], ['card_nft_2:43']]);
});

test('address editing respects permission, visibility, ShipStation ownership, and IRL redemption', () => {
  const view = render(createElement(FulfillmentOrderCard, props()));
  const blocked: Partial<Props>[] = [
    { canAdminEditFulfillmentAddress: false },
    { showFullAddress: false },
    { showContactInfo: false },
    { order: order({ shipstationShipmentId: 'shipment-42' }) },
    { order: order({ shipstationPurchaseUnknown: true }) },
    { order: order({ shipstationLabel: { labelId: 'label-42', shipmentId: 'shipment-42', status: 'completed' } }) },
    { order: order({ shipstationLabel: { labelId: 'label-42', shipmentId: 'shipment-42', status: 'processing' } }) },
    { order: order({ source: 'admin_irl_redeem' }) },
  ];
  assert.ok(view.getByRole('button', { name: 'Edit address for order 42' }));
  for (const overrides of blocked) {
    view.rerender(createElement(FulfillmentOrderCard, props(overrides)));
    assert.equal(view.queryByRole('button', { name: 'Edit address for order 42' }), null, JSON.stringify(overrides));
  }
  view.rerender(createElement(FulfillmentOrderCard, props({
    order: order({ shipstationLabel: { labelId: 'label-42', shipmentId: 'shipment-42', status: 'voided' } }),
  })));
  assert.ok(view.getByRole('button', { name: 'Edit address for order 42' }));
});

test('redacted contacts remain hidden and unavailable plaintext shows the encrypted address', () => {
  const view = render(createElement(FulfillmentOrderCard, props({
    order: order({ address: { full: '***', email: 'hidden@example.com', phone: 'hidden phone', countryCode: 'US' } }),
    canAdminEditFulfillmentAddress: false,
  })));
  assert.equal(view.queryByText('hidden@example.com'), null);
  assert.equal(view.queryByText('hidden phone'), null);
  assert.ok(view.getByText('United States'));
  view.rerender(createElement(FulfillmentOrderCard, props({ order: order({ address: { encrypted: 'encrypted-payload' } }) })));
  assert.ok(view.getByText('Encrypted address payload'));
  assert.ok(view.getByText('encrypted-payload'));
});

test('label printing stays available for existing ShipStation shipments but never IRL orders', () => {
  const view = render(createElement(FulfillmentOrderCard, props()));
  assert.ok(view.getByRole('button', { name: 'Print Label' }));
  view.rerender(createElement(FulfillmentOrderCard, props({ order: order({ fulfillmentStatus: 'Shipped' }) })));
  assert.equal(view.queryByRole('button', { name: 'Print Label' }), null);
  view.rerender(createElement(FulfillmentOrderCard, props({
    order: order({ fulfillmentStatus: 'Shipped', shipstationShipmentId: 'shipment-42' }),
  })));
  assert.ok(view.getByRole('button', { name: 'Print Label' }));
  view.rerender(createElement(FulfillmentOrderCard, props({
    order: order({ source: 'admin_irl_redeem', shipstationShipmentId: 'shipment-42' }),
  })));
  assert.equal(view.queryByRole('button', { name: 'Print Label' }), null);
});

test('only shipped orders expose tracking, with HTTPS links and plain tracking identifiers', () => {
  const tracked = order({ fulfillmentTrackingCode: '  https://tracking.example.com/42  ' });
  const view = render(createElement(FulfillmentOrderCard, props({ order: tracked })));
  assert.equal(view.queryByRole('link', { name: 'Tracking' }), null);
  view.rerender(createElement(FulfillmentOrderCard, props({ order: { ...tracked, fulfillmentStatus: 'Shipped' } })));
  const link = view.getByRole('link', { name: 'Tracking' });
  assert.equal(link.getAttribute('href'), 'https://tracking.example.com/42');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  view.rerender(createElement(FulfillmentOrderCard, props({
    order: order({ fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: '  TRACK-42  ' }),
  })));
  assert.ok(view.getByText('TRACK-42'));
  assert.equal(view.queryByRole('link', { name: 'Tracking' }), null);
  view.rerender(createElement(FulfillmentOrderCard, props({ order: order({ fulfillmentStatus: undefined }) })));
  assert.ok(view.getByText('Not set'));
  assert.ok(view.getByRole('button', { name: 'Set status' }));
});

test('pack and card downloads retain original indices while used codes and duplicate claims remain correctly displayed', (t) => {
  const onDownloadSecretCode = t.mock.fn<Props['onDownloadSecretCode']>();
  const current = order({
    boxes: [
      { boxId: 11, receiptClaimCode: 'USED-PACK', receiptClaimStatus: 'claimed', dudeIds: [101] },
      { boxId: 12, receiptClaimCode: ' PACK-SECRET ', claimCode: 'OLD-CODE', dudeIds: [102] },
      { boxId: 13, dudeIds: [] },
    ],
    cardClaims: [
      { figureId: 103, receiptClaimCode: 'PROCESSING-CARD', receiptClaimStatus: 'processing' },
      { figureId: 104, receiptClaimCode: ' CARD-SECRET ', receiptClaimStatus: 'unclaimed' },
      { figureId: 105, receiptClaimCode: '' },
    ],
    looseDudes: [103, 104, 106],
  });
  const inputs = props({ order: current, figureMetadataByKey: figureMetadata(101, 102, 103, 104, 105, 106), onDownloadSecretCode });
  const view = render(createElement(FulfillmentOrderCard, inputs));
  assert.equal(view.queryByRole('button', { name: 'Download PNG for secret code USED-PACK' }), null);
  assert.equal(view.queryByRole('button', { name: 'Download PNG for secret code PROCESSING-CARD' }), null);
  assert.ok(view.getByText('USED-PACK').classList.contains('fulfillment-secret-code--used'));
  assert.ok(view.getByText('PROCESSING-CARD').classList.contains('fulfillment-secret-code--used'));
  assert.equal(view.queryByText('OLD-CODE'), null);
  assert.equal(view.getAllByText('Secret code unavailable').length, 2);
  assert.equal(view.getAllByRole('img', { name: 'Card 103' }).length, 1);
  assert.equal(view.getAllByRole('img', { name: 'Card 104' }).length, 1);
  assert.ok(view.getByRole('img', { name: 'Card 106' }));
  const packImage = view.container.querySelector('.box-contents .fulfillment-pack-secret-image');
  assert.ok(packImage);
  assert.equal(packImage.getAttribute('aria-hidden'), 'true');
  fireEvent.click(view.getByRole('button', { name: 'Download PNG for secret code PACK-SECRET' }));
  fireEvent.click(view.getByRole('button', { name: 'Download PNG for secret code CARD-SECRET' }));
  assert.deepEqual(onDownloadSecretCode.mock.calls.map((call) => call.arguments), [
    [current, { kind: 'box', index: 1 }],
    [current, { kind: 'card-claim', index: 1 }],
  ]);
  view.rerender(createElement(FulfillmentOrderCard, { ...inputs, secretCodeDownloadDisabled: true }));
  for (const button of view.getAllByRole('button', { name: /^Download PNG/ })) {
    assert.equal((button as HTMLButtonElement).disabled, true);
    fireEvent.click(button);
  }
  assert.equal(onDownloadSecretCode.mock.callCount(), 2);
});

test('direct-delivery boxes render product tiles and preserve code status and download targets', (t) => {
  const drop = FRONTEND_DROPS.card_nft_binder;
  const current = order({
    dropId: drop.dropId,
    boxes: [
      { boxId: 7, claimCode: 'USED-BINDER', receiptClaimStatus: 'processing', dudeIds: [] },
      { boxId: 8, claimCode: 'BINDER-SECRET', dudeIds: [] },
    ],
  });
  const onDownloadSecretCode = t.mock.fn<Props['onDownloadSecretCode']>();
  const view = render(createElement(FulfillmentOrderCard, props({ drop, order: current, onDownloadSecretCode })));
  assert.equal(view.container.querySelector('.box-contents'), null);
  const tiles = view.container.querySelectorAll('.figure-tile');
  assert.equal(tiles.length, 2);
  assert.ok(within(tiles[0] as HTMLElement).getByRole('img', { name: /binder.*7/i }));
  assert.ok(within(tiles[1] as HTMLElement).getByRole('img', { name: /binder.*8/i }));
  assert.equal(view.queryByRole('button', { name: 'Download PNG for secret code USED-BINDER' }), null);
  fireEvent.click(view.getByRole('button', { name: 'Download PNG for secret code BINDER-SECRET' }));
  assert.deepEqual(onDownloadSecretCode.mock.calls[0].arguments, [current, { kind: 'box', index: 1 }]);
});

test('shared figure tiles support duplicate summaries without replacing image descriptions', () => {
  const view = render(createElement(FulfillmentFigureTiles, {
    drop: cardDrop,
    dropId: cardDrop.dropId,
    figureIds: [101, 102],
    keyPrefix: 'duplicates',
    previewMode: 'metadata_stills',
    figureMetadataByKey: figureMetadata(101, 102),
    labelOverride: ({ figureId, index }) => `${figureId} x ${index + 2}`,
  }));
  assert.ok(view.getByText('101 x 2'));
  assert.ok(view.getByText('102 x 3'));
  assert.equal(view.getByRole('img', { name: 'Card 101' }).getAttribute('src'), 'https://assets.example.com/101.png');
  assert.equal(view.getByRole('img', { name: 'Card 102' }).getAttribute('src'), 'https://assets.example.com/102.png');
});
