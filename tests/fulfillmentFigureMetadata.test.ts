import test from 'node:test';
import assert from 'node:assert/strict';
import { getFrontendDrop, type FrontendDeploymentConfig } from '../src/config/deployment.ts';
import {
  collectFulfillmentFigureMetadataTargets,
  mergeFigureMetadataRecords,
} from '../src/fulfillment/figureMetadata.ts';
import {
  figureMetadataCacheKey,
  loadFigureMetadata,
  type FigureMetadataRecord,
} from '../src/lib/figureMetadata.ts';

function frontendDrop(dropId: string): FrontendDeploymentConfig {
  const drop = getFrontendDrop(dropId);
  assert.ok(drop);
  return drop;
}

test('figure metadata targets dedupe fallback IDs and skip rendered, mapped, direct-delivery, and invalid figures', () => {
  const cardDrop = frontendDrop('card_nft_2');
  const mappedDrop = frontendDrop('little_swag_boxes');
  const directDeliveryDrop = frontendDrop('drifella_shirt');
  const renderedKey = figureMetadataCacheKey(cardDrop.dropId, 2);
  const retryKey = figureMetadataCacheKey(cardDrop.dropId, 3);

  const targets = collectFulfillmentFigureMetadataTargets({
    entries: [
      { drop: cardDrop, figureIds: [2, 3, 3, 0, -1, Number.NaN] },
      { drop: mappedDrop, figureIds: [4] },
      { drop: directDeliveryDrop, figureIds: [5] },
    ],
    figureMetadataByKey: {
      [renderedKey]: { dropId: cardDrop.dropId, id: 2, image: 'https://example.com/2.webp' },
      [retryKey]: { dropId: cardDrop.dropId, id: 3, name: 'Missing image' },
    },
  });

  assert.deepEqual(targets, [{ dropId: 'card_nft_2', figureId: 3 }]);
});

test('figure metadata target collection falls back to the shared metadata cache', async () => {
  const drop = frontendDrop('card_nft_2');
  const figureId = 4_777;
  const cached = await loadFigureMetadata(drop.dropId, figureId);
  assert.ok(cached?.image);

  assert.deepEqual(
    collectFulfillmentFigureMetadataTargets({
      entries: [{ drop, figureIds: [figureId] }],
      figureMetadataByKey: {},
    }),
    [],
  );
});

test('figure metadata merging preserves identity for identical rendered records and replaces stale entries', () => {
  const attributes = [{ trait_type: 'Color', value: 'Blue' }];
  const existing: FigureMetadataRecord = {
    dropId: 'card_nft_2',
    id: 7,
    name: 'Seven',
    image: 'https://example.com/7.webp',
    attributes,
  };
  const existingKey = figureMetadataCacheKey(existing.dropId, existing.id);
  const prev = { [existingKey]: existing };

  const unchanged = mergeFigureMetadataRecords(prev, [{ ...existing, attributes }]);
  assert.equal(unchanged, prev);

  const replacement: FigureMetadataRecord = {
    dropId: 'card_nft_2',
    id: 7,
    name: 'Seven updated',
    image: 'https://example.com/7-new.webp',
  };
  const added: FigureMetadataRecord = {
    dropId: 'card_nft_2',
    id: 8,
    image: 'https://example.com/8.webp',
  };
  const merged = mergeFigureMetadataRecords(prev, [replacement, added]);

  assert.notEqual(merged, prev);
  assert.equal(prev[existingKey], existing);
  assert.equal(merged[existingKey], replacement);
  assert.equal(merged[figureMetadataCacheKey(added.dropId, added.id)], added);
});
