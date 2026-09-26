import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { getPreorderConfig, PREORDER_PAYMENT_RECIPIENTS } from '../../../../shared/preorders.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import {
  authorizePreorderTransaction,
  decodePreorderAssetAccount,
  isPreorderBlockhashValid,
  preparePreorderTransaction,
  probePreorderTransaction,
  sendPreorderTransaction,
} from '../src/preorderTransaction.ts';

const ADMIN = Keypair.generate();
const BUYER = Keypair.generate();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const CORE = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const CONFIG = { ...getPreorderConfig('mi_note_cards_devnet')!, authority: ADMIN.publicKey.toBase58() };
const SECRET = bs58.encode(ADMIN.secretKey);
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const MAINNET_CONFIG = { ...getPreorderConfig('mi_note_cards')!, authority: ADMIN.publicKey.toBase58(), enabled: true };

function account(data: Buffer, owner = CORE, executable = false) {
  return { data, owner, executable, lamports: 3_000_000, rentEpoch: 0 };
}

function collectionData() {
  const data = Buffer.alloc(49);
  data[0] = 5;
  ADMIN.publicKey.toBuffer().copy(data, 1);
  return data;
}

function fixture(config = CONFIG) {
  const state = {
    genesis: config.cluster === 'devnet' ? GENESIS : MAINNET_GENESIS,
    program: account(Buffer.alloc(0), SystemProgram.programId, true),
    collection: account(collectionData()),
    simulationError: null as unknown,
    simulated: null as VersionedTransaction | null,
    simulationSlot: 102,
    latestSlot: 101,
    blockhashValid: true,
    finalized: null as VersionedTransactionResponse | null,
    confirmed: null as VersionedTransactionResponse | null,
    epochHeight: 500,
    epochSlot: 600,
    accountSlot: 600,
    accountExists: false,
    assetAccount: account(Buffer.alloc(1)),
    historySlot: 600,
    history: null as unknown,
    firstAvailableBlock: 50,
    minimumLedgerSlot: 50,
    sent: null as Uint8Array | null,
    returnedSignature: null as string | null,
  };
  const connection = {
    getGenesisHash: async () => state.genesis,
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[], options: { commitment?: string; minContextSlot?: number }) => {
      if (keys[0]?.equals(CORE)) {
        assert.equal(options.commitment, 'confirmed');
        return { context: { slot: 100 }, value: [state.program, state.collection] };
      }
      assert.equal(options.commitment, 'finalized');
      assert.equal(options.minContextSlot, state.epochSlot);
      return { context: { slot: state.accountSlot }, value: keys.map(() => state.accountExists ? state.assetAccount : null) };
    },
    getLatestBlockhashAndContext: async (options: { minContextSlot?: number }) => {
      assert.equal(options.minContextSlot, 100);
      return { context: { slot: state.latestSlot }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500 } };
    },
    simulateTransaction: async (transaction: VersionedTransaction, options: { sigVerify?: boolean; minContextSlot?: number }) => {
      assert.equal(options.sigVerify, false);
      assert.equal(options.minContextSlot, 101);
      state.simulated = transaction;
      return { context: { slot: state.simulationSlot }, value: { err: state.simulationError } };
    },
    isBlockhashValid: async (_blockhash: string, options: { commitment?: string; minContextSlot?: number }) => {
      assert.equal(options.commitment, 'confirmed');
      return { context: { slot: state.latestSlot }, value: state.blockhashValid };
    },
    getTransaction: async (_signature: string, options: { commitment?: string; maxSupportedTransactionVersion?: number }) => {
      assert.ok(options.commitment === 'finalized' || options.commitment === 'confirmed');
      assert.equal(options.maxSupportedTransactionVersion, 0);
      return options.commitment === 'finalized' ? state.finalized : state.confirmed;
    },
    getEpochInfo: async (commitment: string) => {
      assert.equal(commitment, 'finalized');
      return { blockHeight: state.epochHeight, absoluteSlot: state.epochSlot };
    },
    getSignatureStatuses: async (_signatures: string[], options: { searchTransactionHistory?: boolean }) => {
      assert.equal(options.searchTransactionHistory, true);
      return { context: { slot: state.historySlot }, value: [state.history] };
    },
    getFirstAvailableBlock: async () => state.firstAvailableBlock,
    getMinimumLedgerSlot: async () => state.minimumLedgerSlot,
    sendRawTransaction: async (raw: Uint8Array, options: { skipPreflight?: boolean; preflightCommitment?: string }) => {
      assert.equal(options.skipPreflight, false);
      assert.equal(options.preflightCommitment, 'confirmed');
      state.sent = raw;
      return state.returnedSignature || bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
    },
  };
  const args = {
    config,
    buyer: BUYER.publicKey.toBase58(),
    ids: [1393, 1394, 1395],
    cosignerSecret: SECRET,
    apiKey: 'test',
    fetch: async () => { throw new Error('Unexpected fetch'); },
    signal: new AbortController().signal,
  };
  return { state, args, deps: { createConnection: () => connection as unknown as Connection } };
}

