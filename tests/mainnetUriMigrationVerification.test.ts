import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  ADMIN,
  MAINNET_PROGRAM_ATTESTATIONS,
  MAINNET_URI_DROPS,
  UPGRADEABLE_LOADER,
  assertConfigState,
  assertNoMutableLegacy,
  assertProgramState,
  assertUpgradeTransaction,
  paginateDasAssets,
  scanInventory,
  sha256,
} from '../scripts/shared/mainnetUriMigrationVerification.ts';

const spec = MAINNET_URI_DROPS[0];
const cardSpec = MAINNET_URI_DROPS.find((drop) => drop.dropId === 'card_nft_2');

if (!cardSpec) throw new Error('Missing Card NFT 2 mainnet URI drop spec');

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

function programAccountData(programData: string): Buffer {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  new PublicKey(programData).toBuffer().copy(data, 4);
  return data;
}

function upgradeTransaction(target = spec) {
  const attestation = target.programAttestation;
  return {
    slot: attestation.deploymentSlot,
    meta: { err: null },
    transaction: {
      signatures: [attestation.upgradeSignature],
      message: {
        accountKeys: [
          { pubkey: attestation.address },
          { pubkey: attestation.programData },
          { pubkey: UPGRADEABLE_LOADER },
        ],
        instructions: [{
          program: 'bpf-upgradeable-loader',
          programId: UPGRADEABLE_LOADER,
          parsed: {
            type: 'upgrade',
            info: {
              authority: attestation.authority,
              programAccount: attestation.address,
              programDataAccount: attestation.programData,
            },
          },
        }],
      },
    },
  };
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
  programData.writeBigUInt64LE(BigInt(spec.programAttestation.deploymentSlot), 4);
  programData[12] = 1;
  new PublicKey(ADMIN).toBuffer().copy(programData, 13);
  payload.copy(programData, 45);
  const dynamicSpec = {
    ...spec,
    programAttestation: { ...spec.programAttestation, elfSha256: sha256(payload) },
  };
  assert.equal(
    assertProgramState(
      dynamicSpec,
      UPGRADEABLE_LOADER,
      true,
      programAccountData(dynamicSpec.programAttestation.programData),
      UPGRADEABLE_LOADER,
      programData,
    ).authority,
    ADMIN,
  );
  assert.throws(
    () => assertProgramState({
      ...dynamicSpec,
      programAttestation: {
        ...dynamicSpec.programAttestation,
        deploymentSlot: spec.programAttestation.deploymentSlot + 1,
      },
    }, UPGRADEABLE_LOADER, true, programAccountData(dynamicSpec.programAttestation.programData), UPGRADEABLE_LOADER, programData),
    /deployed program mismatch/,
  );
  assert.throws(
    () => assertProgramState(
      dynamicSpec,
      UPGRADEABLE_LOADER,
      true,
      programAccountData(ADMIN),
      UPGRADEABLE_LOADER,
      programData,
    ),
    /ProgramData pointer mismatch/,
  );
  const data = configData();
  assert.throws(() => assertConfigState(spec, spec.program, data), /config hash mismatch/);
});

test('Card NFT 2 keeps historical migration evidence separate from its live program attestation', () => {
  assert.equal(cardSpec.deploymentSlot, 437_244_047);
  assert.equal(cardSpec.elfSha256, 'a11f08436c0c1f7da6d3254f5191ba297a7d73b243bd14f3f81622c61eb5cb66');
  assert.deepEqual(cardSpec.programAttestation, MAINNET_PROGRAM_ATTESTATIONS.card_nft_2);
  assert.deepEqual(cardSpec.programAttestation, {
    address: '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
    programData: 'EoFbiCxRabimw8NHUNcdtMuVTuxVcriZSFZys4GvkWMK',
    deploymentSlot: 438_693_777,
    elfSha256: '99fa84062b79da099b72b0559523e9781b0a6b31113ed0747c4ba56d15637ab5',
    authority: ADMIN,
    upgradeSignature: '5WnCJ7BqTqNo45AprD6L2MBvU5mu97MHHPErGRHET44sTc9rhPPetBzA4isfUmKrKPpQ7vixNZBkcj5ED9r1omTc',
  });
});

test('live program attestations pin the successful upgrade transactions', () => {
  assert.deepEqual(
    Object.values(MAINNET_PROGRAM_ATTESTATIONS).map((attestation) => attestation.upgradeSignature),
    [
      '44x6htchVQ7US11rtPp1H5a2SJqhUr3xXPZSzCqAmkPJcXM8ckgiLxDdAMWMN1duNgu8bDTuKeTxXe7oLmve1uHe',
      '3dKajKrvf8JEoVT8Bgcoiw5pcByeWtMyTdjSN97wKCnoeK5yRP1RYHojmeX8be4pXcc4dDTnHhiwCmenGmNhG9sW',
      '5WnCJ7BqTqNo45AprD6L2MBvU5mu97MHHPErGRHET44sTc9rhPPetBzA4isfUmKrKPpQ7vixNZBkcj5ED9r1omTc',
    ],
  );
});

test('upgrade transaction assertions require finalized successful loader evidence', () => {
  const transaction = upgradeTransaction(cardSpec);
  assert.doesNotThrow(() => assertUpgradeTransaction(cardSpec, transaction));
  assert.throws(
    () => assertUpgradeTransaction(cardSpec, { ...transaction, meta: { err: { InstructionError: [0, 'Custom'] } } }),
    /failed or has the wrong slot/,
  );
  assert.throws(
    () => assertUpgradeTransaction(cardSpec, {
      ...transaction,
      transaction: {
        ...transaction.transaction,
        message: { ...transaction.transaction.message, instructions: [] },
      },
    }),
    /parsed upgrade instruction mismatch/,
  );
});

test('program assertions reject mismatched live authority and ELF hash', () => {
  const payload = Buffer.from('current-elf');
  const programData = Buffer.alloc(45 + payload.length);
  programData.writeUInt32LE(3, 0);
  programData.writeBigUInt64LE(BigInt(cardSpec.programAttestation.deploymentSlot), 4);
  programData[12] = 1;
  new PublicKey(ADMIN).toBuffer().copy(programData, 13);
  payload.copy(programData, 45);
  const matchingSpec = {
    ...cardSpec,
    programAttestation: { ...cardSpec.programAttestation, elfSha256: sha256(payload) },
  };
  assert.throws(
    () => assertProgramState({
      ...matchingSpec,
      programAttestation: { ...matchingSpec.programAttestation, authority: spec.collection },
    }, UPGRADEABLE_LOADER, true, programAccountData(matchingSpec.programAttestation.programData), UPGRADEABLE_LOADER, programData),
    /deployed program mismatch/,
  );
  assert.throws(
    () => assertProgramState({
      ...matchingSpec,
      programAttestation: { ...matchingSpec.programAttestation, elfSha256: '0'.repeat(64) },
    }, UPGRADEABLE_LOADER, true, programAccountData(matchingSpec.programAttestation.programData), UPGRADEABLE_LOADER, programData),
    /deployed program mismatch/,
  );
});
