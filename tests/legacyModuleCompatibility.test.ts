import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CARD_NFT_2_BOX_MEDIA,
  CARD_NFT_2_PACK_MEDIA as frontendCardNft2PackMedia,
  CARD_NFT_2_PACK_RECEIPT_MEDIA,
  LITTLE_SWAG_HOODIE_CDN_BASE_URL as frontendLittleSwagHoodieCdnBaseUrl,
} from '../src/config/dropMediaDefaults.ts';
import * as frontendMetadataUri from '../src/lib/dropMetadataUri.ts';
import * as frontendCardNft2Assets from '../src/lib/cardNft2Assets.ts';
import { normalizeCountryCode as frontendNormalizeCountryCode } from '../src/lib/solana.ts';
import {
  CARD_NFT_2_PACK_MEDIA as sharedCardNft2PackMedia,
  LITTLE_SWAG_HOODIE_CDN_BASE_URL as sharedLittleSwagHoodieCdnBaseUrl,
} from '../functions/src/shared/dropMediaDefaults.ts';
import * as functionsMetadataUri from '../functions/src/dropMetadataUri.ts';
import * as sharedCardNft2AssetCore from '../functions/src/shared/cardNft2AssetCore.ts';
import * as sharedCardNft2Assets from '../functions/src/shared/cardNft2Assets.ts';
import * as sharedMetadataUri from '../functions/src/shared/dropMetadataUri.ts';
import { normalizeCountryCode as sharedNormalizeCountryCode } from '../functions/src/shared/countryNormalization.ts';
import type { CardNft2AssetKind as FrontendCardNft2AssetKind } from '../src/lib/cardNft2Assets.ts';
import type { CardNft2AssetKind as SharedCardNft2AssetCoreKind } from '../functions/src/shared/cardNft2AssetCore.ts';
import type { PackStatusBreakdownItem as FrontendPackStatusBreakdownItem } from '../src/types.ts';
import type { DropMetadataAssetKind as FrontendDropMetadataAssetKind } from '../src/lib/dropMetadataUri.ts';
import type { FulfillmentStatus as FunctionsFulfillmentStatus } from '../functions/src/fulfillmentStatus.ts';
import type {
  PackStatusBreakdown as FunctionsPackStatusBreakdown,
  PackStatusRebuildInputs as FunctionsPackStatusRebuildInputs,
} from '../functions/src/packStatus.ts';
import type { CardNft2AssetKind as SharedCardNft2AssetKind } from '../functions/src/shared/cardNft2Assets.ts';
import type {
  PackStatusBreakdown as SharedPackStatusBreakdown,
  PackStatusBreakdownItem as SharedPackStatusBreakdownItem,
} from '../functions/src/shared/contracts.ts';
import type { DropMetadataAssetKind as FunctionsDropMetadataAssetKind } from '../functions/src/dropMetadataUri.ts';
import type { FulfillmentStatus as SharedFulfillmentStatus } from '../functions/src/shared/fulfillmentStatus.ts';
import type { DropMetadataAssetKind as SharedDropMetadataAssetKind } from '../functions/src/shared/dropMetadataUri.ts';
import type { PackStatusRebuildInputs as SharedPackStatusRebuildInputs } from '../functions/src/shared/packStatus.ts';
import type {
  FrontendDropConfigSerialized,
  FunctionsDropConfigSerialized,
} from '../scripts/shared/deploymentRegistry.ts';

const VALID_IPFS_CID = 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const METADATA_RUNTIME_EXPORTS = [
  'boxIdFromMetadataUri',
  'canonicalMetadataBase',
  'dudeIdFromMetadataUri',
  'metadataBaseFromMetadataUri',
  'metadataKindFromUri',
  'selectMetadataUri',
] as const;
const CARD_NFT_2_ASSET_CORE_RUNTIME_EXPORTS = [
  'CARD_NFT_2_ASSET_CDN_BASES',
  'CARD_NFT_2_MAX_CARD_ID',
  'cardNft2AssetUrl',
  'normalizeCardNft2CardId',
] as const;
const CARD_NFT_2_ASSET_AGGREGATE_RUNTIME_EXPORTS = [
  ...CARD_NFT_2_ASSET_CORE_RUNTIME_EXPORTS,
  'CARD_NFT_2_COMMON_CARD_IDS',
  'isCardNft2CommonCardId',
] as const;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

