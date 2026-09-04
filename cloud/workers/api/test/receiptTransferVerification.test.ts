import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  type CompiledInnerInstruction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.ts';
import { IX_BUBBLEGUM_TRANSFER_V2 } from '../src/bubblegum.ts';
import {
  bubblegumReceiptAssetIds,
  coreTransferAssetIds,
  matchingReceiptTransferCount,
  transactionAccountKeys,
} from '../src/receiptTransferVerification.ts';

const SENDER = new PublicKey(Buffer.alloc(32, 1));
const RECIPIENT = new PublicKey(Buffer.alloc(32, 2));
const COLLECTION = new PublicKey(Buffer.alloc(32, 3));
const MERKLE_TREE = new PublicKey(Buffer.alloc(32, 4));
const ASSET_A = new PublicKey(Buffer.alloc(32, 5));
const ASSET_B = new PublicKey(Buffer.alloc(32, 6));
const OTHER = new PublicKey(Buffer.alloc(32, 7));
const CORE = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const BUBBLEGUM = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const NOOP = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
const EXPECTED = {
  sender: SENDER.toBase58(),
  recipient: RECIPIENT.toBase58(),
  collection: COLLECTION,
  merkleTree: MERKLE_TREE,
};

function confirmedTransaction(
  instructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[] = [],
): VersionedTransactionResponse {
  const message = new TransactionMessage({
    payerKey: SENDER,
    recentBlockhash: OTHER.toBase58(),
    instructions,
  }).compileToV0Message(lookupTables);
  return {
    blockTime: null,
    meta: {
      err: null,
      fee: 0,
      innerInstructions: [],
      loadedAddresses: message.resolveAddressTableLookups(lookupTables),
      preBalances: [],
      postBalances: [],
    },
    slot: 1,
    transaction: { message, signatures: [] },
    version: 0,
  };
}

function coreTransfer(asset: PublicKey = ASSET_A): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE,
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: COLLECTION, isSigner: false, isWritable: true },
      { pubkey: SENDER, isSigner: true, isWritable: true },
      { pubkey: SENDER, isSigner: true, isWritable: false },
      { pubkey: RECIPIENT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: NOOP, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([14, 0]),
  });
}

