import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boxIdFromMetadataUri,
  canonicalMetadataBase,
  dudeIdFromMetadataUri,
  metadataBaseFromMetadataUri,
  metadataKindFromUri,
  selectMetadataUri,
} from '../shared/dropMetadataUri.ts';

const VALID_IPFS_CID = 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

test('metadata URI parsing preserves historical and compact asset forms', () => {
  const historicalBoxUri = 'https://assets.example.com/drops/alpha/json/boxes/12.json?download=1#preview';
  const historicalFigureUri = 'https://assets.example.com/drops/alpha/json/figures/34.json#card';
  const compactFigureUri = `ipfs://${VALID_IPFS_CID}/f56.json?download=1`;
  const compactBoxReceiptUri = `ipfs://${VALID_IPFS_CID}/rbclaim-7.json#receipt`;
  const compactFigureReceiptUri = `ipfs://${VALID_IPFS_CID}/rf89.json?download=1#receipt`;
  const collectionUri = `ipfs://${VALID_IPFS_CID}/collection.json?download=1#collection`;
  const gatewayFigureUri = `https://nftstorage.link/ipfs/${VALID_IPFS_CID}/f56.json?download=1#preview`;

  assert.equal(metadataKindFromUri(historicalBoxUri), 'box');
  assert.equal(metadataKindFromUri(historicalFigureUri), 'dude');
  assert.equal(metadataKindFromUri(compactFigureUri), 'dude');
  assert.equal(metadataKindFromUri(compactBoxReceiptUri), 'certificate');
  assert.equal(metadataKindFromUri(compactFigureReceiptUri), 'certificate');
  assert.equal(boxIdFromMetadataUri(historicalBoxUri), '12');
  assert.equal(boxIdFromMetadataUri(compactBoxReceiptUri), 'claim-7');
  assert.equal(dudeIdFromMetadataUri(historicalFigureUri), 34);
  assert.equal(dudeIdFromMetadataUri(compactFigureReceiptUri), 89);
  assert.equal(
    metadataBaseFromMetadataUri(historicalBoxUri),
    'https://assets.example.com/drops/alpha',
  );
  assert.equal(metadataBaseFromMetadataUri(compactFigureUri), `ipfs://${VALID_IPFS_CID}`);
  assert.equal(metadataBaseFromMetadataUri(compactBoxReceiptUri), `ipfs://${VALID_IPFS_CID}`);
  assert.equal(metadataBaseFromMetadataUri(collectionUri), `ipfs://${VALID_IPFS_CID}`);
  assert.equal(metadataBaseFromMetadataUri('https://assets.example.com/preview.webp'), null);
  assert.equal(
    canonicalMetadataBase(`https://nftstorage.link/ipfs/${VALID_IPFS_CID}/`),
    `ipfs://${VALID_IPFS_CID}`,
  );
  assert.equal(
    selectMetadataUri(undefined, '', gatewayFigureUri, historicalFigureUri),
    `ipfs://${VALID_IPFS_CID}/f56.json?download=1#preview`,
  );
});
