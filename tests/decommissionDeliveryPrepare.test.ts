import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { decommissionFirebasePrepareDelivery } from '../scripts/decommission-firebase-prepare-delivery.ts';
import { getFunctionsDrop } from '../functions/src/config/deployment.ts';
import { BOX_MINTER_CONFIG_SEED } from '../functions/src/shared/boxMinterProtocol.ts';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../functions/src/shared/solanaProgramAddresses.ts';

const OWNER = Keypair.generate();
const COSIGNER = Keypair.generate();
const ASSET = Keypair.generate();
const VERSION = '72bfa410-5c85-4e3c-b1e0-5ce0cfdb1108';
const DROP_ID = 'card_nft_2';
const ADDRESS_ID = 'AbCdEfGhIjKlMnOpQrSt';
const DELIVERY_ID = 17;
const DELIVERY_LAMPORTS = 200_000_000;
const DELIVER_DISCRIMINATOR = Buffer.from('fa83de39d3e5d193', 'hex');

function u32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function u64LE(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function deliveryPdaForTest(deliveryId: number): string {
  const config = getFunctionsDrop(DROP_ID)!;
  const programId = new PublicKey(config.boxMinterProgramId);
  const configPda = config.boxMinterConfigPda
    ? new PublicKey(config.boxMinterConfigPda)
    : PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0];
  const legacyConfig = PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0];
  const seeds: Uint8Array[] = [Buffer.from('delivery')];
  if (!configPda.equals(legacyConfig)) seeds.push(configPda.toBuffer());
  seeds.push(u32LE(deliveryId));
  return PublicKey.findProgramAddressSync(seeds, programId)[0].toBase58();
}

function deliveryLookupForTest(): AddressLookupTableAccount {
  const config = getFunctionsDrop(DROP_ID)!;
  const programId = new PublicKey(config.boxMinterProgramId);
  const configPda = config.boxMinterConfigPda
    ? new PublicKey(config.boxMinterConfigPda)
    : PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0];
  const bubblegum = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
  const receiptTree = new PublicKey(config.receiptsMerkleTree);
  const seen = new Set<string>();
  const addresses = [
    programId,
    configPda,
    new PublicKey(config.treasury),
    new PublicKey(config.collectionMint),
    new PublicKey(MPL_CORE_PROGRAM_ADDRESS),
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    new PublicKey(SPL_NOOP_PROGRAM_ADDRESS),
    new PublicKey(MPL_NOOP_PROGRAM_ADDRESS),
    new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS),
    bubblegum,
    new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS),
    receiptTree,
    PublicKey.findProgramAddressSync([receiptTree.toBuffer()], bubblegum)[0],
  ].filter((key) => {
    const encoded = key.toBase58();
    if (seen.has(encoded)) return false;
    seen.add(encoded);
    return true;
  });
  return new AddressLookupTableAccount({
    key: new PublicKey(config.deliveryLookupTable),
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses,
    },
  });
}

function preparedResponse() {
  const config = getFunctionsDrop(DROP_ID)!;
  const programId = new PublicKey(config.boxMinterProgramId);
  const configPda = config.boxMinterConfigPda
    ? new PublicKey(config.boxMinterConfigPda)
    : PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0];
  const legacyConfig = PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0];
  const seeds: Uint8Array[] = [Buffer.from('delivery')];
  if (!configPda.equals(legacyConfig)) seeds.push(configPda.toBuffer());
  seeds.push(u32LE(DELIVERY_ID));
  const [deliveryPda, deliveryBump] = PublicKey.findProgramAddressSync(seeds, programId);
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: COSIGNER.publicKey, isSigner: true, isWritable: false },
      { pubkey: OWNER.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(config.treasury), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(config.collectionMint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(MPL_CORE_PROGRAM_ADDRESS), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SPL_NOOP_PROGRAM_ADDRESS), isSigner: false, isWritable: false },
      { pubkey: deliveryPda, isSigner: false, isWritable: true },
      { pubkey: ASSET.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      DELIVER_DISCRIMINATOR,
      u32LE(DELIVERY_ID),
      u64LE(DELIVERY_LAMPORTS),
      Buffer.from([deliveryBump]),
    ]),
  });
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: OWNER.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction],
  }).compileToV0Message([deliveryLookupForTest()]));
  transaction.sign([COSIGNER]);
  return {
    encodedTx: Buffer.from(transaction.serialize()).toString('base64'),
    deliveryId: DELIVERY_ID,
    deliveryLamports: DELIVERY_LAMPORTS,
  };
}

