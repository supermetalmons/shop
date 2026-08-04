import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  ADMIN,
  MAINNET_URI_DROPS,
  UPGRADEABLE_LOADER,
  assertConfigState,
  assertNoMutableLegacy,
  assertProgramState,
  paginateDasAssets,
  scanInventory,
  sha256,
} from '../scripts/shared/mainnetUriMigrationVerification.ts';

const spec = MAINNET_URI_DROPS[0];

function bytesString(value: string): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function configData(): Buffer {
  const fields = [
    Buffer.from([62, 29, 116, 188, 219, 247, 48, 227]),
    new PublicKey(ADMIN).toBuffer(),
    new PublicKey(ADMIN).toBuffer(),
    new PublicKey(spec.collection).toBuffer(),
    Buffer.alloc(8 + 8 + 32),
    Buffer.from([77, 1, 0, 0, 15]),
    Buffer.from([77, 1, 0, 0]),
    bytesString('box'),
    bytesString('LSB'),
    bytesString(spec.canonicalBase),
  ];
  const prefix = Buffer.concat(fields);
  return Buffer.concat([prefix, Buffer.alloc(spec.configBytes - prefix.length)]);
}

function asset(id: string, uri: string, options: { receipt?: boolean; burnt?: boolean } = {}) {
  return {
    id,
    interface: options.receipt ? 'MplBubblegumV2' : 'MplCoreAsset',
    burnt: options.burnt || false,
    mutable: !options.burnt,
    content: { json_uri: uri },
    grouping: [{ group_key: 'collection', group_value: spec.collection }],
    authorities: [{ address: spec.coreAuthority, scopes: ['full'] }],
    compression: options.receipt ? { tree: spec.receiptsTree } : undefined,
  };
}

test('DAS pagination ignores capped totals and deduplicates identical assets', async () => {
  const first = asset('one', `${spec.canonicalBase}/json/boxes/1.json`);
  const second = asset('two', `${spec.canonicalBase}/json/figures/2.json`);
  const pages = [
    { total: 1, items: [first, second] },
    { total: 1, items: [second] },
  ];
  const result = await paginateDasAssets(async (page) => pages[page - 1], 2);
  assert.equal(result.pages, 2);
  assert.deepEqual(result.assets.map((item) => item.id), ['one', 'two']);
});

test('DAS pagination rejects malformed and conflicting duplicate pages', async () => {
  await assert.rejects(() => paginateDasAssets(async () => ({}), 2), /Malformed DAS page/);
  const first = asset('one', `${spec.canonicalBase}/json/boxes/1.json`);
  const changed = asset('one', `${spec.canonicalBase}/json/boxes/2.json`);
  await assert.rejects(
    () => paginateDasAssets(async (page) => page === 1
      ? { items: [first] }
      : { items: [changed] }, 1),
    /Conflicting duplicate DAS asset/,
  );
});

test('inventory accepts canonical live assets and legacy burned history', () => {
  const data = configData();
  const dynamicSpec = { ...spec, configSha256: sha256(data) };
  const config = assertConfigState(dynamicSpec, dynamicSpec.program, data);
  const summary = scanInventory(dynamicSpec, config, [
    asset('core-live', `${spec.canonicalBase}/json/boxes/1.json`),
    asset('receipt-live', `${spec.canonicalBase}/json/receipts/figures/2.json`, { receipt: true }),
    asset('core-burned', `${spec.legacyBase}/json/boxes/3.json`, { burnt: true }),
    asset('receipt-burned', `${spec.legacyBase}/json/receipts/boxes/4.json`, { receipt: true, burnt: true }),
  ]);
  assert.equal(summary.liveCore, 1);
  assert.equal(summary.liveReceipts, 1);
  assert.equal(summary.legacyBurnedCore, 1);
  assert.equal(summary.legacyBurnedReceipts, 1);
  assertNoMutableLegacy(summary, spec.dropId);
});

test('inventory reports mutable legacy assets and rejects unrelated paths', () => {
  const data = configData();
  const dynamicSpec = { ...spec, configSha256: sha256(data) };
  const config = assertConfigState(dynamicSpec, dynamicSpec.program, data);
  const summary = scanInventory(dynamicSpec, config, [
    asset('legacy-live', `${spec.legacyBase}/json/boxes/1.json`),
  ]);
  assert.deepEqual(summary.mutableLegacy, ['legacy-live']);
  assert.throws(() => assertNoMutableLegacy(summary, spec.dropId), /mutable legacy URI/);
  assert.throws(
    () => scanInventory(dynamicSpec, config, [asset('bad', `${spec.canonicalBase}/collection.json`)]),
    /Unexpected Core URI/,
  );
});

test('program and config assertions reject mismatched release state', () => {
  const payload = Buffer.from('elf');
  const programData = Buffer.alloc(45 + payload.length);
  programData.writeUInt32LE(3, 0);
  programData.writeBigUInt64LE(BigInt(spec.deploymentSlot), 4);
  programData[12] = 1;
  new PublicKey(ADMIN).toBuffer().copy(programData, 13);
  payload.copy(programData, 45);
  const dynamicSpec = { ...spec, elfSha256: sha256(payload) };
  assert.equal(
    assertProgramState(dynamicSpec, UPGRADEABLE_LOADER, true, UPGRADEABLE_LOADER, programData).authority,
    ADMIN,
  );
  assert.throws(
    () => assertProgramState({ ...dynamicSpec, deploymentSlot: spec.deploymentSlot + 1 }, UPGRADEABLE_LOADER, true, UPGRADEABLE_LOADER, programData),
    /deployed program mismatch/,
  );
  const data = configData();
  assert.throws(() => assertConfigState(spec, spec.program, data), /config hash mismatch/);
});
