import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { FUNCTIONS_DROPS } from '../functions/src/config/deployment.ts';
import { ACCOUNT_PENDING_OPEN_BOX, decodePendingOpenBox } from '../functions/src/pendingOpenBox.ts';
import { FRONTEND_DROPS } from '../src/config/deployment.ts';
import { decodePendingOpenRecordData } from '../src/lib/api.ts';

const LIVE_LITTLE_SWAG_BOXES_LEGACY_PENDING =
  'RQdFGvAMQ6Ge0Y5xVn5l/WqYRLjb7HsYQ8nLgzuLwMnRD7Ow2WA4t/d94N7kPVYpYdwdU4ja0Dhqq35JtKtJ7dgEh3CmAh5hWITpOHGmTOxKTZcquT0CAU7flx38JqkeNnCs35PJ1Qw1DARXjX2i6mRBhwls4tXoZUQHOOugR2fJxqKKzakLpDn+bRCMKIqxIt5kmUIiNMc3d3054wf9ZEULXH5lF+EAGuhkGQAAAAD7';

function u32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function pk(value: string): PublicKey {
  return new PublicKey(value);
}

function liveOpenableFunctionDrops() {
  return Object.values(FUNCTIONS_DROPS).filter((drop) => drop.solanaCluster === 'mainnet-beta' && Number(drop.itemsPerBox) > 0);
}

function liveOpenableFrontendDrop(dropId: string) {
  const drop = FRONTEND_DROPS[dropId];
  assert.ok(drop, `Missing frontend drop config for ${dropId}`);
  assert.equal(drop.solanaCluster, 'mainnet-beta');
  assert.equal(Number(drop.itemsPerBox) > 0, true);
  return drop;
}

function configPdaForDrop(drop: { boxMinterProgramId: string; boxMinterConfigPda?: string }): PublicKey {
  return drop.boxMinterConfigPda
    ? pk(drop.boxMinterConfigPda)
    : PublicKey.findProgramAddressSync([Buffer.from('config')], pk(drop.boxMinterProgramId))[0];
}

function buildVecPendingRecord(args: {
  owner: PublicKey;
  boxAsset: PublicKey;
  dudeAssets: PublicKey[];
  createdSlot: bigint;
  bump: number;
  config?: PublicKey;
}): Buffer {
  return Buffer.concat([
    ACCOUNT_PENDING_OPEN_BOX,
    args.owner.toBuffer(),
    args.boxAsset.toBuffer(),
    u32LE(args.dudeAssets.length),
    ...args.dudeAssets.map((asset) => asset.toBuffer()),
    u64LE(args.createdSlot),
    Buffer.from([args.bump & 0xff]),
    ...(args.config ? [args.config.toBuffer()] : []),
  ]);
}

function testDudeAsset(index: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('pending-open-test'), Buffer.from([index & 0xff])], PublicKey.default)[0];
}

test('decodePendingOpenBox supports legacy fixed-array pending records', () => {
  const data = Buffer.from(LIVE_LITTLE_SWAG_BOXES_LEGACY_PENDING, 'base64');
  const decoded = decodePendingOpenBox(data, {
    expectedDudeCount: 3,
  });

  assert.equal(decoded.owner.toBase58(), 'BgxkSecQznPPS5b4kvJ39zRCntKnuNJxgtWj7StZDic6');
  assert.equal(decoded.boxAsset.toBase58(), 'Hf72g2dE9jm7J2fdVqTdhkW5tnLyMyfU54cR4bbhxTnp');
  assert.deepEqual(decoded.dudeAssets.map((asset) => asset.toBase58()), [
    '6xYRdHnKCk5yoHtnejqAmmK7PiADCLFvzF4KvBHi6iqH',
    '4a5EgNi1wVMT4diEts41WvKMfehikcxqtrBTj9UWb6gT',
    '4uPFkxYs1wY4WtXg4vTX8f5GkuEhdaMwtuE73HnTRnKR',
  ]);
  assert.equal(decoded.createdSlot, 426043418n);
  assert.equal(decoded.bump, 251);
  assert.equal(decoded.config, undefined);

  const frontendDrop = liveOpenableFrontendDrop('little_swag_boxes');
  const frontendDecoded = decodePendingOpenRecordData(data, { drops: [frontendDrop] });
  assert.ok(frontendDecoded);
  assert.equal(frontendDecoded.owner, decoded.owner.toBase58());
  assert.equal(frontendDecoded.boxAssetId, decoded.boxAsset.toBase58());
  assert.deepEqual(frontendDecoded.dudeAssetIds, decoded.dudeAssets.map((asset) => asset.toBase58()));
  assert.equal(frontendDecoded.createdSlot, Number(decoded.createdSlot));
  assert.equal(frontendDecoded.configPda, undefined);
});

