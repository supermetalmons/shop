import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  ADMIN,
  COLLECTION,
  CONFIG_PDA,
  KNOWN_RECEIPT_REPAIR,
  MAX_BOX_ID,
  MAX_CARD_ID,
  NEW_BASE,
  OLD_BASE,
  PROGRAM_ID,
  RECEIPTS_TREE,
  RECEIPTS_TREE_CONFIG,
  SET_URI_BASE_DISCRIMINATOR,
  assertReceiptTreeConfig,
  batches,
  classifyCollectionAsset,
  classifyUri,
  decodeBubblegumLeafEvent,
  expectedReceiptDataHash,
  planChecksum,
  receiptMetadataDataHash,
  searchAllCollectionAssets,
  setUriBaseInstruction,
  updateCollectionInstruction,
  updateCoreInstruction,
  updateReceiptInstruction,
} from '../scripts/shared/cardNft2UriMigration.ts';

test('Card URI classification is exact, compact, and bounded', () => {
  assert.deepEqual(classifyUri(`${OLD_BASE}/b1.json`, OLD_BASE, NEW_BASE, false), {
    status: 'source',
    kind: 'box',
    referenceId: 1,
    sourceUri: `${OLD_BASE}/b1.json`,
    targetUri: `${NEW_BASE}/b1.json`,
  });
  assert.equal(classifyUri(`${NEW_BASE}/f${MAX_CARD_ID}.json`, OLD_BASE, NEW_BASE, false)?.status, 'target');
  assert.equal(classifyUri(`${OLD_BASE}/rb${MAX_BOX_ID}.json`, OLD_BASE, NEW_BASE, true)?.kind, 'box');
  assert.equal(classifyUri(`${OLD_BASE}/rf${MAX_CARD_ID + 1}.json`, OLD_BASE, NEW_BASE, true), null);
  assert.equal(classifyUri(`${OLD_BASE}/json/boxes/1.json`, OLD_BASE, NEW_BASE, false), null);
  assert.equal(classifyUri(`${OLD_BASE}/b01.json`, OLD_BASE, NEW_BASE, false), null);
  assert.equal(classifyUri(`${OLD_BASE}/b1.json?x=1`, OLD_BASE, NEW_BASE, false), null);
});

test('DAS pagination ignores capped total, deduplicates IDs, and stops on a short page', async () => {
  const page = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: `asset-${start + index}` }));
  const requested: number[] = [];
  const result = await searchAllCollectionAssets('unused', async (number) => {
    requested.push(number);
    if (number === 1) return { total: 1_000, items: page(0, 1_000) };
    if (number === 2) return { total: 1_000, items: page(999, 1_000) };
    if (number === 3) return { total: 1_000, items: page(1_999, 7) };
    throw new Error('pagination did not stop');
  });
  assert.deepEqual(requested, [1, 2, 3]);
  assert.equal(result.pages, 3);
  assert.equal(result.assets.length, 2_006);
});

test('fixed-address instructions expose only the intended writable accounts', () => {
  const setter = setUriBaseInstruction(NEW_BASE);
  assert.equal(setter.programId.toBase58(), PROGRAM_ID.toBase58());
  assert.equal(setter.data.subarray(0, 8).equals(SET_URI_BASE_DISCRIMINATOR), true);
  assert.deepEqual(setter.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]), [
    [CONFIG_PDA.toBase58(), false, true],
    [ADMIN.toBase58(), true, false],
  ]);

  const collection = updateCollectionInstruction(`${NEW_BASE}/collection.json`);
  assert.equal(collection.keys[0].pubkey.toBase58(), COLLECTION.toBase58());
  assert.equal(collection.keys[0].isWritable, true);
  assert.equal(collection.data[0], 16);

  const asset = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
  const core = updateCoreInstruction(asset, `${NEW_BASE}/b1.json`);
  assert.equal(core.keys[0].pubkey.toBase58(), asset.toBase58());
  assert.equal(core.keys[0].isWritable, true);
  assert.equal(core.keys[1].pubkey.toBase58(), COLLECTION.toBase58());
  assert.equal(core.data[0], 15);
});

test('Core batches and plan checksum are deterministic', () => {
  const values = Array.from({ length: 33 }, (_, index) => index + 1);
  assert.deepEqual(batches(values), [
    values.slice(0, 10),
    values.slice(10, 20),
    values.slice(20, 30),
    values.slice(30),
  ]);
  assert.equal(planChecksum({ values }), planChecksum({ values }));
  assert.notEqual(planChecksum({ values }), planChecksum({ values: [...values].reverse() }));
});