function environment() {
  return {
    DELIVERY_PREPARE_SMOKE_FIREBASE_TOKEN: 'firebase-token',
    DELIVERY_PREPARE_SMOKE_OWNER: OWNER.publicKey.toBase58(),
    DELIVERY_PREPARE_SMOKE_DROP_ID: DROP_ID,
    DELIVERY_PREPARE_SMOKE_ADDRESS_ID: ADDRESS_ID,
    DELIVERY_PREPARE_SMOKE_ITEM_IDS: JSON.stringify([ASSET.publicKey.toBase58()]),
    CLOUDFLARE_API_TOKEN: 'cloudflare-token',
    RETAINED_VALUE: 'retained',
  };
}

function manifest() {
  return {
    currentProduction: { apiVersionId: VERSION, frontendVersionId: VERSION },
    approvedRollback: { apiVersionId: VERSION, frontendVersionId: VERSION },
  };
}

function liveReleasePair() {
  return manifest().currentProduction;
}

function preparedDocument(prepareAttemptId = '123e4567-e89b-42d3-a456-426614174000') {
  const config = getFunctionsDrop(DROP_ID)!;
  return {
    fields: {
      addressSnapshot: {
        country: 'US',
        countryCode: 'US',
        encrypted: 'cipher',
        id: ADDRESS_ID,
      },
      createdAt: 1_700_000_000_000,
      dropId: DROP_ID,
      status: 'prepared',
      owner: OWNER.publicKey.toBase58(),
      addressId: ADDRESS_ID,
      itemIds: [ASSET.publicKey.toBase58()],
      items: [{ assetId: ASSET.publicKey.toBase58(), kind: 'dude', refId: 1 }],
      deliveryId: DELIVERY_ID,
      deliveryLamports: DELIVERY_LAMPORTS,
      deliveryPda: deliveryPdaForTest(DELIVERY_ID),
      lookupTable: config.deliveryLookupTable,
      prepareAttemptId,
      receiptRecovery: {
        preparedProbeCount: 0,
        nextPreparedProbeAt: 1_700_000_030_000,
      },
    },
    updateTime: '2026-08-20T00:00:01.000Z',
  };
}

test('delivery decommission validates production, cleans the exact document, then deletes the callable', async () => {
  const events: string[] = [];
  let childEnvironment: NodeJS.ProcessEnv | undefined;
  let prepareAttemptId = '';
  await decommissionFirebasePrepareDelivery(environment(), {
    readLiveReleasePair: () => {
      events.push('live');
      return liveReleasePair();
    },
    readManifest: manifest,
    fetch: async (input, init) => {
      events.push('fetch');
      assert.equal(String(input), 'https://api.mons.shop/delivery/prepare');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer firebase-token');
      prepareAttemptId = String(new Headers(init?.headers).get('x-mons-delivery-prepare-attempt') || '');
      assert.match(prepareAttemptId, /^[0-9a-f-]{36}$/i);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        owner: OWNER.publicKey.toBase58(),
        dropId: DROP_ID,
        itemIds: [ASSET.publicKey.toBase58()],
        addressId: ADDRESS_ID,
      });
      return Response.json(preparedResponse());
    },
    readWriterCredential: () => {
      events.push('credential');
      return 'writer-credential';
    },
    loadPreparedDocument: async (credential, path) => {
      events.push('read');
      assert.equal(credential, 'writer-credential');
      assert.equal(path, `drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`);
      return preparedDocument(prepareAttemptId);
    },
    deletePreparedDocument: async (credential, path, updateTime) => {
      events.push('cleanup');
      assert.equal(credential, 'writer-credential');
      assert.equal(path, `drops/${DROP_ID}/deliveryOrders/${DELIVERY_ID}`);
      assert.equal(updateTime, '2026-08-20T00:00:01.000Z');
    },
    runFirebaseDelete: (value) => {
      events.push('delete');
      childEnvironment = value;
    },
    simulatePreparedDelivery: async () => {
      events.push('simulate');
    },
  });
  assert.deepEqual(events, ['live', 'credential', 'fetch', 'read', 'simulate', 'cleanup', 'live', 'delete']);
  assert.equal(childEnvironment?.RETAINED_VALUE, 'retained');
  assert.equal(childEnvironment?.DELIVERY_PREPARE_SMOKE_FIREBASE_TOKEN, undefined);
  assert.equal(childEnvironment?.DELIVERY_PREPARE_SMOKE_OWNER, undefined);
  assert.equal(childEnvironment?.DELIVERY_PREPARE_SMOKE_DROP_ID, undefined);
  assert.equal(childEnvironment?.DELIVERY_PREPARE_SMOKE_ADDRESS_ID, undefined);
  assert.equal(childEnvironment?.DELIVERY_PREPARE_SMOKE_ITEM_IDS, undefined);
  assert.equal(childEnvironment?.CLOUDFLARE_API_TOKEN, undefined);
});