test('decodePendingOpenBox supports vector records with config pubkey', () => {
  const owner = pk('BgxkSecQznPPS5b4kvJ39zRCntKnuNJxgtWj7StZDic6');
  const boxAsset = pk('Hf72g2dE9jm7J2fdVqTdhkW5tnLyMyfU54cR4bbhxTnp');
  const dudeAssets = [
    pk('6xYRdHnKCk5yoHtnejqAmmK7PiADCLFvzF4KvBHi6iqH'),
    pk('4a5EgNi1wVMT4diEts41WvKMfehikcxqtrBTj9UWb6gT'),
    pk('4uPFkxYs1wY4WtXg4vTX8f5GkuEhdaMwtuE73HnTRnKR'),
  ];
  const config = pk('iGsmSPPYJovrb7jNFCX6BimZN5Z7dpkmCuW9SYAgcMc');
  const data = Buffer.concat([
    ACCOUNT_PENDING_OPEN_BOX,
    owner.toBuffer(),
    boxAsset.toBuffer(),
    u32LE(dudeAssets.length),
    ...dudeAssets.map((asset) => asset.toBuffer()),
    u64LE(123n),
    Buffer.from([7]),
    config.toBuffer(),
  ]);

  const decoded = decodePendingOpenBox(data, { expectedDudeCount: 3 });

  assert.equal(decoded.owner.toBase58(), owner.toBase58());
  assert.equal(decoded.boxAsset.toBase58(), boxAsset.toBase58());
  assert.deepEqual(
    decoded.dudeAssets.map((asset) => asset.toBase58()),
    dudeAssets.map((asset) => asset.toBase58()),
  );
  assert.equal(decoded.createdSlot, 123n);
  assert.equal(decoded.bump, 7);
  assert.equal(decoded.config?.toBase58(), config.toBase58());
});

test('pending-open decoders support every live mainnet openable drop config', () => {
  const owner = pk('BgxkSecQznPPS5b4kvJ39zRCntKnuNJxgtWj7StZDic6');
  const boxAsset = pk('Hf72g2dE9jm7J2fdVqTdhkW5tnLyMyfU54cR4bbhxTnp');

  for (const drop of liveOpenableFunctionDrops()) {
    const expectedDudeCount = Number(drop.itemsPerBox);
    const dudeAssets = Array.from({ length: expectedDudeCount }, (_, index) => testDudeAsset(index));
    const config = configPdaForDrop(drop);
    const data = buildVecPendingRecord({
      owner,
      boxAsset,
      dudeAssets,
      createdSlot: 456n,
      bump: 9,
      config,
    });

    const functionDecoded = decodePendingOpenBox(data, { expectedDudeCount });
    assert.equal(functionDecoded.dudeAssets.length, expectedDudeCount, drop.dropId);
    assert.equal(functionDecoded.config?.toBase58(), config.toBase58(), drop.dropId);

    const frontendDrop = liveOpenableFrontendDrop(drop.dropId);
    const frontendDecoded = decodePendingOpenRecordData(data, { drops: [frontendDrop] });
    assert.ok(frontendDecoded, drop.dropId);
    assert.equal(frontendDecoded.dudeAssetIds.length, expectedDudeCount, drop.dropId);
    assert.equal(frontendDecoded.configPda, config.toBase58(), drop.dropId);
  }
});
