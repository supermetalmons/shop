import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from '@solana/web3.js';
import {
  ensureAdminDeliveryOrder,
  type AdminDeliveryOrderDependencies,
} from '../src/stripeCheckout/adminDeliveryOrder.ts';
import {
  ACCOUNT_ADMIN_DELIVERY_ORDER,
  deriveAdminOrderPda,
  stripeCheckoutSessionOrderHash,
  type DecodedAdminDeliveryOrderRecord,
} from '../src/stripeCheckout/contract.ts';

function fixture() {
  const key = (value: number) => new PublicKey(new Uint8Array(32).fill(value));
  const signer = Keypair.fromSeed(new Uint8Array(32).fill(1));
  const dropRuntime = {
    boxMinterProgramId: key(2),
    boxMinterConfigPda: key(3),
    receiptsMerkleTree: key(4),
  };
  const config = { admin: signer.publicKey, coreCollection: key(5) };
  const orderHash = stripeCheckoutSessionOrderHash('cs_test_order_adapter', false);
  const [orderPda, bump] = deriveAdminOrderPda(dropRuntime.boxMinterProgramId, dropRuntime.boxMinterConfigPda, orderHash);
  const reads: Array<AccountInfo<Buffer> | Error | null> = [];
  const events: string[] = [];
  const cancellation = new AbortController();
  const connection = new Connection('http://127.0.0.1:8899');
  connection.getAccountInfoAndContext = async (address) => {
    assert.equal(address.toBase58(), orderPda.toBase58());
    assert.ok(reads.length, 'unexpected account read');
    const value = reads.shift()!;
    if (value instanceof Error) throw value;
    return { context: { slot: 1 }, value };
  };
  connection.getLatestBlockhashAndContext = async () => ({
    context: { slot: 1 },
    value: { blockhash: key(6).toBase58(), lastValidBlockHeight: 10 },
  });
  const deps: AdminDeliveryOrderDependencies<typeof dropRuntime, typeof config> = {
    runRpc: async (runtime, operation, timeoutMs, label) => {
      assert.equal(runtime, dropRuntime);
      assert.equal(timeoutMs, 100);
      events.push(label);
      return operation(connection);
    },
    ensureOnchainCoreConfig: async () => { events.push('config'); return config; },
    requireStripeCheckoutCollectionMatchesConfig: () => { events.push('collection'); },
    cosigner: () => signer,
    buildTx: (instructions, payerKey, recentBlockhash, signers) => {
      events.push('build');
      const transaction = new VersionedTransaction(new TransactionMessage({
        instructions, payerKey, recentBlockhash,
      }).compileToV0Message());
      transaction.sign(signers);
      return transaction;
    },
    sendAndConfirmSignedTx: async (_runtime, _transaction, label, options) => {
      assert.equal(label, 'adminDeliverVariantOrder');
      assert.deepEqual(options, { sendTimeoutMs: 200, confirmTimeoutMs: 300 });
      events.push('send');
      return 'receipt-signature';
    },
    programs: {
      bubblegumProgramId: key(7),
      mplNoopProgramId: key(8),
      mplAccountCompressionProgramId: key(9),
      mplCoreProgramId: key(10),
      mplCoreCpiSigner: key(11),
    },
    rpcTimeoutMs: 100,
    txSendTimeoutMs: 200,
    txConfirmTimeoutMs: 300,
    signal: cancellation.signal,
  };
  const account = (overrides: Partial<DecodedAdminDeliveryOrderRecord> = {}): AccountInfo<Buffer> => {
    const record: DecodedAdminDeliveryOrderRecord = {
      orderHash, bump, variantIndex: 1, quantity: 3, firstMetadataId: 41,
      receiptOwner: signer.publicKey, createdSlot: 123n, ...overrides,
    };
    const metadata = Buffer.alloc(4);
    metadata.writeUInt32LE(record.firstMetadataId);
    const slot = Buffer.alloc(8);
    slot.writeBigUInt64LE(record.createdSlot);
    return {
      owner: dropRuntime.boxMinterProgramId,
      lamports: 1,
      executable: false,
      rentEpoch: 0,
      data: Buffer.concat([
        ACCOUNT_ADMIN_DELIVERY_ORDER, record.orderHash, Buffer.from([record.variantIndex, record.quantity]),
        metadata, record.receiptOwner.toBuffer(), slot, Buffer.from([record.bump]),
      ]),
    };
  };
  const run = () => ensureAdminDeliveryOrder({
    dropId: 'test-drop', dropRuntime, orderHash, variantIndex: 1, quantity: 3, deps,
  });
  return { account, bump, cancellation, config, deps, events, reads, run, signer };
}