test('delivery decommission rejects incompatible rollback metadata before smoke or cleanup', async () => {
  let fetchCalled = false;
  let cleanupCalled = false;
  await assert.rejects(
    () => decommissionFirebasePrepareDelivery(environment(), {
      readManifest: () => ({
        ...manifest(),
        approvedRollback: { apiVersionId: VERSION, frontendVersionId: 'd310f1bc-8ee3-4032-8360-ded742f2bec4' },
      }),
      fetch: async () => {
        fetchCalled = true;
        return Response.json(preparedResponse());
      },
      deletePreparedDocument: async () => {
        cleanupCalled = true;
      },
    }),
    /Approved rollback/,
  );
  assert.equal(fetchCalled, false);
  assert.equal(cleanupCalled, false);
});

test('delivery decommission rejects live Cloudflare release drift before smoke', async () => {
  let fetchCalled = false;
  await assert.rejects(
    () => decommissionFirebasePrepareDelivery(environment(), {
      readManifest: manifest,
      readLiveReleasePair: () => ({
        ...manifest().currentProduction,
        frontendVersionId: 'd310f1bc-8ee3-4032-8360-ded742f2bec4',
      }),
      fetch: async () => {
        fetchCalled = true;
        return Response.json(preparedResponse());
      },
    }),
    /Live Cloudflare production/,
  );
  assert.equal(fetchCalled, false);
});

test('delivery decommission verifies its cleanup credential before creating a smoke order', async () => {
  let fetchCalled = false;
  await assert.rejects(
    () => decommissionFirebasePrepareDelivery(environment(), {
      readLiveReleasePair: liveReleasePair,
      readManifest: manifest,
      readWriterCredential: () => {
        throw new Error('missing writer credential');
      },
      fetch: async () => {
        fetchCalled = true;
        return Response.json(preparedResponse());
      },
    }),
    /missing writer credential/,
  );
  assert.equal(fetchCalled, false);
});

test('delivery decommission cleans up malformed transactions without deleting the callable', async () => {
  let cleanupCalled = false;
  let deleteCalled = false;
  let prepareAttemptId = '';
  await assert.rejects(
    () => decommissionFirebasePrepareDelivery(environment(), {
      readLiveReleasePair: liveReleasePair,
      readManifest: manifest,
      fetch: async (_input, init) => {
        prepareAttemptId = String(new Headers(init?.headers).get('x-mons-delivery-prepare-attempt') || '');
        return Response.json({ ...preparedResponse(), encodedTx: 'invalid' });
      },
      readWriterCredential: () => 'writer-credential',
      loadPreparedDocument: async () => preparedDocument(prepareAttemptId),
      deletePreparedDocument: async () => {
        cleanupCalled = true;
      },
      runFirebaseDelete: () => {
        deleteCalled = true;
      },
    }),
    /invalid delivery transaction/,
  );
  assert.equal(cleanupCalled, true);
  assert.equal(deleteCalled, false);
});

test('delivery decommission rejects incomplete prepared-order documents', async () => {
  let cleanupCalled = false;
  let deleteCalled = false;
  let prepareAttemptId = '';
  await assert.rejects(
    () => decommissionFirebasePrepareDelivery(environment(), {
      readLiveReleasePair: liveReleasePair,
      readManifest: manifest,
      fetch: async (_input, init) => {
        prepareAttemptId = String(new Headers(init?.headers).get('x-mons-delivery-prepare-attempt') || '');
        return Response.json(preparedResponse());
      },
      readWriterCredential: () => 'writer-credential',
      loadPreparedDocument: async () => {
        const document = preparedDocument(prepareAttemptId);
        return {
          ...document,
          fields: Object.fromEntries(
            Object.entries(document.fields).filter(([key]) => key !== 'items'),
          ),
        };
      },
      deletePreparedDocument: async () => {
        cleanupCalled = true;
      },
      runFirebaseDelete: () => {
        deleteCalled = true;
      },
    }),
    /did not match the smoke request/,
  );
  assert.equal(cleanupCalled, true);
  assert.equal(deleteCalled, false);
});