test('receipt TreeConfig requires the fixed creator and delegate', () => {
  const data = Buffer.alloc(96);
  Buffer.from([122, 245, 175, 248, 171, 34, 0, 207]).copy(data);
  ADMIN.toBuffer().copy(data, 8);
  ADMIN.toBuffer().copy(data, 40);
  assert.deepEqual(assertReceiptTreeConfig(data), {
    creator: ADMIN.toBase58(),
    delegate: ADMIN.toBase58(),
  });
  data[40] ^= 1;
  assert.throws(() => assertReceiptTreeConfig(data), /authority mismatch/);
});

test('Bubblegum V2 receipt updates serialize exact metadata and repair the incident royalty', () => {
  const asset = {
    id: KNOWN_RECEIPT_REPAIR.asset,
    interface: 'MplBubblegumV2',
    content: {
      json_uri: KNOWN_RECEIPT_REPAIR.sourceUri,
      metadata: { name: 'receipt · pack 341', symbol: '' },
    },
    royalty: { basis_points: 50, primary_sale_happened: false },
    mutable: true,
    creators: [],
    ownership: { owner: ADMIN.toBase58(), delegate: ADMIN.toBase58() },
    authorities: [{ address: RECEIPTS_TREE_CONFIG.toBase58(), scopes: ['full'] }],
    grouping: [{ group_key: 'collection', group_value: COLLECTION.toBase58() }],
    compression: {
      tree: RECEIPTS_TREE.toBase58(),
      leaf_id: 0,
      leaf_index: 0,
      data_hash: KNOWN_RECEIPT_REPAIR.dataHash,
      asset_data_hash: 'EKDHSGbrGztomDfuiV4iqiZ6LschDJPsFiXjZ83f92Md',
      asset_hash: KNOWN_RECEIPT_REPAIR.leafHash,
      flags: 0,
    },
  };
  const targetUri = `${NEW_BASE}/rb341.json`;
  assert.equal(receiptMetadataDataHash(asset, KNOWN_RECEIPT_REPAIR.sourceUri, 50), KNOWN_RECEIPT_REPAIR.dataHash);
  assert.equal(expectedReceiptDataHash(asset, targetUri), 'HLkLzups8Qt79Qj6qqDj5cJXTPDzkwaZA6Su64NrmjjX');
  const proofAddress = PublicKey.default.toBase58();
  const instruction = updateReceiptInstruction(asset, {
    tree_id: RECEIPTS_TREE.toBase58(),
    root: proofAddress,
    proof: Array.from({ length: 14 }, () => proofAddress),
  }, targetUri);
  const updateArgs = Buffer.concat([
    Buffer.from([0, 0, 1]),
    Buffer.from([targetUri.length, 0, 0, 0]),
    Buffer.from(targetUri),
    Buffer.from([0, 1, 0, 0, 0, 0]),
  ]);
  assert.equal(instruction.data.subarray(-updateArgs.length).equals(updateArgs), true);
  const metadataEnd = instruction.data.length - updateArgs.length;
  assert.equal(instruction.data.subarray(metadataEnd - 33, metadataEnd).equals(
    Buffer.concat([Buffer.from([1]), COLLECTION.toBuffer()]),
  ), true);
  const classified = classifyCollectionAsset([asset], OLD_BASE, NEW_BASE);
  assert.deepEqual(classified.receiptTargets[0].royaltyRepair, {
    sourceBasisPoints: 50,
    targetBasisPoints: 0,
    incidentSignature: KNOWN_RECEIPT_REPAIR.signature,
  });
  assert.throws(
    () => classifyCollectionAsset([{ ...asset, id: PublicKey.unique().toBase58() }], OLD_BASE, NEW_BASE),
    /Receipt metadata mismatch/,
  );
});

test('the incident transaction emitted the unchanged Bubblegum leaf', () => {
  const event = decodeBubblegumLeafEvent(Buffer.from(
    'AQAMAQAAAQEBo/OAfHCEdcD0pUl4Wxbytb5IYXSzVszd/2XqXKYt03wLHSSkzAqvFrFrk6VKJwW8zPmElDRAfuNvlu2QCiATeQsdJKTMCq8WsWuTpUonBbzM+YSUNEB+42+W7ZAKIBN5AAAAAAAAAADeNsxptAgGWRYAzbX/rwisyXfIiZkdgO3/GScyDaFnGcXSRgGG9yM8kn59stzHA8DlALZTyoInO3v62ARdhaRwYj3gqc0zhxWMn40JcbFWY/zUeF0M18FM1/Ba8/M3tnTF0kYBhvcjPJJ+fbLcxwPA5QC2U8qCJzt7+tgEXYWkcACnhC7ijmmMwOmGxQq1mGjNj9/maL2K2YoFwyN+p9DEtg==',
    'base64',
  ));
  assert.equal(event.assetId, KNOWN_RECEIPT_REPAIR.asset);
  assert.equal(event.dataHash, KNOWN_RECEIPT_REPAIR.dataHash);
  assert.equal(event.leafHash, KNOWN_RECEIPT_REPAIR.leafHash);
});
