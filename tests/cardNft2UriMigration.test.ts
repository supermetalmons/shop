import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  ADMIN,
  COLLECTION,
  CONFIG_PDA,
  MAX_BOX_ID,
  MAX_CARD_ID,
  NEW_BASE,
  OLD_BASE,
  PROGRAM_ID,
  SET_URI_BASE_DISCRIMINATOR,
  assertReceiptTreeConfig,
  batches,
  classifyUri,
  planChecksum,
  searchAllCollectionAssets,
  setUriBaseInstruction,
  updateCollectionInstruction,
  updateCoreInstruction,
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
