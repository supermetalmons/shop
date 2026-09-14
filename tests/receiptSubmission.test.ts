import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { Keypair, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { sendReceiptSubmission } from '../src/shop/commerce/receiptSubmission.ts';
import { useWalletTransactions } from '../src/shop/commerce/useWalletTransactions.ts';
import { PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS } from '../src/shop/commerce/transactionSupport.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

setupFrontendDom();
const { cleanup, renderHook } = await import('@testing-library/react');
afterEach(cleanup);

const signature = bs58.encode(new Uint8Array(64).fill(7));

function preparedTransaction() {
  const payer = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [],
  }).compileToV0Message());
  return { payer, blockhash, encodedTx: Buffer.from(transaction.serialize()).toString('base64') };
}

function confirmedStatus() {
  return {
    context: { slot: 1 },
    value: { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' as const },
  };
}

for (const mode of ['direct', 'admin receipt'] as const) {
  test(`${mode} submission preserves simulation, wallet checks, and callback order`, async () => {
    const { payer, blockhash, encodedTx } = preparedTransaction();
    const events: string[] = [];
    let submittedSignature = '';
    const wallet = {
      signTransaction: async (transaction: VersionedTransaction) => {
        events.push('sign');
        transaction.sign([payer]);
        return transaction;
      },
    } as unknown as WalletContextState;
    const { result } = renderHook(() => useWalletTransactions(wallet, () => undefined));
    const connection = {
      simulateTransaction: async () => {
        events.push('simulate');
        return { context: { slot: 1 }, value: { err: null, logs: [] } };
      },
      sendRawTransaction: async (raw: Uint8Array) => {
        events.push('broadcast');
        submittedSignature = bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
        return submittedSignature;
      },
      getSignatureStatus: async () => {
        events.push('confirm');
        return confirmedStatus();
      },
    } as unknown as Connection;
    const sent = await sendReceiptSubmission({
      encodedTx,
      connection,
      signAndSendPreparedViaConnection: (transaction, targetConnection, options) => {
        assert.equal(targetConnection, connection);
        assert.equal(options?.signedSendTimeoutMs, PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS);
        return result.current.signAndSendPreparedViaConnection(transaction, targetConnection, options);
      },
      receiptWallet: {
        assertCurrent: () => { events.push('guard'); },
        onBroadcastAttempt: (attemptSignature, transaction) => {
          assert.equal(transaction.message.recentBlockhash, blockhash);
          assert.equal(attemptSignature, bs58.encode(transaction.signatures[0]));
          events.push('record-in-flight');
          if (mode === 'admin receipt') events.push('persist-attempt');
        },
      },
      ...(mode === 'direct' ? { simulateBeforeSigning: true } : {}),
      onSubmitted: (sentSignature, transaction) => {
        assert.equal(sentSignature, submittedSignature);
        assert.equal(transaction.message.recentBlockhash, blockhash);
        if (mode === 'admin receipt') events.push('persist-finalize');
        events.push('record-hidden');
        if (mode === 'direct') events.push('toast');
      },
    });
    assert.equal(sent, submittedSignature);
    assert.deepEqual(events, [
      'guard',
      ...(mode === 'direct' ? ['simulate'] : []),
      'guard', 'sign', 'guard', 'record-in-flight',
      ...(mode === 'admin receipt' ? ['persist-attempt'] : []),
      'broadcast',
      ...(mode === 'admin receipt' ? ['persist-finalize'] : []),
      'record-hidden',
      ...(mode === 'direct' ? ['toast'] : []),
      'confirm',
    ]);
  });
}

test('a wallet change during signing prevents receipt broadcast and submission callbacks', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { payer, encodedTx } = preparedTransaction();
  let resolveSigning!: (transaction: VersionedTransaction) => void;
  let markSigningStarted!: (transaction: VersionedTransaction) => void;
  const signing = new Promise<VersionedTransaction>((resolve) => { resolveSigning = resolve; });
  const signingStarted = new Promise<VersionedTransaction>((resolve) => { markSigningStarted = resolve; });
  let current = true;
  let broadcasts = 0;
  let callbacks = 0;
  const wallet = {
    signTransaction: (transaction: VersionedTransaction) => {
      transaction.sign([payer]);
      markSigningStarted(transaction);
      return signing;
    },
  } as unknown as WalletContextState;
  const { result } = renderHook(() => useWalletTransactions(wallet, () => undefined));
  const connection = {
    sendRawTransaction: async () => { broadcasts += 1; return signature; },
  } as unknown as Connection;
  const submission = sendReceiptSubmission({
    encodedTx,
    connection,
    signAndSendPreparedViaConnection: result.current.signAndSendPreparedViaConnection,
    receiptWallet: {
      assertCurrent: () => { if (!current) throw new Error('wallet changed'); },
      onBroadcastAttempt: () => { callbacks += 1; },
    },
    onSubmitted: () => { callbacks += 1; },
  });
  const transaction = await signingStarted;
  current = false;
  resolveSigning(transaction);
  await assert.rejects(submission, /wallet changed/);
  assert.equal(broadcasts, 0);
  assert.equal(callbacks, 0);
});

test('a stale receipt wallet stops submission before preparation or signing', () => {
  const staleWallet = new Error('wallet changed');
  assert.throws(() => sendReceiptSubmission({
    encodedTx: 'not a transaction',
    connection: {} as Connection,
    signAndSendPreparedViaConnection: async () => assert.fail('Cannot sign for a stale wallet'),
    receiptWallet: {
      assertCurrent: () => { throw staleWallet; },
      onBroadcastAttempt: () => assert.fail('Cannot broadcast for a stale wallet'),
    },
    onSubmitted: () => assert.fail('Cannot submit for a stale wallet'),
  }), (error) => error === staleWallet);
});

test('admin pack submission keeps simulation disabled and supplies no receipt sender options', async () => {
  const { encodedTx } = preparedTransaction();
  let submitted = 0;
  const connection = {
    simulateTransaction: async () => assert.fail('Admin packs do not opt into simulation'),
    getSignatureStatus: async () => confirmedStatus(),
  } as unknown as Connection;
  const sent = await sendReceiptSubmission({
    encodedTx,
    connection,
    signAndSendPreparedViaConnection: async (_transaction, targetConnection, options) => {
      assert.equal(targetConnection, connection);
      assert.equal(options, undefined);
      return signature;
    },
    onSubmitted: () => { submitted += 1; },
  });
  assert.equal(sent, signature);
  assert.equal(submitted, 1);
});

test('receipt submission preserves errors from the existing transaction sender without retrying', async () => {
  for (const error of [
    new Error('wallet rejected'),
    { name: 'PotentiallySubmittedTransactionError', signature },
    { name: 'SubmittedTransactionFailureError', signature },
  ]) {
    let attempts = 0;
    await assert.rejects(sendReceiptSubmission({
      encodedTx: 'prepared transaction',
      connection: {} as Connection,
      signAndSendPreparedViaConnection: async () => signature,
      onSubmitted: () => undefined,
    }, {
      sendPreparedTransaction: async () => { attempts += 1; throw error; },
    }), (received) => received === error);
    assert.equal(attempts, 1);
  }
});