const TYPE_COMPATIBILITY: [
  Equal<FrontendCardNft2AssetKind, SharedCardNft2AssetKind>,
  Equal<SharedCardNft2AssetKind, SharedCardNft2AssetCoreKind>,
  Equal<FrontendPackStatusBreakdownItem, SharedPackStatusBreakdownItem>,
  Equal<FrontendDropMetadataAssetKind, SharedDropMetadataAssetKind>,
  Equal<FunctionsDropMetadataAssetKind, SharedDropMetadataAssetKind>,
  Equal<FunctionsFulfillmentStatus, SharedFulfillmentStatus>,
  Equal<FunctionsPackStatusBreakdown, SharedPackStatusBreakdown>,
  Equal<FunctionsPackStatusRebuildInputs, SharedPackStatusRebuildInputs>,
  FunctionsDropConfigSerialized extends FrontendDropConfigSerialized
    ? true
    : false,
] = [true, true, true, true, true, true, true, true, true];

test('legacy module paths preserve their complete runtime and type surfaces', () => {
  assert.deepEqual(TYPE_COMPATIBILITY, [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
  assert.deepEqual(Object.keys(frontendMetadataUri).sort(), [...METADATA_RUNTIME_EXPORTS].sort());
  assert.deepEqual(Object.keys(functionsMetadataUri).sort(), [...METADATA_RUNTIME_EXPORTS].sort());
  assert.deepEqual(
    Object.keys(sharedCardNft2AssetCore).sort(),
    [...CARD_NFT_2_ASSET_CORE_RUNTIME_EXPORTS].sort(),
  );
  assert.deepEqual(
    Object.keys(sharedCardNft2Assets).sort(),
    [...CARD_NFT_2_ASSET_AGGREGATE_RUNTIME_EXPORTS].sort(),
  );
  assert.deepEqual(
    Object.keys(frontendCardNft2Assets).sort(),
    [...CARD_NFT_2_ASSET_AGGREGATE_RUNTIME_EXPORTS].sort(),
  );

  for (const exportName of METADATA_RUNTIME_EXPORTS) {
    assert.equal(frontendMetadataUri[exportName], sharedMetadataUri[exportName]);
    assert.equal(functionsMetadataUri[exportName], sharedMetadataUri[exportName]);
  }
  for (const exportName of CARD_NFT_2_ASSET_CORE_RUNTIME_EXPORTS) {
    assert.equal(sharedCardNft2Assets[exportName], sharedCardNft2AssetCore[exportName]);
    assert.equal(frontendCardNft2Assets[exportName], sharedCardNft2AssetCore[exportName]);
  }
  assert.equal(
    frontendCardNft2Assets.CARD_NFT_2_COMMON_CARD_IDS,
    sharedCardNft2Assets.CARD_NFT_2_COMMON_CARD_IDS,
  );
  assert.equal(
    frontendCardNft2Assets.isCardNft2CommonCardId,
    sharedCardNft2Assets.isCardNft2CommonCardId,
  );

  assert.equal(frontendNormalizeCountryCode, sharedNormalizeCountryCode);
  assert.equal(frontendNormalizeCountryCode('United States of America'), 'US');

  assert.equal(frontendCardNft2PackMedia, sharedCardNft2PackMedia);
  assert.equal(frontendCardNft2PackMedia, CARD_NFT_2_PACK_RECEIPT_MEDIA);
  assert.equal(frontendCardNft2PackMedia, CARD_NFT_2_BOX_MEDIA);
  assert.deepEqual(frontendCardNft2PackMedia, { strategy: 'cyclic', count: 4 });

  assert.equal(frontendLittleSwagHoodieCdnBaseUrl, sharedLittleSwagHoodieCdnBaseUrl);
  assert.equal(frontendLittleSwagHoodieCdnBaseUrl, 'https://cdn.lil.org/nft/little_swag_hoodie');
});

test('card asset core and core-only Functions consumers stay catalog-free', async () => {
  const [coreSource, orderEmailItemsSource, revealIdsSource] = await Promise.all([
    readFile(new URL('../functions/src/shared/cardNft2AssetCore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../functions/src/orderEmailItems.ts', import.meta.url), 'utf8'),
    readFile(new URL('../functions/src/cardNft2RevealIds.ts', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(coreSource, /cardNft2CommonIds|cardNft2Assets/);
  for (const source of [orderEmailItemsSource, revealIdsSource]) {
    assert.match(source, /shared\/cardNft2AssetCore\.js/);
    assert.doesNotMatch(source, /shared\/cardNft2Assets\.js/);
  }
});

test('metadata URI compatibility covers legacy, compact, receipt, collection, query, and fragment forms', () => {
  const legacyBoxUri = 'https://assets.example.com/drops/alpha/json/boxes/12.json?download=1#preview';
  const legacyFigureUri = 'https://assets.example.com/drops/alpha/json/figures/34.json#card';
  const compactFigureUri = `ipfs://${VALID_IPFS_CID}/f56.json?download=1`;
  const compactBoxReceiptUri = `ipfs://${VALID_IPFS_CID}/rbclaim-7.json#receipt`;
  const compactFigureReceiptUri = `ipfs://${VALID_IPFS_CID}/rf89.json?download=1#receipt`;
  const collectionUri = `ipfs://${VALID_IPFS_CID}/collection.json?download=1#collection`;
  const gatewayFigureUri = `https://nftstorage.link/ipfs/${VALID_IPFS_CID}/f56.json?download=1#preview`;

  assert.equal(sharedMetadataUri.metadataKindFromUri(legacyBoxUri), 'box');
  assert.equal(sharedMetadataUri.metadataKindFromUri(legacyFigureUri), 'dude');
  assert.equal(sharedMetadataUri.metadataKindFromUri(compactFigureUri), 'dude');
  assert.equal(sharedMetadataUri.metadataKindFromUri(compactBoxReceiptUri), 'certificate');
  assert.equal(sharedMetadataUri.metadataKindFromUri(compactFigureReceiptUri), 'certificate');

  assert.equal(sharedMetadataUri.boxIdFromMetadataUri(legacyBoxUri), '12');
  assert.equal(sharedMetadataUri.boxIdFromMetadataUri(compactBoxReceiptUri), 'claim-7');
  assert.equal(sharedMetadataUri.dudeIdFromMetadataUri(legacyFigureUri), 34);
  assert.equal(sharedMetadataUri.dudeIdFromMetadataUri(compactFigureReceiptUri), 89);

  assert.equal(
    sharedMetadataUri.metadataBaseFromMetadataUri(legacyBoxUri),
    'https://assets.example.com/drops/alpha',
  );
  assert.equal(
    sharedMetadataUri.metadataBaseFromMetadataUri(compactFigureUri),
    `ipfs://${VALID_IPFS_CID}`,
  );
  assert.equal(
    sharedMetadataUri.metadataBaseFromMetadataUri(compactBoxReceiptUri),
    `ipfs://${VALID_IPFS_CID}`,
  );
  assert.equal(
    sharedMetadataUri.metadataBaseFromMetadataUri(collectionUri),
    `ipfs://${VALID_IPFS_CID}`,
  );
  assert.equal(sharedMetadataUri.metadataBaseFromMetadataUri('https://assets.example.com/preview.webp'), null);

  assert.equal(
    sharedMetadataUri.canonicalMetadataBase(`https://nftstorage.link/ipfs/${VALID_IPFS_CID}/`),
    `ipfs://${VALID_IPFS_CID}`,
  );
  assert.equal(
    sharedMetadataUri.selectMetadataUri(undefined, '', gatewayFigureUri, legacyFigureUri),
    `ipfs://${VALID_IPFS_CID}/f56.json?download=1#preview`,
  );
});
