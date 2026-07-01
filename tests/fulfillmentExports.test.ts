import test from 'node:test';
import assert from 'node:assert/strict';
import { FRONTEND_DROPS } from '../src/config/deployment.ts';
import {
  buildFulfillmentAddressExport,
  buildFulfillmentExportFilename,
  buildFulfillmentOrdersExport,
  buildFulfillmentSecretCodeExportEntry,
  buildFulfillmentSecretCodeExportEntries,
} from '../src/lib/fulfillmentExports.ts';
import { normalizeBoxDisplayImage } from '../src/lib/dropContent.ts';
import { figureMetadataCacheKey } from '../src/lib/figureMetadata.ts';
import type { FulfillmentOrder } from '../src/types.ts';

const cardDrop = FRONTEND_DROPS.card_nft_2;
const littleSwagBoxesDrop = FRONTEND_DROPS.little_swag_boxes;
const hoodieDrop = FRONTEND_DROPS.little_swag_hoodies;
const dropById = new Map([
  [cardDrop.dropId, cardDrop],
  [littleSwagBoxesDrop.dropId, littleSwagBoxesDrop],
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
      country: 'United States',
      boxes: [
        {
          secretCode: 'PACK-SECRET-1',
          style: 'yellow',
          figures: [11133, 11134],
        },
      ],
      looseFigures: [42],
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
  assert.doesNotMatch(serialized, /fulfillmentStatus/);
  assert.doesNotMatch(serialized, /countryCode/);
  assert.doesNotMatch(serialized, /deliveryId/);
  assert.doesNotMatch(serialized, /dropId/);
  assert.doesNotMatch(serialized, /boxId/);
  assert.doesNotMatch(serialized, /label/);
});

test('buildFulfillmentOrdersExport keeps direct-delivery box secrets without hidden assigned figures', () => {
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
      country: 'Turkey',
      boxes: [
        {
          secretCode: 'HOODIE-SECRET',
          variant: 'XL',
        },
      ],
    },
  ]);
  assert.equal('email' in payload[0], false);
  assert.equal('phone' in payload[0], false);
  assert.equal('looseFigures' in payload[0], false);
  const directDeliveryBox = payload[0].boxes?.[0];
  assert.ok(directDeliveryBox);
  assert.equal('figures' in directDeliveryBox, false);

  const standardBox = buildFulfillmentOrdersExport([cardOrder()], { dropById })[0].boxes?.[0];
  assert.ok(standardBox);
  assert.equal('variant' in standardBox, false);
  assert.equal('style' in directDeliveryBox, false);
});

test('buildFulfillmentOrdersExport omits empty boxes and loose figure fields', () => {
  const payload = buildFulfillmentOrdersExport(
    [
      cardOrder({
        boxes: [],
        looseDudes: [],
      }),
    ],
    { dropById },
  );

  assert.deepEqual(payload, [
    {
      orderId: 'card_nft_2:7',
      country: 'United States',
    },
  ]);
});