function receiptTransfer(): TransactionInstruction {
  return new TransactionInstruction({
    programId: BUBBLEGUM,
    keys: [
      { pubkey: OTHER, isSigner: false, isWritable: false },
      { pubkey: SENDER, isSigner: true, isWritable: true },
      { pubkey: SENDER, isSigner: true, isWritable: false },
      { pubkey: SENDER, isSigner: false, isWritable: false },
      { pubkey: SENDER, isSigner: false, isWritable: false },
      { pubkey: RECIPIENT, isSigner: false, isWritable: false },
      { pubkey: MERKLE_TREE, isSigner: false, isWritable: true },
      { pubkey: COLLECTION, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_BUBBLEGUM_TRANSFER_V2),
  });
}

function leafEvent(asset: PublicKey = ASSET_A, trailingBytes = 0): Buffer {
  const event = Buffer.alloc(41 + trailingBytes);
  event[0] = 1;
  event.writeUInt32LE(event.length - 6, 2);
  event[6] = 1;
  event[7] = 1;
  event[8] = 1;
  asset.toBuffer().copy(event, 9);
  return event;
}

function leafTransaction(
  events: { data: Buffer; program?: PublicKey; encoding?: 'bytes' | 'base58' }[],
): VersionedTransactionResponse {
  const transaction = confirmedTransaction([coreTransfer()]);
  const keys = transaction.transaction.message.staticAccountKeys;
  transaction.meta!.innerInstructions = events.map((event, index) => {
    const instruction: CompiledInnerInstruction['instructions'][number] = {
      programIdIndex: keys.findIndex((key) => key.equals(event.program || NOOP)),
      accounts: [],
      data: bs58.encode(event.data),
    };
    if (event.encoding === 'bytes') Object.assign(instruction, { data: new Uint8Array(event.data) });
    return { index, instructions: [instruction] };
  });
  return transaction;
}

test('transaction account keys resolve static accounts without metadata', () => {
  const transaction = confirmedTransaction([coreTransfer()]);
  transaction.meta = null;
  assert.deepEqual(transactionAccountKeys(transaction), transaction.transaction.message.staticAccountKeys);
  assert.deepEqual(coreTransferAssetIds(transaction, EXPECTED), [ASSET_A.toBase58()]);
});

test('transfer verification resolves writable and readonly lookup table accounts', () => {
  const lookupTable = new AddressLookupTableAccount({
    key: new PublicKey(Buffer.alloc(32, 8)),
    state: {
      deactivationSlot: 0xffffffffffffffffn,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [ASSET_A, COLLECTION, MERKLE_TREE, RECIPIENT, NOOP],
    },
  });
  const transaction = confirmedTransaction([coreTransfer(), receiptTransfer()], [lookupTable]);
  const loaded = transaction.meta!.loadedAddresses!;
  assert.ok(loaded.writable.length > 0);
  assert.ok(loaded.readonly.length > 0);
  assert.deepEqual(transactionAccountKeys(transaction), [
    ...transaction.transaction.message.staticAccountKeys,
    ...loaded.writable,
    ...loaded.readonly,
  ]);
  assert.deepEqual(coreTransferAssetIds(transaction, EXPECTED), [ASSET_A.toBase58()]);
  assert.equal(matchingReceiptTransferCount(transaction, EXPECTED), 1);
  transaction.meta!.innerInstructions = [{
    index: 1,
    instructions: [{
      programIdIndex: transactionAccountKeys(transaction).findIndex((key) => key.equals(NOOP)),
      accounts: [],
      data: bs58.encode(leafEvent()),
    }],
  }];
  assert.deepEqual(bubblegumReceiptAssetIds(transaction), [ASSET_A.toBase58()]);
});

test('Core transfer evidence preserves instruction order and duplicate assets', () => {
  const transaction = confirmedTransaction([coreTransfer(ASSET_B), receiptTransfer(), coreTransfer(), coreTransfer(ASSET_B)]);
  assert.deepEqual(coreTransferAssetIds(transaction, EXPECTED), [
    ASSET_B.toBase58(), ASSET_A.toBase58(), ASSET_B.toBase58(),
  ]);
});

for (const [name, accountIndex] of [['collection', 1], ['sender', 2], ['authority', 3], ['recipient', 4]] as const) {
  test(`Core transfer evidence excludes a wrong ${name}`, () => {
    const instruction = coreTransfer();
    instruction.keys[accountIndex].pubkey = OTHER;
    assert.deepEqual(coreTransferAssetIds(confirmedTransaction([instruction]), EXPECTED), []);
  });
}

test('Core transfer evidence ignores unrelated programs, discriminators, and truncated accounts', () => {
  const wrongProgram = coreTransfer();
  wrongProgram.programId = OTHER;
  const shortAccounts = coreTransfer();
  shortAccounts.keys = shortAccounts.keys.slice(0, 6);
  const invalid = [Buffer.alloc(0), Buffer.from([14]), Buffer.from([13, 0]), Buffer.from([14, 1])]
    .map((data) => Object.assign(coreTransfer(), { data }));
  assert.deepEqual(coreTransferAssetIds(confirmedTransaction([wrongProgram, shortAccounts, ...invalid]), EXPECTED), []);
});

for (const encoding of ['bytes', 'base58'] as const) {
  test(`transfer evidence accepts ${encoding} instruction data`, () => {
    const transaction = confirmedTransaction([coreTransfer(), receiptTransfer()]);
    for (const instruction of transaction.transaction.message.compiledInstructions) {
      Object.assign(instruction, {
        data: encoding === 'base58' ? bs58.encode(instruction.data) : new Uint8Array(instruction.data),
        accountKeyIndexes: new Uint8Array(instruction.accountKeyIndexes),
      });
    }
    assert.deepEqual(coreTransferAssetIds(transaction, EXPECTED), [ASSET_A.toBase58()]);
    assert.equal(matchingReceiptTransferCount(transaction, EXPECTED), 1);
    assert.deepEqual(bubblegumReceiptAssetIds(leafTransaction([{ data: leafEvent(), encoding }])), [ASSET_A.toBase58()]);
  });
}

test('Bubblegum transfer evidence distinguishes missing, single, and duplicate matching instructions', () => {
  assert.equal(matchingReceiptTransferCount(confirmedTransaction([coreTransfer()]), EXPECTED), 0);
  assert.equal(matchingReceiptTransferCount(confirmedTransaction([receiptTransfer()]), EXPECTED), 1);
  assert.equal(matchingReceiptTransferCount(confirmedTransaction([receiptTransfer(), receiptTransfer()]), EXPECTED), 2);
});

for (const [name, accountIndex] of [
  ['payer', 1], ['authority', 2], ['leaf owner', 3], ['recipient', 5], ['tree', 6], ['collection', 7],
] as const) {
  test(`Bubblegum transfer evidence excludes a wrong ${name}`, () => {
    const instruction = receiptTransfer();
    instruction.keys[accountIndex].pubkey = OTHER;
    assert.equal(matchingReceiptTransferCount(confirmedTransaction([instruction]), EXPECTED), 0);
  });
}

test('Bubblegum transfer evidence ignores unrelated programs, discriminators, and truncated accounts', () => {
  const wrongProgram = receiptTransfer();
  wrongProgram.programId = CORE;
  const wrongDiscriminator = receiptTransfer();
  wrongDiscriminator.data[0] ^= 1;
  const truncated = receiptTransfer();
  truncated.data = truncated.data.subarray(0, 7);
  const shortAccounts = receiptTransfer();
  shortAccounts.keys = shortAccounts.keys.slice(0, 7);
  assert.equal(matchingReceiptTransferCount(confirmedTransaction([
    wrongProgram, wrongDiscriminator, truncated, shortAccounts,
  ]), EXPECTED), 0);
});

test('transfer evidence accepts instruction payloads beyond the matching discriminator', () => {
  const core = coreTransfer();
  core.data = Buffer.concat([core.data, Buffer.from([42])]);
  const receipt = receiptTransfer();
  receipt.data = Buffer.concat([receipt.data, Buffer.from([42])]);
  const transaction = confirmedTransaction([core, receipt]);
  assert.deepEqual(coreTransferAssetIds(transaction, EXPECTED), [ASSET_A.toBase58()]);
  assert.equal(matchingReceiptTransferCount(transaction, EXPECTED), 1);
});

test('Bubblegum leaf evidence deduplicates repeated IDs and retains distinct IDs in encounter order', () => {
  const transaction = leafTransaction([
    { data: leafEvent(ASSET_B) },
    { data: leafEvent(ASSET_A, 3) },
    { data: leafEvent(ASSET_B), encoding: 'bytes' },
  ]);
  assert.deepEqual(bubblegumReceiptAssetIds(transaction), [ASSET_B.toBase58(), ASSET_A.toBase58()]);
});

test('Bubblegum leaf evidence ignores missing inner instructions and metadata', () => {
  const transaction = confirmedTransaction([receiptTransfer()]);
  assert.deepEqual(bubblegumReceiptAssetIds(transaction), []);
  transaction.meta!.innerInstructions = null;
  assert.deepEqual(bubblegumReceiptAssetIds(transaction), []);
  transaction.meta = null;
  assert.deepEqual(bubblegumReceiptAssetIds(transaction), []);
});

test('Bubblegum leaf evidence ignores events from another program', () => {
  assert.deepEqual(bubblegumReceiptAssetIds(leafTransaction([
    { data: leafEvent(), program: SystemProgram.programId },
  ])), []);
});

test('Bubblegum leaf evidence ignores truncated headers and asset IDs', () => {
  const events = [0, 1, 2, 5, 6, 8, 9, 40].map((length) => ({ data: leafEvent().subarray(0, length) }));
  assert.deepEqual(bubblegumReceiptAssetIds(leafTransaction(events)), []);
});

for (const byteIndex of [0, 1, 6, 7, 8]) {
  test(`Bubblegum leaf evidence rejects a mismatched event discriminator at byte ${byteIndex}`, () => {
    const data = leafEvent();
    data[byteIndex] ^= 1;
    assert.deepEqual(bubblegumReceiptAssetIds(leafTransaction([{ data }])), []);
  });
}

test('Bubblegum leaf evidence rejects incorrect declared payload lengths', () => {
  const events = [0, 34, 36, 0xffffffff].map((declaredLength) => {
    const data = leafEvent();
    data.writeUInt32LE(declaredLength, 2);
    return { data };
  });
  assert.deepEqual(bubblegumReceiptAssetIds(leafTransaction(events)), []);
});