function decode(encoded: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
}

function encode(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString('base64');
}

async function preparedFixture(config = CONFIG) {
  const setup = fixture(config);
  const prepared = await preparePreorderTransaction(setup.args, setup.deps);
  const signed = decode(prepared.transactionBase64);
  signed.sign([BUYER]);
  const authorization = {
    preparedTransactionBase64: prepared.transactionBase64,
    signedTransactionBase64: encode(signed),
    buyer: BUYER.publicKey.toBase58(),
    cosignerSecret: SECRET,
    authority: CONFIG.authority,
  };
  return { ...setup, prepared, signed, authorization };
}

async function authorizedFixture(config = CONFIG) {
  const setup = await preparedFixture(config);
  const authorized = authorizePreorderTransaction(setup.authorization);
  const transaction = decode(authorized.transactionBase64);
  return {
    ...setup,
    authorized,
    transaction,
    probeArgs: { ...setup.args, ...authorized, assets: setup.prepared.assets, lastValidBlockHeight: setup.prepared.lastValidBlockHeight,
      blockhashContextSlot: setup.prepared.blockhashContextSlot },
  };
}

test('preorder transaction mints exact IDs and atomically splits the full item subtotal', async () => {
  const { args, deps, state } = fixture();
  const prepared = await preparePreorderTransaction(args, deps);
  const transaction = decode(prepared.transactionBase64);
  const message = TransactionMessage.decompile(transaction.message);
  assert.deepEqual(prepared.assets.map(({ id }) => id), args.ids);
  assert.equal(message.payerKey.toBase58(), args.buyer);
  assert.equal(transaction.serialize().length, 1048);
  assert.equal(transaction.signatures.length, 5);
  assert.equal(message.instructions.length, 6);
  assert.equal(prepared.lastValidBlockHeight, 500);
  assert.equal(prepared.blockhashContextSlot, 101);
  assert.equal(prepared.blockhash, BLOCKHASH);
  assert.ok(state.simulated);
  for (let index = 0; index < 2; index += 1) {
    const payment = SystemInstruction.decodeTransfer(message.instructions[index + 1]);
    assert.equal(payment.fromPubkey.toBase58(), args.buyer);
    assert.equal(payment.toPubkey.toBase58(), PREORDER_PAYMENT_RECIPIENTS[index]);
    assert.equal(payment.lamports, 375_000_000n);
  }
  for (let index = 0; index < 3; index += 1) {
    const instruction = message.instructions[index + 3];
    assert.equal(instruction.programId.toBase58(), CORE.toBase58());
    assert.equal(instruction.keys[0].pubkey.toBase58(), prepared.assets[index].address);
    assert.equal(instruction.keys[1].pubkey.toBase58(), CONFIG.collection);
    assert.equal(instruction.keys[2].pubkey.toBase58(), CONFIG.authority);
    assert.equal(instruction.keys[3].pubkey.toBase58(), args.buyer);
    assert.equal(instruction.keys[4].pubkey.toBase58(), args.buyer);
    assert.equal(instruction.keys[5].pubkey.toBase58(), CORE.toBase58());
    const nameLength = instruction.data.readUInt32LE(2);
    assert.equal(instruction.data.subarray(6, 6 + nameLength).toString(), `Preorder #${args.ids[index]}`);
    const uriLength = instruction.data.readUInt32LE(6 + nameLength);
    assert.equal(instruction.data.subarray(10 + nameLength, 10 + nameLength + uriLength).toString(), `${CONFIG.metadataBase}${args.ids[index]}.json`);
    assert.deepEqual([...instruction.data.subarray(-2)], [0, 0]);
  }
  transaction.signatures.forEach((signature, index) => {
    const key = transaction.message.staticAccountKeys[index];
    if (index === 0 || key.equals(ADMIN.publicKey)) assert.ok(signature.every((byte) => byte === 0));
    else assert.ok(nacl.sign.detached.verify(transaction.message.serialize(), signature, key.toBytes()));
  });
});

