import test from 'node:test';
import assert from 'node:assert/strict';
import { FRONTEND_DROPS } from '../src/config/deployment.ts';
import {
  buildFulfillmentAddressExport,
  buildFulfillmentExportFilename,
  buildFulfillmentOrdersExport,
} from '../src/lib/fulfillmentExports.ts';
import type { FulfillmentOrder } from '../src/types.ts';

const cardDrop = FRONTEND_DROPS.card_nft_2;
const hoodieDrop = FRONTEND_DROPS.little_swag_hoodies;
const dropById = new Map([
  [cardDrop.dropId, cardDrop],
  [hoodieDrop.dropId, hoodieDrop],
]);

function cardOrder(overrides?: Partial<FulfillmentOrder>): FulfillmentOrder {
  return {
    dropId: cardDrop.dropId,
    deliveryId: 7,
    owner: 'owner-wallet',
    status: 'ready_to_ship',
    processedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    fulfillmentStatus: 'Preparing',
    fulfillmentInternalStatus: 'internal-note',
    fulfillmentUpdatedAt: Date.UTC(2026, 0, 3),
    address: {
      full: 'Ada Lovelace\n123 Main St\nUS',
      email: 'ada@example.com',
      phone: '+1 555 0100',
      country: 'US',
      countryCode: 'US',
      encrypted: 'cipher-text',
      hint: 'A...US',
      label: 'home',
    },
    boxes: [
      {
        boxId: 11,
        claimCode: 'legacy-code',
        receiptClaimCode: 'PACK-SECRET-1',
        receiptClaimStatus: 'unclaimed',
        assetId: 'asset-11',
        dudeIds: [11133, 11134],
      },
    ],
    looseDudes: [42],
    ...overrides,
  };
}

test('buildFulfillmentOrdersExport keeps fulfillment-visible data without address internals', () => {
  const payload = buildFulfillmentOrdersExport([cardOrder()], { dropById });

  assert.deepEqual(payload, [
    {
      orderId: 'card_nft_2:7',
      dropId: 'card_nft_2',
      deliveryId: 7,
      date: '2026-01-02T03:04:05.000Z',
      fulfillmentStatus: 'Preparing',
      country: 'United States',
      countryCode: 'US',
      boxes: [
        {
          boxId: 11,
          label: 'Pack Secret PACK-SECRET-1',
          secretCode: 'PACK-SECRET-1',
          assignedFigures: [
            { figureId: 11133, label: '11133' },
            { figureId: 11134, label: '11134' },
          ],
        },
      ],
      looseFigures: [{ figureId: 42, label: '42' }],
    },
  ]);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /123 Main St/);
  assert.doesNotMatch(serialized, /ada@example.com/);
  assert.doesNotMatch(serialized, /\+1 555 0100/);
  assert.doesNotMatch(serialized, /cipher-text/);
  assert.doesNotMatch(serialized, /A\.\.\.US/);
  assert.doesNotMatch(serialized, /owner-wallet/);
  assert.doesNotMatch(serialized, /ready_to_ship/);
  assert.doesNotMatch(serialized, /internal-note/);
});

test('buildFulfillmentOrdersExport mirrors direct-delivery box labels without hidden assigned figures', () => {
  const payload = buildFulfillmentOrdersExport(
    [
      cardOrder({
        dropId: hoodieDrop.dropId,
        deliveryId: 8,
        fulfillmentStatus: undefined,
        address: { full: '***', email: 'hidden@example.com', phone: '+90 555 0100', countryCode: 'TR' },
        boxes: [{ boxId: 16, claimCode: 'HOODIE-SECRET', dudeIds: [99] }],
        looseDudes: [],
      }),
    ],
    { dropById },
  );

  assert.deepEqual(payload, [
    {
      orderId: 'little_swag_hoodies:8',
      dropId: 'little_swag_hoodies',
      deliveryId: 8,
      date: '2026-01-02T03:04:05.000Z',
      fulfillmentStatus: null,
      country: 'Turkey',
      countryCode: 'TR',
      boxes: [
        {
          boxId: 16,
          label: 'XL',
          secretCode: 'HOODIE-SECRET',
        },
      ],
      looseFigures: [],
    },
  ]);
  assert.equal('email' in payload[0], false);
  assert.equal('phone' in payload[0], false);
  assert.equal('assignedFigures' in payload[0].boxes[0], false);
});

test('buildFulfillmentAddressExport maps unique order ids to sensitive address contact entries', () => {
  const sensitivePayload = buildFulfillmentAddressExport([
    cardOrder(),
    cardOrder({
      dropId: hoodieDrop.dropId,
      deliveryId: 7,
      address: { full: '***', countryCode: 'TR', encrypted: 'hidden-cipher' },
      boxes: [],
      looseDudes: [],
    }),
    cardOrder({
      deliveryId: 9,
      address: { encrypted: 'cipher-without-full', countryCode: 'US' },
      boxes: [],
      looseDudes: [],
    }),
  ]);

  assert.deepEqual(sensitivePayload, {
    'card_nft_2:7': {
      address: ['Ada Lovelace', '123 Main St', 'United States'],
      email: 'ada@example.com',
      phone: '+1 555 0100',
    },
    'little_swag_hoodies:7': { address: null },
    'card_nft_2:9': { address: null },
  });
  assert.doesNotMatch(JSON.stringify(sensitivePayload), /\\n/);
});

test('buildFulfillmentExportFilename includes kind, selection, status, and date', () => {
  assert.equal(
    buildFulfillmentExportFilename({
      kind: 'orders',
      selectedDropId: 'card_nft_2',
      orderVisibilityFilter: 'all',
      now: new Date('2026-06-19T12:00:00Z'),
    }),
    'orders-card-nft-2-all-2026-06-19.json',
  );

  assert.equal(
    buildFulfillmentExportFilename({
      kind: 'addresses-sensitive',
      selectedDropId: '',
      orderVisibilityFilter: 'not_shipped',
      now: new Date('2026-06-19T12:00:00Z'),
    }),
    'addresses-SENSITIVE-all-drops-not-shipped-2026-06-19.json',
  );
});