test('Stripe admin order replay validates its record without another transaction', async () => {
  const f = fixture();
  f.reads.push(f.account());
  assert.deepEqual(await f.run(), {
    metadataId: 41, metadataIds: [41, 42, 43], receiptOwner: f.signer.publicKey, receiptTx: null,
  });
  assert.deepEqual(f.events, ['config', 'collection', 'getAccountInfo:adminOrder']);
});

test('Stripe admin order creation verifies the resulting record after one send', async () => {
  const f = fixture();
  f.reads.push(null, f.account());
  assert.equal((await f.run()).receiptTx, 'receipt-signature');
  assert.deepEqual(f.events, [
    'config', 'collection', 'getAccountInfo:adminOrder', 'getLatestBlockhash:stripeCheckoutFulfillment',
    'build', 'send', 'getAccountInfo:adminOrderAfterSend',
  ]);
});

test('Stripe admin order adopts a verified record after an ambiguous send', async () => {
  const f = fixture();
  f.reads.push(null, f.account());
  f.deps.sendAndConfirmSignedTx = async () => { f.events.push('send'); throw new Error('send unavailable'); };
  const result = await f.run();
  assert.equal(result.metadataId, 41);
  assert.equal(result.receiptTx, null);
  assert.equal(f.events.filter(event => event === 'send').length, 1);
  assert.equal(f.events.at(-1), 'getAccountInfo:adminOrderAfterError');
});

for (const recovery of ['missing', 'unavailable', 'cancelled'] as const) {
  test(`Stripe admin order retains the send failure when recovery is ${recovery}`, async () => {
    const f = fixture();
    const failure = new Error('original send failure');
    f.reads.push(null, recovery === 'unavailable' ? new Error('read unavailable') : null);
    f.deps.sendAndConfirmSignedTx = async () => {
      if (recovery === 'cancelled') f.cancellation.abort(new Error('cancelled'));
      throw failure;
    };
    await assert.rejects(f.run(), error => error === failure);
    assert.equal(f.events.includes('getAccountInfo:adminOrderAfterError'), recovery !== 'cancelled');
  });
}

const mismatches: Array<[Partial<DecodedAdminDeliveryOrderRecord>, RegExp]> = [
  [{ orderHash: Buffer.alloc(32) }, /hash mismatch/],
  [{ variantIndex: 2 }, /variant mismatch/],
  [{ quantity: 2 }, /quantity mismatch/],
  [{ receiptOwner: PublicKey.default }, /receipt owner mismatch/],
  [{ firstMetadataId: 0 }, /metadata id is invalid/],
];
for (const [overrides, message] of mismatches) {
  test(`Stripe admin order rejects replay with ${message.source}`, async () => {
    const f = fixture();
    f.reads.push(f.account(overrides));
    await assert.rejects(f.run(), message);
    assert.equal(f.events.includes('build'), false);
  });
}

test('Stripe admin order rejects a replay with a different PDA bump', async () => {
  const f = fixture();
  f.reads.push(f.account({ bump: (f.bump + 1) % 256 }));
  await assert.rejects(f.run(), /bump mismatch/);
});

test('Stripe admin order cannot succeed without a verified post-send record', async () => {
  const f = fixture();
  f.reads.push(null, null);
  await assert.rejects(f.run(), /record was not created/);
});

test('Stripe admin order gates account reads on signer and collection validation', async () => {
  const wrongSigner = fixture();
  wrongSigner.config.admin = PublicKey.default;
  await assert.rejects(wrongSigner.run(), /does not match on-chain admin/);
  assert.deepEqual(wrongSigner.events, ['config']);

  const wrongCollection = fixture();
  wrongCollection.deps.requireStripeCheckoutCollectionMatchesConfig = () => { throw new Error('collection mismatch'); };
  await assert.rejects(wrongCollection.run(), /collection mismatch/);
  assert.deepEqual(wrongCollection.events, ['config']);
});

test('Stripe admin order treats an empty system account as absent but rejects another owner', async () => {
  const empty = fixture();
  empty.reads.push({ ...empty.account(), owner: SystemProgram.programId, data: Buffer.alloc(0) }, empty.account());
  assert.equal((await empty.run()).receiptTx, 'receipt-signature');

  const wrongOwner = fixture();
  wrongOwner.reads.push({ ...wrongOwner.account(), owner: PublicKey.default });
  await assert.rejects(wrongOwner.run(), /unexpected owner/);
  assert.equal(wrongOwner.events.includes('build'), false);
});