for (const ids of [[], [0], [1396], [1.5], [1, 1], [1, 2, 3, 4]]) {
  test(`preorder refuses invalid selected IDs ${JSON.stringify(ids)}`, async () => {
    const { args, deps } = fixture();
    await assert.rejects(preparePreorderTransaction({ ...args, ids }, deps), /one and three different/);
  });
}

test('preorder accepts the two catalog endpoints without changing their identity', async () => {
  const { args, deps } = fixture();
  const prepared = await preparePreorderTransaction({ ...args, ids: [1, 1395] }, deps);
  assert.deepEqual(prepared.assets.map(({ id }) => id), [1, 1395]);
});

test('preorder rejects unsupported clusters and disabled collections before accessing the provider', async () => {
  const { args } = fixture();
  const deps = { createConnection: () => { throw new Error('Unexpected provider access'); } };
  await assert.rejects(preparePreorderTransaction({ ...args, config: { ...CONFIG, cluster: 'testnet' } }, deps), /not enabled/);
  await assert.rejects(preparePreorderTransaction({ ...args, config: { ...CONFIG, enabled: false } }, deps), /not enabled/);
});

for (const config of [CONFIG, MAINNET_CONFIG]) {
  test(`${config.cluster} preparation, broadcast, blockhash validation and recovery require the configured genesis`, async () => {
    const { state, args, deps, authorized, probeArgs, transaction } = await authorizedFixture(config);
    const message = TransactionMessage.decompile(transaction.message);
    assert.equal(message.instructions[3].keys[1].pubkey.toBase58(), config.collection);
    assert.equal(await sendPreorderTransaction({ ...args, ...authorized }, deps), authorized.signature);
    const validity = { ...args, blockhash: BLOCKHASH, minContextSlot: 101 };
    assert.equal(await isPreorderBlockhashValid(validity, deps), true);
    state.finalized = finalized(transaction);
    assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'finalized', slot: 550 });

    state.genesis = config.cluster === 'devnet' ? MAINNET_GENESIS : GENESIS;
    state.sent = null;
    state.simulated = null;
    await assert.rejects(preparePreorderTransaction(args, deps), /wrong cluster/);
    await assert.rejects(sendPreorderTransaction({ ...args, ...authorized }, deps), /wrong cluster/);
    await assert.rejects(isPreorderBlockhashValid(validity, deps), /wrong cluster/);
    await assert.rejects(probePreorderTransaction(probeArgs, deps), /wrong cluster/);
    assert.equal(state.sent, null);
    assert.equal(state.simulated, null);
  });

  test(`${config.cluster} simulation failure identifies the correct SOL balance`, async () => {
    const { args, deps, state } = fixture(config);
    state.simulationError = { InstructionError: [1, 'InsufficientFunds'] };
    await assert.rejects(preparePreorderTransaction(args, deps),
      config.cluster === 'devnet' ? /Check your devnet SOL balance/ : /Check your SOL balance/);
  });
}