test('delivery decommission recomputes the delivery fee from the stored order', async () => {
  let cleanupCalled = false;
  let prepareAttemptId = '';
  await assert.rejects(
    () => decommissionFirebasePrepareDelivery(environment(), {
      readLiveReleasePair: liveReleasePair,
      readManifest: manifest,
      fetch: async (_input, init) => {
        prepareAttemptId = String(new Headers(init?.headers).get('x-mons-delivery-prepare-attempt') || '');
        return Response.json(preparedResponse());
      },
      readWriterCredential: () => 'writer-credential',
      loadPreparedDocument: async () => {
        const document = preparedDocument(prepareAttemptId);
        document.fields.addressSnapshot = {
          ...document.fields.addressSnapshot,
          country: 'TR',
          countryCode: 'TR',
        };
        return document;
      },
      deletePreparedDocument: async () => {
        cleanupCalled = true;
      },
    }),
    /did not match the smoke request/,
  );
  assert.equal(cleanupCalled, true);
});

test('delivery decommission rejects a signed transaction that does not match the response', async () => {
  let cleanupCalled = false;
  let deleteCalled = false;
  let prepareAttemptId = '';
  await assert.rejects(
    () => decommissionFirebasePrepareDelivery(environment(), {
      readLiveReleasePair: liveReleasePair,
      readManifest: manifest,
      fetch: async (_input, init) => {
        prepareAttemptId = String(new Headers(init?.headers).get('x-mons-delivery-prepare-attempt') || '');
        return Response.json({ ...preparedResponse(), deliveryId: DELIVERY_ID + 1 });
      },
      readWriterCredential: () => 'writer-credential',
      loadPreparedDocument: async () => ({
        ...preparedDocument(),
        fields: {
          ...preparedDocument().fields,
          prepareAttemptId,
          deliveryId: DELIVERY_ID + 1,
          deliveryPda: deliveryPdaForTest(DELIVERY_ID + 1),
        },
      }),
      deletePreparedDocument: async () => {
        cleanupCalled = true;
      },
      runFirebaseDelete: () => {
        deleteCalled = true;
      },
    }),
    /invalid delivery instruction data/,
  );
  assert.equal(cleanupCalled, true);
  assert.equal(deleteCalled, false);
});

test('delivery decommission never cleans a document from another smoke attempt', async () => {
  let cleanupCalled = false;
  await assert.rejects(
    () => decommissionFirebasePrepareDelivery(environment(), {
      readLiveReleasePair: liveReleasePair,
      readManifest: manifest,
      fetch: async () => Response.json(preparedResponse()),
      readWriterCredential: () => 'writer-credential',
      loadPreparedDocument: async () => preparedDocument('older-attempt'),
      deletePreparedDocument: async () => {
        cleanupCalled = true;
      },
    }),
    /did not match the smoke attempt/,
  );
  assert.equal(cleanupCalled, false);
});

test('delivery decommission cleans a transaction that fails simulation', async () => {
  let cleanupCalled = false;
  let deleteCalled = false;
  let prepareAttemptId = '';
  await assert.rejects(
    () => decommissionFirebasePrepareDelivery(environment(), {
      readLiveReleasePair: liveReleasePair,
      readManifest: manifest,
      fetch: async (_input, init) => {
        prepareAttemptId = String(new Headers(init?.headers).get('x-mons-delivery-prepare-attempt') || '');
        return Response.json(preparedResponse());
      },
      readWriterCredential: () => 'writer-credential',
      loadPreparedDocument: async () => preparedDocument(prepareAttemptId),
      deletePreparedDocument: async () => {
        cleanupCalled = true;
      },
      runFirebaseDelete: () => {
        deleteCalled = true;
      },
      simulatePreparedDelivery: async () => {
        throw new Error('simulation failed');
      },
    }),
    /simulation failed/,
  );
  assert.equal(cleanupCalled, true);
  assert.equal(deleteCalled, false);
});

test('delivery decommission fails closed when prepared-document cleanup fails', async () => {
  let deleteCalled = false;
  let prepareAttemptId = '';
  await assert.rejects(
    () => decommissionFirebasePrepareDelivery(environment(), {
      readLiveReleasePair: liveReleasePair,
      readManifest: manifest,
      fetch: async (_input, init) => {
        prepareAttemptId = String(new Headers(init?.headers).get('x-mons-delivery-prepare-attempt') || '');
        return Response.json(preparedResponse());
      },
      readWriterCredential: () => 'writer-credential',
      loadPreparedDocument: async () => preparedDocument(prepareAttemptId),
      deletePreparedDocument: async () => {
        throw new Error('cleanup failed');
      },
      runFirebaseDelete: () => {
        deleteCalled = true;
      },
      simulatePreparedDelivery: async () => undefined,
    }),
    /cleanup failed/,
  );
  assert.equal(deleteCalled, false);
});