test('buildFulfillmentOrdersExport exports numeric fulfillment labels for figures', () => {
  const payload = buildFulfillmentOrdersExport(
    [
      cardOrder({
        dropId: littleSwagBoxesDrop.dropId,
        boxes: [
          {
            boxId: 11,
            claimCode: 'LSB-SECRET-1',
            assetId: 'asset-11',
            dudeIds: [344, 353],
          },
        ],
        looseDudes: [360],
      }),
    ],
    { dropById },
  );

  const box = payload[0].boxes?.[0];
  assert.ok(box);
  assert.deepEqual(box.figures, [1, 90]);
  assert.equal('style' in box, false);
  assert.deepEqual(payload[0].looseFigures, [3]);
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

test('buildFulfillmentSecretCodeExportEntries maps box secret codes to png jobs', () => {
  const entries = buildFulfillmentSecretCodeExportEntries([
    cardOrder({
      boxes: [
        {
          boxId: 11,
          claimCode: 'legacy-code',
          receiptClaimCode: 'PACK-SECRET-1',
          dudeIds: [],
        },
        {
          boxId: 12,
          claimCode: 'A/B C',
          dudeIds: [],
        },
      ],
    }),
  ]);

  assert.deepEqual(entries, [
    {
      orderId: 'card_nft_2:7',
      boxId: 11,
      boxIndex: 0,
      secretCode: 'PACK-SECRET-1',
      claimUrl: 'https://mons.shop/claim/?code=PACK-SECRET-1',
      filename: '7-1.png',
    },
    {
      orderId: 'card_nft_2:7',
      boxId: 12,
      boxIndex: 1,
      secretCode: 'A/B C',
      claimUrl: 'https://mons.shop/claim/?code=A%2FB%20C',
      filename: '7-2.png',
    },
  ]);
});

test('buildFulfillmentSecretCodeExportEntry maps one box secret code to a png job', () => {
  const order = cardOrder({
    boxes: [
      { boxId: 11, receiptClaimCode: '   ', claimCode: '   ', dudeIds: [] },
      { boxId: 12, receiptClaimCode: 'FIRST-SECRET', dudeIds: [] },
      { boxId: 13, receiptClaimCode: 'SECOND-SECRET', dudeIds: [] },
    ],
  });

  assert.deepEqual(buildFulfillmentSecretCodeExportEntry({ order, boxIndex: 2 }), {
    orderId: 'card_nft_2:7',
    boxId: 13,
    boxIndex: 2,
    secretCode: 'SECOND-SECRET',
    claimUrl: 'https://mons.shop/claim/?code=SECOND-SECRET',
    filename: '7-2.png',
  });
});

test('buildFulfillmentSecretCodeExportEntries adds direct-delivery box preview images', () => {
  const previewSrc = normalizeBoxDisplayImage({ dropId: hoodieDrop.dropId, boxId: 16 });
  assert.ok(previewSrc);

  const entries = buildFulfillmentSecretCodeExportEntries(
    [
      cardOrder({
        dropId: hoodieDrop.dropId,
        deliveryId: 8,
        boxes: [{ boxId: 16, claimCode: 'HOODIE-SECRET', dudeIds: [99] }],
        looseDudes: [],
      }),
    ],
    { dropById },
  );

  assert.deepEqual(entries[0].previewImages, [{ src: previewSrc }]);
});

test('buildFulfillmentSecretCodeExportEntries maps pack item ids to fulfillment media previews', () => {
  const entries = buildFulfillmentSecretCodeExportEntries(
    [
      cardOrder({
        dropId: littleSwagBoxesDrop.dropId,
        boxes: [
          {
            boxId: 11,
            receiptClaimCode: 'LSB-SECRET-1',
            dudeIds: [344, 353, 360],
          },
        ],
        looseDudes: [],
      }),
    ],
    { dropById },
  );

  assert.deepEqual(entries[0].previewImages, [
    { src: 'https://assets.mons.link/drops/lsb/figures/clean/1.webp' },
    { src: 'https://assets.mons.link/drops/lsb/figures/clean/90.webp' },
    { src: 'https://assets.mons.link/drops/lsb/figures/clean/3.webp' },
  ]);
});

test('buildFulfillmentSecretCodeExportEntries uses metadata-backed card preview images', () => {
  const figureMetadataByKey = {
    [figureMetadataCacheKey(cardDrop.dropId, 101)]: {
      dropId: cardDrop.dropId,
      id: 101,
      image: 'https://assets.example.com/card-101.webp',
    },
    [figureMetadataCacheKey(cardDrop.dropId, 102)]: {
      dropId: cardDrop.dropId,
      id: 102,
      image: 'https://assets.example.com/card-102.webp',
    },
  };

  const entries = buildFulfillmentSecretCodeExportEntries(
    [
      cardOrder({
        boxes: [
          {
            boxId: 11,
            receiptClaimCode: 'PACK-SECRET-1',
            dudeIds: [101, 102],
          },
        ],
        looseDudes: [],
      }),
    ],
    { dropById, figureMetadataByKey },
  );

  assert.deepEqual(entries[0].previewImages, [
    { src: 'https://assets.example.com/card-101.webp' },
    { src: 'https://assets.example.com/card-102.webp' },
  ]);
});

test('buildFulfillmentSecretCodeExportEntries requires metadata-backed card preview images when export options are provided', () => {
  assert.throws(
    () =>
      buildFulfillmentSecretCodeExportEntries(
        [
          cardOrder({
            boxes: [
              {
                boxId: 11,
                receiptClaimCode: 'PACK-SECRET-1',
                dudeIds: [101],
              },
            ],
            looseDudes: [],
          }),
        ],
        { dropById },
      ),
    /Missing figure preview image/,
  );
});

test('buildFulfillmentSecretCodeExportEntries omits blank codes and numbers nonblank codes within each order', () => {
  const entries = buildFulfillmentSecretCodeExportEntries([
    cardOrder({
      boxes: [
        { boxId: 11, receiptClaimCode: '   ', claimCode: '   ', dudeIds: [] },
        { boxId: 12, receiptClaimCode: 'SAME-SECRET', dudeIds: [] },
        { boxId: 12, receiptClaimCode: 'SAME-SECRET', dudeIds: [] },
      ],
    }),
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.filename),
    ['7-1.png', '7-2.png'],
  );
  assert.deepEqual(entries.map((entry) => entry.secretCode), ['SAME-SECRET', 'SAME-SECRET']);
});

test('buildFulfillmentSecretCodeExportEntries keeps duplicate order-number filenames unique', () => {
  const entries = buildFulfillmentSecretCodeExportEntries([
    cardOrder({ boxes: [{ boxId: 11, receiptClaimCode: 'FIRST', dudeIds: [] }] }),
    cardOrder({ boxes: [{ boxId: 12, receiptClaimCode: 'SECOND', dudeIds: [] }] }),
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.filename),
    ['7-1.png', '7-1-2.png'],
  );
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

  assert.equal(
    buildFulfillmentExportFilename({
      kind: 'secret-codes',
      selectedDropId: 'little_swag_hoodies',
      orderVisibilityFilter: 'not_shipped',
      now: new Date('2026-06-19T12:00:00Z'),
    }),
    'secret-codes-little-swag-hoodies-not-shipped-2026-06-19.zip',
  );
});