test('preorder rejects the wrong RPC cluster, Core executable, collection owner and authority', async () => {
  for (const change of [
    (state: ReturnType<typeof fixture>['state']) => { state.genesis = 'mainnet'; },
    (state: ReturnType<typeof fixture>['state']) => { state.program.executable = false; },
    (state: ReturnType<typeof fixture>['state']) => { state.collection.owner = SystemProgram.programId; },
    (state: ReturnType<typeof fixture>['state']) => { state.collection.data[0] = 1; },
    (state: ReturnType<typeof fixture>['state']) => { BUYER.publicKey.toBuffer().copy(state.collection.data, 1); },
  ]) {
    const { args, deps, state } = fixture();
    change(state);
    await assert.rejects(preparePreorderTransaction(args, deps), /wrong cluster|not available|authority could not/);
    assert.equal(state.simulated, null);
  }
});

test('preorder refuses missing or wrong authority signing secrets and malformed buyers', async () => {
  const { args, deps } = fixture();
  await assert.rejects(preparePreorderTransaction({ ...args, cosignerSecret: '' }, deps), /not configured/);
  await assert.rejects(preparePreorderTransaction({ ...args, cosignerSecret: bs58.encode(BUYER.secretKey) }, deps), /does not match/);
  await assert.rejects(preparePreorderTransaction({ ...args, buyer: 'invalid' }, deps), /Buyer/);
  const offCurve = PublicKey.findProgramAddressSync([Buffer.from('buyer')], CORE)[0].toBase58();
  await assert.rejects(preparePreorderTransaction({ ...args, buyer: offCurve }, deps), /signing wallet/);
});

test('preorder simulation failures and stale responses never return a prepared transaction', async () => {
  const { args, deps, state } = fixture();
  state.simulationError = { InstructionError: [1, 'InsufficientFunds'] };
  await assert.rejects(preparePreorderTransaction(args, deps), /simulation failed/);
  state.simulationError = null;
  state.simulationSlot = 100;
  await assert.rejects(preparePreorderTransaction(args, deps), /stale simulation/);
  state.latestSlot = 99;
  await assert.rejects(preparePreorderTransaction(args, deps), /stale blockhash/);
});

test('authorization verifies the wallet and asset signatures before adding the admin signature', async () => {
  const { authorization } = await preparedFixture();
  const result = authorizePreorderTransaction(authorization);
  const transaction = decode(result.transactionBase64);
  assert.equal(result.signature, bs58.encode(transaction.signatures[0]));
  transaction.signatures.forEach((signature, index) => assert.ok(nacl.sign.detached.verify(
    transaction.message.serialize(), signature, transaction.message.staticAccountKeys[index].toBytes(),
  )));
});

for (const field of ['payment', 'metadata', 'owner', 'blockhash']) {
  test(`authorization refuses tampered ${field}`, async () => {
    const { authorization, signed } = await preparedFixture();
    if (field === 'payment') signed.message.compiledInstructions[1].data[4] ^= 1;
    if (field === 'metadata') signed.message.compiledInstructions[3].data[30] ^= 1;
    if (field === 'owner') signed.message.staticAccountKeys[0] = Keypair.generate().publicKey;
    if (field === 'blockhash') signed.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    assert.throws(() => authorizePreorderTransaction({ ...authorization, signedTransactionBase64: encode(signed) }), /does not match/);
  });
}

test('authorization refuses invalid buyer, missing signatures, changed asset signatures and an already signed admin', async () => {
  const { authorization, prepared } = await preparedFixture();
  assert.throws(() => authorizePreorderTransaction({ ...authorization, buyer: Keypair.generate().publicKey.toBase58() }), /buyer does not match/);
  assert.throws(() => authorizePreorderTransaction({ ...authorization, signedTransactionBase64: prepared.transactionBase64 }), /Invalid buyer signature/);
  const missingAsset = decode(authorization.signedTransactionBase64);
  const assetIndex = missingAsset.message.staticAccountKeys.findIndex((key) => key.toBase58() === prepared.assets[0].address);
  missingAsset.signatures[assetIndex].fill(0);
  assert.throws(() => authorizePreorderTransaction({ ...authorization, signedTransactionBase64: encode(missingAsset) }), /asset signature/);
  const signedAdmin = decode(authorization.signedTransactionBase64);
  signedAdmin.sign([ADMIN]);
  assert.throws(() => authorizePreorderTransaction({ ...authorization, signedTransactionBase64: encode(signedAdmin) }), /sign on the server/);
  assert.throws(() => authorizePreorderTransaction({ ...authorization, preparedTransactionBase64: encode(signedAdmin) }), /invalid authority/);
});

test('the authority cannot buy through a reservation that withholds its own signature', async () => {
  const { args, deps } = fixture();
  await assert.rejects(preparePreorderTransaction({ ...args, buyer: CONFIG.authority }, deps), /separate from the collection authority/);
  const { authorization } = await preparedFixture();
  assert.throws(() => authorizePreorderTransaction({
    ...authorization,
    buyer: CONFIG.authority,
  }), /separate from the collection authority/);
});

test('broadcast rejects missing signatures and wrong-cluster RPC, and verifies its returned signature', async () => {
  const { args, deps, state, prepared, authorized } = await authorizedFixture();
  await assert.rejects(sendPreorderTransaction({ ...args, transactionBase64: prepared.transactionBase64 }, deps), /signature/);
  state.genesis = 'mainnet';
  await assert.rejects(sendPreorderTransaction({ ...args, ...authorized }, deps), /wrong cluster/);
  assert.equal(state.sent, null);
  state.genesis = GENESIS;
  assert.equal(await sendPreorderTransaction({ ...args, ...authorized }, deps), authorized.signature);
  assert.deepEqual(state.sent, Buffer.from(authorized.transactionBase64, 'base64'));
  state.returnedSignature = bs58.encode(new Uint8Array(64).fill(1));
  await assert.rejects(sendPreorderTransaction({ ...args, ...authorized }, deps), /unexpected signature/);
});

test('blockhash validity rejects stale context and reports expiry', async () => {
  const { args, deps, state } = fixture();
  const input = { ...args, blockhash: BLOCKHASH, minContextSlot: 101 };
  assert.equal(await isPreorderBlockhashValid(input, deps), true);
  state.blockhashValid = false;
  assert.equal(await isPreorderBlockhashValid(input, deps), false);
  state.latestSlot = 100;
  await assert.rejects(isPreorderBlockhashValid(input, deps), /stale blockhash/);
});

function finalized(transaction: VersionedTransaction, err: null | { InstructionError: [number, string] } = null): VersionedTransactionResponse {
  return {
    slot: 550,
    meta: { err, fee: 25000, preBalances: [], postBalances: [] },
    transaction: { message: transaction.message, signatures: transaction.signatures.map((signature) => bs58.encode(signature)) },
    version: 0,
  };
}

test('recovery confirms only the exact finalized transaction, independent of later NFT ownership', async () => {
  const { state, deps, probeArgs, transaction } = await authorizedFixture();
  state.finalized = finalized(transaction);
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'finalized', slot: 550 });
  state.finalized = finalized(transaction, { InstructionError: [1, 'InsufficientFunds'] });
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'failed', slot: 550 });
  state.finalized = finalized(transaction);
  state.finalized.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(2));
  await assert.rejects(probePreorderTransaction(probeArgs, deps), /could not be verified/);
});

test('verified confirmed execution is optimistic while finalized execution remains authoritative', async () => {
  const { state, deps, probeArgs, transaction } = await authorizedFixture();
  state.confirmed = finalized(transaction);
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'confirmed', slot: 550 });
  state.confirmed = finalized(transaction, { InstructionError: [1, 'InsufficientFunds'] });
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'pending' });
  state.confirmed = finalized(transaction);
  state.finalized = { ...finalized(transaction), slot: 560 };
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'finalized', slot: 560 });
  state.finalized = finalized(transaction, { InstructionError: [1, 'InsufficientFunds'] });
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'failed', slot: 550 });
});

test('confirmed execution requires exact transaction evidence and does not trust signature status alone', async () => {
  const { state, deps, probeArgs, transaction } = await authorizedFixture();
  state.history = { slot: 550, confirmations: 1, confirmationStatus: 'confirmed', err: null };
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'pending' });
  for (const change of [
    (value: VersionedTransactionResponse) => { value.meta = null; },
    (value: VersionedTransactionResponse) => { value.slot = -1; },
    (value: VersionedTransactionResponse) => { value.transaction.signatures[0] = bs58.encode(new Uint8Array(64).fill(2)); },
    (value: VersionedTransactionResponse) => { value.transaction.signatures.pop(); },
    (value: VersionedTransactionResponse) => { value.transaction.message = decode(probeArgs.transactionBase64).message;
      value.transaction.message.recentBlockhash = Keypair.generate().publicKey.toBase58(); },
  ]) {
    state.confirmed = finalized(transaction);
    change(state.confirmed);
    await assert.rejects(probePreorderTransaction(probeArgs, deps), /Confirmed preorder transaction could not be verified/);
  }
});

test('recovery never expires a still-valid transaction and checks finalized absence plus historical status', async () => {
  const { state, deps, probeArgs } = await authorizedFixture();
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'pending' });
  state.epochHeight = 501;
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'expired' });
  state.accountExists = true;
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'pending' });
  state.accountExists = false;
  state.history = { slot: 550, confirmations: 1, confirmationStatus: 'confirmed', err: null };
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'pending' });
});

test('recovery rejects stale finalized evidence and mismatched saved transaction signatures', async () => {
  const { state, deps, probeArgs } = await authorizedFixture();
  state.epochHeight = 501;
  state.accountSlot = 599;
  await assert.rejects(probePreorderTransaction(probeArgs, deps), /stale account/);
  state.accountSlot = 600;
  state.historySlot = 599;
  await assert.rejects(probePreorderTransaction(probeArgs, deps), /stale signature/);
  await assert.rejects(probePreorderTransaction({ ...probeArgs, signature: 'unrelated' }, deps), /does not match/);
});

test('prefunded system accounts do not block verified expiry of an unpaid preorder', async () => {
  const { state, deps, probeArgs, transaction } = await authorizedFixture();
  state.accountExists = true;
  state.assetAccount = account(Buffer.alloc(0), SystemProgram.programId);
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'pending' });
  state.epochHeight = 501;
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'expired' });
  state.history = { slot: 550, confirmations: 1, confirmationStatus: 'confirmed', err: null };
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'pending' });
  state.history = null;
  state.minimumLedgerSlot = probeArgs.blockhashContextSlot + 1;
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'pending' });
  state.finalized = finalized(transaction);
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'finalized', slot: 550 });
});

test('Core, malformed, and other initialized accounts still prevent uncertain expiry', async () => {
  const { state, deps, probeArgs } = await authorizedFixture();
  state.epochHeight = 501;
  state.accountExists = true;
  for (const assetAccount of [
    account(Buffer.from([1])),
    account(Buffer.alloc(0)),
    account(Buffer.alloc(0), Keypair.generate().publicKey),
    account(Buffer.from([1]), SystemProgram.programId),
    account(Buffer.alloc(0), SystemProgram.programId, true),
  ]) {
    state.assetAccount = assetAccount;
    assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'pending' });
  }
});

test('recovery keeps absent attempts reserved when either RPC history floor has passed preparation', async () => {
  const { state, deps, probeArgs, transaction } = await authorizedFixture();
  state.epochHeight = 501;
  state.firstAvailableBlock = probeArgs.blockhashContextSlot + 1;
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'pending' });
  state.firstAvailableBlock = 0;
  state.minimumLedgerSlot = probeArgs.blockhashContextSlot + 1;
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'pending' });
  state.finalized = finalized(transaction);
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'finalized', slot: 550 });
  state.finalized = null;
  state.firstAvailableBlock = probeArgs.blockhashContextSlot;
  state.minimumLedgerSlot = probeArgs.blockhashContextSlot;
  assert.deepEqual(await probePreorderTransaction(probeArgs, deps), { status: 'expired' });
  state.minimumLedgerSlot = Number.NaN;
  await assert.rejects(probePreorderTransaction(probeArgs, deps), /invalid history coverage/);
});

test('archival recovery releases pruned attempts only after complete absence verification', async () => {
  const { state, deps, probeArgs } = await authorizedFixture();
  state.epochHeight = 501;
  state.minimumLedgerSlot = probeArgs.blockhashContextSlot + 1;
  let verified = false;
  let checks = 0;
  const archive: NonNullable<Parameters<typeof probePreorderTransaction>[1]> = { ...deps, verifyArchivedAbsence: async (args) => {
    checks += 1;
    assert.deepEqual(args, {
      signature: probeArgs.signature, blockhashContextSlot: probeArgs.blockhashContextSlot,
      lastValidBlockHeight: probeArgs.lastValidBlockHeight, finalizedSlot: state.epochSlot,
    });
    return verified;
  } };
  assert.deepEqual(await probePreorderTransaction(probeArgs, archive), { status: 'pending' });
  verified = true;
  assert.deepEqual(await probePreorderTransaction(probeArgs, archive), { status: 'expired' });
  assert.equal(checks, 2);
  await assert.rejects(probePreorderTransaction(probeArgs, { ...deps, verifyArchivedAbsence: async () => {
    throw new Error('Archive unavailable');
  } }), /Archive unavailable/);
});

test('archival recovery never bypasses live transactions, existing assets, or signature history', async () => {
  const { state, deps, probeArgs } = await authorizedFixture();
  state.minimumLedgerSlot = probeArgs.blockhashContextSlot + 1;
  const archive = { ...deps, verifyArchivedAbsence: async () => { assert.fail('Archive must not bypass other guards'); } };
  assert.deepEqual(await probePreorderTransaction(probeArgs, archive), { status: 'pending' });
  state.epochHeight = 501;
  state.accountExists = true;
  assert.deepEqual(await probePreorderTransaction(probeArgs, archive), { status: 'pending' });
  state.accountExists = false;
  state.history = { slot: 550, confirmations: 1, confirmationStatus: 'confirmed', err: null };
  assert.deepEqual(await probePreorderTransaction(probeArgs, archive), { status: 'pending' });
});

test('Core asset decoding verifies structure while retaining current owner and collection', () => {
  const name = Buffer.from('Preorder #1');
  const uri = Buffer.from(`${CONFIG.metadataBase}1.json`);
  const length = (value: Buffer) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value.length); return bytes; };
  const bytes = Buffer.concat([
    Buffer.from([1]), BUYER.publicKey.toBuffer(), Buffer.from([2]), new PublicKey(CONFIG.collection).toBuffer(),
    length(name), name, length(uri), uri, Buffer.from([0]),
  ]);
  assert.deepEqual(decodePreorderAssetAccount(bytes), {
    owner: BUYER.publicKey.toBase58(), collection: CONFIG.collection, name: name.toString(), uri: uri.toString(),
  });
  for (let length = 0; length < bytes.length; length += 1) {
    assert.equal(decodePreorderAssetAccount(bytes.subarray(0, length)), null);
  }
  const wrongKind = Buffer.from(bytes);
  wrongKind[0] = 5;
  assert.equal(decodePreorderAssetAccount(wrongKind), null);
  wrongKind[0] = 1;
  wrongKind[33] = 1;
  assert.equal(decodePreorderAssetAccount(wrongKind), null);
  const oversized = Buffer.from(bytes);
  oversized.writeUInt32LE(0xffff_ffff, 66);
  assert.equal(decodePreorderAssetAccount(oversized), null);
});
