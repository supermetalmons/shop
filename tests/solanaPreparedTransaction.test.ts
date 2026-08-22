import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Keypair,
  SendTransactionError,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type SimulateTransactionConfig,
} from '@solana/web3.js';
import { WalletSendTransactionError } from '@solana/wallet-adapter-base';
import bs58 from 'bs58';

import {
  classifySignedTransactionSendError,
  isBlockhashExpiredError,
  isPotentiallySubmittedTransactionError,
  isSubmittedTransactionFailureError,
  reconcileSubmittedTransaction,
  sendPreparedTransaction,
  sendSignedTransactionViaConnection,
} from '../src/lib/solana';

const SIGNATURE = bs58.encode(new Uint8Array(64).fill(7));

function buildEncodedPreparedTransaction(payerKey = Keypair.generate().publicKey): string {
  const message = new TransactionMessage({
    payerKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

test('sendPreparedTransaction simulates before invoking the signer when requested', async () => {
  const events: string[] = [];
  const connection = {
    async simulateTransaction(tx: VersionedTransaction, config?: SimulateTransactionConfig) {
      events.push('simulate');
      assert.ok(tx instanceof VersionedTransaction);
      assert.deepEqual(config, {
        sigVerify: false,
        commitment: 'confirmed',
      });
      return {
        context: { slot: 1 },
        value: { err: null, logs: ['Program log: simulation succeeded'] },
      };
    },
    async getSignatureStatus() {
      events.push('status');
      return {
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: 'confirmed' as const,
        },
      };
    },
  } as unknown as Connection;

  const signature = await sendPreparedTransaction(
    buildEncodedPreparedTransaction(),
    connection,
    async (tx) => {
      events.push('sign');
      assert.ok(tx instanceof VersionedTransaction);
      return SIGNATURE;
    },
    { simulateBeforeSigning: true },
  );

  assert.equal(signature, SIGNATURE);
  assert.deepEqual(events, ['simulate', 'sign', 'status']);
});

test('sendPreparedTransaction keeps simulation disabled by default', async () => {
  let simulationCalls = 0;
  const connection = {
    async simulateTransaction() {
      simulationCalls += 1;
      throw new Error('simulation should remain opt-in');
    },
    async getSignatureStatus() {
      return {
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: 'confirmed' as const,
        },
      };
    },
  } as unknown as Connection;

  const signature = await sendPreparedTransaction(buildEncodedPreparedTransaction(), connection, async () => SIGNATURE);

  assert.equal(signature, SIGNATURE);
  assert.equal(simulationCalls, 0);
});

test('sendPreparedTransaction rejects invalid signer-returned signatures before submission handling', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  let submittedNotifications = 0;
  let statusCalls = 0;
  const connection = {
    async getSignatureStatus() {
      statusCalls += 1;
      return {
        context: { slot: 1 },
        value: null,
      };
    },
  } as unknown as Connection;
  const invalidSignatures = [
    '1'.repeat(64),
    bs58.encode(new Uint8Array(63).fill(7)),
    bs58.encode(new Uint8Array(65).fill(7)),
  ];

  for (const invalidSignature of invalidSignatures) {
    await assert.rejects(
      sendPreparedTransaction(
        buildEncodedPreparedTransaction(),
        connection,
        async () => invalidSignature,
        {
          onSubmitted: () => {
            submittedNotifications += 1;
          },
        },
      ),
      /Wallet returned an invalid transaction signature/,
    );
  }

  assert.equal(submittedNotifications, 0);
  assert.equal(statusCalls, 0);
});

test('sendPreparedTransaction does not invoke the signer when simulation fails', async (t) => {
  let signerCalls = 0;
  const reportedErrors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    reportedErrors.push(args);
  });
  const connection = {
    async simulateTransaction(_tx: VersionedTransaction, config?: SimulateTransactionConfig) {
      assert.deepEqual(config, {
        sigVerify: false,
        commitment: 'confirmed',
      });
      return {
        context: { slot: 1 },
        value: {
          err: { InstructionError: [0, { Custom: 6_001 }] },
          logs: ['Program log: transfer rejected'],
        },
      };
    },
  } as unknown as Connection;

  await assert.rejects(
    sendPreparedTransaction(
      buildEncodedPreparedTransaction(),
      connection,
      async () => {
        signerCalls += 1;
        return SIGNATURE;
      },
      { simulateBeforeSigning: true },
    ),
    /Transaction simulation failed: \{"InstructionError":\[0,\{"Custom":6001\}\]\}/,
  );
  assert.equal(signerCalls, 0);
  assert.equal(
    reportedErrors.some(
      ([label, details]) =>
        label === '[mons/solana] transaction failed' &&
        Array.isArray((details as { logs?: unknown })?.logs) &&
        (details as { logs: string[] }).logs.includes('Program log: transfer rejected'),
    ),
    true,
  );
});

test('sendPreparedTransaction times out a hanging pre-sign simulation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => undefined);
  let simulationCalls = 0;
  let signerCalls = 0;
  let submittedNotifications = 0;
  const connection = {
    simulateTransaction() {
      simulationCalls += 1;
      return new Promise<never>(() => undefined);
    },
  } as unknown as Connection;

  const pendingResult = sendPreparedTransaction(
    buildEncodedPreparedTransaction(),
    connection,
    async () => {
      signerCalls += 1;
      return SIGNATURE;
    },
    {
      simulateBeforeSigning: true,
      simulationTimeoutMs: 25,
      onSubmitted: () => {
        submittedNotifications += 1;
      },
    },
  );
  const rejection = assert.rejects(pendingResult, /Solana RPC request timed out/);

  assert.equal(simulationCalls, 1);
  t.mock.timers.tick(25);
  await rejection;

  assert.equal(signerCalls, 0);
  assert.equal(submittedNotifications, 0);
});

test('sendSignedTransactionViaConnection serializes and submits an already-signed transaction', async () => {
  const payer = Keypair.generate();
  const tx = VersionedTransaction.deserialize(
    Buffer.from(buildEncodedPreparedTransaction(payer.publicKey), 'base64'),
  );
  tx.sign([payer]);
  const expectedRaw = tx.serialize();
  const sendOptions = {
    skipPreflight: false,
    preflightCommitment: 'confirmed' as const,
    maxRetries: 3,
  };
  let sendCalls = 0;
  const events: string[] = [];
  let attemptedSignature = '';
  const connection = {
    async sendRawTransaction(raw: Uint8Array, options?: typeof sendOptions) {
      events.push('send');
      sendCalls += 1;
      assert.deepEqual(raw, expectedRaw);
      assert.equal(options, sendOptions);
      return SIGNATURE;
    },
  } as unknown as Connection;

  const localSignature = bs58.encode(tx.signatures[0]);
  assert.equal(
    await sendSignedTransactionViaConnection(tx, connection, {
      sendOptions,
      onBroadcastAttempt: (signature) => {
        events.push('attempt');
        attemptedSignature = signature;
      },
    }),
    localSignature,
  );
  assert.equal(attemptedSignature, localSignature);
  assert.deepEqual(events, ['attempt', 'send']);
  assert.equal(sendCalls, 1);
});

test('sendSignedTransactionViaConnection does not broadcast when attempt recording fails', async () => {
  const payer = Keypair.generate();
  const tx = VersionedTransaction.deserialize(
    Buffer.from(buildEncodedPreparedTransaction(payer.publicKey), 'base64'),
  );
  tx.sign([payer]);
  const recordingError = new Error('unable to record signed receipt operation');
  let sendCalls = 0;
  const connection = {
    async sendRawTransaction() {
      sendCalls += 1;
      return SIGNATURE;
    },
  } as unknown as Connection;

  await assert.rejects(
    sendSignedTransactionViaConnection(tx, connection, {
      onBroadcastAttempt: () => {
        throw recordingError;
      },
    }),
    (error: unknown) => error === recordingError,
  );
  assert.equal(sendCalls, 0);
});

test('sendSignedTransactionViaConnection classifies its default send timeout as potentially submitted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const payer = Keypair.generate();
  const tx = VersionedTransaction.deserialize(
    Buffer.from(buildEncodedPreparedTransaction(payer.publicKey), 'base64'),
  );
  tx.sign([payer]);
  const expectedSignature = bs58.encode(tx.signatures[0]);
  let sendCalls = 0;
  const connection = {
    sendRawTransaction() {
      sendCalls += 1;
      return new Promise<never>(() => undefined);
    },
  } as unknown as Connection;

  const pendingResult = sendSignedTransactionViaConnection(tx, connection);
  let settled = false;
  void pendingResult.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  t.mock.timers.tick(9_999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);

  await assert.rejects(pendingResult, (error: unknown) => {
    assert.equal(isPotentiallySubmittedTransactionError(error), true);
    if (!isPotentiallySubmittedTransactionError(error)) return false;
    assert.equal(error.signature, expectedSignature);
    assert.match((error.cause as Error).message, /Solana RPC request timed out/);
    return true;
  });
  assert.equal(sendCalls, 1);
});

test('sendSignedTransactionViaConnection preserves deterministic RPC rejection errors', async () => {
  const payer = Keypair.generate();
  const tx = VersionedTransaction.deserialize(
    Buffer.from(buildEncodedPreparedTransaction(payer.publicKey), 'base64'),
  );
  tx.sign([payer]);
  const deterministicError = new SendTransactionError({
    action: 'send',
    signature: '',
    transactionMessage: 'Transaction simulation failed: Error processing Instruction 0',
    logs: ['Program log: deterministic rejection'],
  });
  const connection = {
    async sendRawTransaction() {
      throw deterministicError;
    },
  } as unknown as Connection;

  await assert.rejects(
    sendSignedTransactionViaConnection(tx, connection, { timeoutMs: 25 }),
    (error: unknown) => error === deterministicError,
  );
});

test(
  'sendPreparedTransaction preserves canonical BlockhashNotFound simulation errors for retry classification',
  async (t) => {
    let signerCalls = 0;
    t.mock.method(console, 'error', () => undefined);
    const connection = {
      async simulateTransaction() {
        return {
          context: { slot: 1 },
          value: {
            err: 'BlockhashNotFound',
            logs: null,
          },
        };
      },
    } as unknown as Connection;

    await assert.rejects(
      sendPreparedTransaction(
        buildEncodedPreparedTransaction(),
        connection,
        async () => {
          signerCalls += 1;
          return SIGNATURE;
        },
        { simulateBeforeSigning: true },
      ),
      (error: unknown) => {
        assert.equal(isBlockhashExpiredError(error), true);
        assert.match((error as Error).message, /BlockhashNotFound/);
        return true;
      },
    );
    assert.equal(signerCalls, 0);
  },
);

test('sendPreparedTransaction resolves an ambiguous signed send when its signature confirms', async () => {
  const payer = Keypair.generate();
  const transportError = Object.assign(new Error('RPC connection closed after the request body was written'), {
    logs: [],
  });
  let submittedNotifications = 0;
  let statusCalls = 0;
  let expectedSignature = '';
  const connection = {
    async getSignatureStatus() {
      statusCalls += 1;
      return {
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: 'confirmed' as const,
        },
      };
    },
  } as unknown as Connection;

  const signature = await sendPreparedTransaction(
    buildEncodedPreparedTransaction(payer.publicKey),
    connection,
    async (tx) => {
      tx.sign([payer]);
      expectedSignature = bs58.encode(tx.signatures[0]);
      throw classifySignedTransactionSendError(tx, transportError);
    },
    {
      onSubmitted: () => {
        submittedNotifications += 1;
      },
    },
  );

  assert.equal(signature, expectedSignature);
  assert.equal(submittedNotifications, 1);
  assert.equal(statusCalls, 1);
});

test('sendPreparedTransaction propagates a definitive failure for an ambiguous signed send', async () => {
  const payer = Keypair.generate();
  const transportError = new Error('RPC response was lost after broadcast');
  const transactionError = { InstructionError: [0, { Custom: 6_001 }] };
  let submittedNotifications = 0;
  let expectedSignature = '';
  const connection = {
    async getSignatureStatus() {
      return {
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: 1,
          err: transactionError,
          confirmationStatus: 'confirmed' as const,
        },
      };
    },
  } as unknown as Connection;

  await assert.rejects(
    sendPreparedTransaction(
      buildEncodedPreparedTransaction(payer.publicKey),
      connection,
      async (tx) => {
        tx.sign([payer]);
        expectedSignature = bs58.encode(tx.signatures[0]);
        throw classifySignedTransactionSendError(tx, transportError);
      },
      {
        onSubmitted: () => {
          submittedNotifications += 1;
        },
      },
    ),
    (error: unknown) => {
      assert.equal(isSubmittedTransactionFailureError(error), true);
      if (!isSubmittedTransactionFailureError(error)) return false;
      assert.equal(error.signature, expectedSignature);
      assert.deepEqual(error.transactionError, transactionError);
      return true;
    },
  );
  assert.equal(submittedNotifications, 1);
});

test('sendPreparedTransaction keeps processed errors nonterminal', async () => {
  const payer = Keypair.generate();
  const transportError = new Error('RPC response was lost after broadcast');
  let expectedSignature = '';
  let statusCalls = 0;
  const connection = {
    async getSignatureStatus() {
      statusCalls += 1;
      return {
        context: { slot: 1 },
        value: statusCalls === 1
          ? {
              slot: 1,
              confirmations: 0,
              err: { InstructionError: [0, { Custom: 6_001 }] },
              confirmationStatus: 'processed' as const,
            }
          : {
              slot: 2,
              confirmations: 1,
              err: null,
              confirmationStatus: 'confirmed' as const,
            },
      };
    },
  } as unknown as Connection;

  const result = await sendPreparedTransaction(
    buildEncodedPreparedTransaction(payer.publicKey),
    connection,
    async (tx) => {
      tx.sign([payer]);
      expectedSignature = bs58.encode(tx.signatures[0]);
      throw classifySignedTransactionSendError(tx, transportError);
    },
  );
  assert.equal(result, expectedSignature);
  assert.equal(statusCalls, 2);
});

test('sendPreparedTransaction preserves a normally returned signature when a processed error remains unresolved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const payer = Keypair.generate();
  const transactionError = { InstructionError: [0, { Custom: 6_001 }] };
  let expectedSignature = '';
  let submittedNotifications = 0;
  let statusCalls = 0;
  let historyCalls = 0;
  const connection = {
    async getSignatureStatus(_signature: string, config?: { searchTransactionHistory?: boolean }) {
      statusCalls += 1;
      if (config?.searchTransactionHistory) historyCalls += 1;
      return {
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: 0,
          err: transactionError,
          confirmationStatus: 'processed' as const,
        },
      };
    },
  } as unknown as Connection;

  const pendingResult = sendPreparedTransaction(
    buildEncodedPreparedTransaction(payer.publicKey),
    connection,
    async (tx) => {
      tx.sign([payer]);
      expectedSignature = bs58.encode(tx.signatures[0]);
      return expectedSignature;
    },
    {
      onSubmitted: () => {
        submittedNotifications += 1;
      },
    },
  );
  let settled = false;
  void pendingResult.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let turn = 0; turn < 100 && !settled; turn += 1) {
    await Promise.resolve();
    t.mock.timers.runAll();
  }

  await assert.rejects(pendingResult, (error: unknown) => {
    assert.equal(isPotentiallySubmittedTransactionError(error), true);
    if (!isPotentiallySubmittedTransactionError(error)) return false;
    assert.equal(error.signature, expectedSignature);
    assert.match(String(error.cause), /confirmation timed out/i);
    return true;
  });
  assert.equal(settled, true);
  assert.equal(submittedNotifications, 1);
  assert.ok(statusCalls >= 2);
  assert.equal(historyCalls, 1);
});

test('sendPreparedTransaction preserves an ambiguous signed send when status remains unresolved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const payer = Keypair.generate();
  const transportError = new Error('RPC connection stayed unavailable after broadcast');
  let submittedNotifications = 0;
  let statusCalls = 0;
  let historyCalls = 0;
  const connection = {
    async getSignatureStatus(_signature: string, config?: { searchTransactionHistory?: boolean }) {
      statusCalls += 1;
      if (config?.searchTransactionHistory) historyCalls += 1;
      return {
        context: { slot: 1 },
        value: null,
      };
    },
  } as unknown as Connection;

  const pendingResult = sendPreparedTransaction(
    buildEncodedPreparedTransaction(payer.publicKey),
    connection,
    async (tx) => {
      tx.sign([payer]);
      throw classifySignedTransactionSendError(tx, transportError);
    },
    {
      onSubmitted: () => {
        submittedNotifications += 1;
      },
    },
  );
  let settled = false;
  void pendingResult.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let turn = 0; turn < 100 && !settled; turn += 1) {
    await Promise.resolve();
    t.mock.timers.runAll();
  }

  await assert.rejects(pendingResult, (error: unknown) => {
    assert.equal(isPotentiallySubmittedTransactionError(error), true);
    if (!isPotentiallySubmittedTransactionError(error)) return false;
    assert.equal(error.cause, transportError);
    return true;
  });
  assert.equal(settled, true);
  assert.equal(submittedNotifications, 1);
  assert.ok(statusCalls >= 2);
  assert.equal(historyCalls, 1);
});

test('sendPreparedTransaction times out a hanging status request and accepts a later confirmation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let statusCalls = 0;
  const connection = {
    async getSignatureStatus() {
      statusCalls += 1;
      if (statusCalls === 1) {
        return new Promise<never>(() => undefined);
      }
      return {
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: 'confirmed' as const,
        },
      };
    },
  } as unknown as Connection;

  const pendingResult = sendPreparedTransaction(
    buildEncodedPreparedTransaction(),
    connection,
    async () => SIGNATURE,
  );
  for (let turn = 0; turn < 10 && statusCalls === 0; turn += 1) await Promise.resolve();
  assert.equal(statusCalls, 1);

  t.mock.timers.tick(2_000);
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  t.mock.timers.tick(500);
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

  assert.equal(await pendingResult, SIGNATURE);
  assert.equal(statusCalls, 2);
});

test('reconcileSubmittedTransaction returns confirmed and failed live outcomes', async () => {
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const confirmedConnection = {
    async getSignatureStatus() {
      return {
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: 'confirmed' as const,
        },
      };
    },
  } as unknown as Connection;
  const failedConnection = {
    async getSignatureStatus() {
      return {
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: 1,
          err: { InstructionError: [0, { Custom: 6_001 }] },
          confirmationStatus: 'confirmed' as const,
        },
      };
    },
  } as unknown as Connection;

  assert.equal(
    await reconcileSubmittedTransaction(confirmedConnection, { signature: SIGNATURE, recentBlockhash }),
    'confirmed',
  );
  assert.equal(
    await reconcileSubmittedTransaction(failedConnection, { signature: SIGNATURE, recentBlockhash }),
    'failed',
  );
});

test('reconcileSubmittedTransaction keeps processed errors nonterminal', async () => {
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const connection = {
    async getSignatureStatus() {
      return {
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: 1,
          err: { InstructionError: [0, { Custom: 6_001 }] },
          confirmationStatus: 'processed' as const,
        },
      };
    },
  } as unknown as Connection;

  assert.equal(
    await reconcileSubmittedTransaction(
      connection,
      { signature: SIGNATURE, recentBlockhash },
      { timeoutMs: 5, pollIntervalMs: 1 },
    ),
    'unknown',
  );
});

test('reconcileSubmittedTransaction does not confirm an explicit processed status through legacy confirmations', async () => {
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const connection = {
    async getSignatureStatus() {
      return {
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: null,
          err: null,
          confirmationStatus: 'processed' as const,
        },
      };
    },
  } as unknown as Connection;

  assert.equal(
    await reconcileSubmittedTransaction(
      connection,
      { signature: SIGNATURE, recentBlockhash },
      { timeoutMs: 5, pollIntervalMs: 1 },
    ),
    'unknown',
  );
});

test('reconcileSubmittedTransaction requires an explicit null status error to confirm', async () => {
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const connection = {
    async getSignatureStatus() {
      return {
        context: { slot: 1 },
        value: {
          slot: 1,
          confirmations: 1,
          err: false,
          confirmationStatus: 'confirmed' as const,
        },
      };
    },
  } as unknown as Connection;

  assert.equal(
    await reconcileSubmittedTransaction(
      connection,
      { signature: SIGNATURE, recentBlockhash },
      { timeoutMs: 5, pollIntervalMs: 1 },
    ),
    'unknown',
  );
});

test('reconcileSubmittedTransaction confirms expiration only after an empty history lookup', async () => {
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const calls: boolean[] = [];
  const connection = {
    async getSignatureStatus(_signature: string, config?: { searchTransactionHistory?: boolean }) {
      calls.push(Boolean(config?.searchTransactionHistory));
      return { context: { slot: 1 }, value: null };
    },
    async isBlockhashValid() {
      return { context: { slot: 1 }, value: false };
    },
  } as unknown as Connection;

  assert.equal(
    await reconcileSubmittedTransaction(connection, { signature: SIGNATURE, recentBlockhash }),
    'expired',
  );
  assert.deepEqual(calls, [false, true]);
});

test('reconcileSubmittedTransaction requires ordered RPC contexts before expiring', async () => {
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  for (const [historyContextSlot, expected] of [
    [119, 'confirmed'],
    [120, 'expired'],
    [121, 'expired'],
  ] as const) {
    let statusCalls = 0;
    const requestedMinContextSlots: number[] = [];
    const connection = {
      async getSignatureStatus(_signature: string, config?: { searchTransactionHistory?: boolean }) {
        statusCalls += 1;
        if (config?.searchTransactionHistory) {
          return { context: { slot: historyContextSlot }, value: null };
        }
        if (statusCalls > 2 && expected === 'confirmed') {
          return {
            context: { slot: 121 },
            value: {
              slot: 121,
              confirmations: 1,
              err: null,
              confirmationStatus: 'confirmed' as const,
            },
          };
        }
        return { context: { slot: 100 }, value: null };
      },
      async isBlockhashValid(_blockhash: string, config: { minContextSlot: number }) {
        requestedMinContextSlots.push(config.minContextSlot);
        return { context: { slot: 120 }, value: false };
      },
    } as unknown as Connection;

    assert.equal(
      await reconcileSubmittedTransaction(
        connection,
        { signature: SIGNATURE, recentBlockhash, blockhashContextSlot: 110 },
        { timeoutMs: 100, pollIntervalMs: 0, requestTimeoutMs: 20 },
      ),
      expected,
    );
    assert.deepEqual(requestedMinContextSlots, [110]);
  }
});

test('reconcileSubmittedTransaction ignores blockhash validity below its requested context', async () => {
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  let liveCalls = 0;
  let historyCalls = 0;
  const connection = {
    async getSignatureStatus(_signature: string, config?: { searchTransactionHistory?: boolean }) {
      if (config?.searchTransactionHistory) {
        historyCalls += 1;
        return { context: { slot: 130 }, value: null };
      }
      liveCalls += 1;
      return liveCalls === 1
        ? { context: { slot: 100 }, value: null }
        : {
            context: { slot: 131 },
            value: {
              slot: 131,
              confirmations: 1,
              err: null,
              confirmationStatus: 'confirmed' as const,
            },
          };
    },
    async isBlockhashValid(_blockhash: string, config: { minContextSlot: number }) {
      assert.equal(config.minContextSlot, 120);
      return { context: { slot: 119 }, value: false };
    },
  } as unknown as Connection;

  assert.equal(
    await reconcileSubmittedTransaction(
      connection,
      { signature: SIGNATURE, recentBlockhash, blockhashContextSlot: 120 },
      { timeoutMs: 100, pollIntervalMs: 0, requestTimeoutMs: 20 },
    ),
    'confirmed',
  );
  assert.equal(historyCalls, 0);
});

test('reconcileSubmittedTransaction can observe without inferring expiry', async () => {
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const historyCalls: boolean[] = [];
  let validityCalls = 0;
  const connection = {
    async getSignatureStatus(_signature: string, config?: { searchTransactionHistory?: boolean }) {
      historyCalls.push(Boolean(config?.searchTransactionHistory));
      return { context: { slot: 1 }, value: null };
    },
    async isBlockhashValid() {
      validityCalls += 1;
      return { context: { slot: 1 }, value: false };
    },
  } as unknown as Connection;

  assert.equal(
    await reconcileSubmittedTransaction(
      connection,
      { signature: SIGNATURE, recentBlockhash },
      { detectExpiry: false, timeoutMs: 5, pollIntervalMs: 1 },
    ),
    'unknown',
  );
  assert.ok(historyCalls.length > 0);
  assert.equal(historyCalls.every(Boolean), true);
  assert.equal(validityCalls, 0);
});

test('reconcileSubmittedTransaction observes confirmed historical outcomes without inferring expiry', async () => {
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const transactionError = { InstructionError: [0, { Custom: 6_001 }] };
  const reconcile = async (err: unknown) => {
    const historyCalls: boolean[] = [];
    let validityCalls = 0;
    const connection = {
      async getSignatureStatus(_signature: string, config?: { searchTransactionHistory?: boolean }) {
        historyCalls.push(Boolean(config?.searchTransactionHistory));
        return {
          context: { slot: 1 },
          value: {
            slot: 1,
            confirmations: 1,
            err,
            confirmationStatus: 'confirmed' as const,
          },
        };
      },
      async isBlockhashValid() {
        validityCalls += 1;
        return { context: { slot: 1 }, value: false };
      },
    } as unknown as Connection;
    const outcome = await reconcileSubmittedTransaction(
      connection,
      { signature: SIGNATURE, recentBlockhash },
      { detectExpiry: false, timeoutMs: 5, pollIntervalMs: 1 },
    );
    assert.deepEqual(historyCalls, [true]);
    assert.equal(validityCalls, 0);
    return outcome;
  };

  assert.equal(await reconcile(null), 'confirmed');
  assert.equal(await reconcile(transactionError), 'failed');
});

test('reconcileSubmittedTransaction honors confirmed and failed historical outcomes', async () => {
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const historicalStatus = (
    err: unknown,
  ): {
    slot: number;
    confirmations: number;
    err: unknown;
    confirmationStatus: 'confirmed';
  } => ({
    slot: 1,
    confirmations: 1,
    err,
    confirmationStatus: 'confirmed',
  });
  const buildConnection = (err: unknown) =>
    ({
      async getSignatureStatus(_signature: string, config?: { searchTransactionHistory?: boolean }) {
        return {
          context: { slot: 1 },
          value: config?.searchTransactionHistory ? historicalStatus(err) : null,
        };
      },
      async isBlockhashValid() {
        return { context: { slot: 1 }, value: false };
      },
    }) as unknown as Connection;

  assert.equal(
    await reconcileSubmittedTransaction(buildConnection(null), { signature: SIGNATURE, recentBlockhash }),
    'confirmed',
  );
  assert.equal(
    await reconcileSubmittedTransaction(buildConnection({ InstructionError: [0, 'InvalidArgument'] }), {
      signature: SIGNATURE,
      recentBlockhash,
    }),
    'failed',
  );
});

test('reconcileSubmittedTransaction conservatively returns unknown when status RPCs fail', async () => {
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  let validityCalls = 0;
  const connection = {
    async getSignatureStatus() {
      throw new Error('RPC unavailable');
    },
    async isBlockhashValid() {
      validityCalls += 1;
      return { context: { slot: 1 }, value: false };
    },
  } as unknown as Connection;

  assert.equal(
    await reconcileSubmittedTransaction(
      connection,
      { signature: SIGNATURE, recentBlockhash },
      { timeoutMs: 10, pollIntervalMs: 1, requestTimeoutMs: 2 },
    ),
    'unknown',
  );
  assert.equal(validityCalls, 0);
});

test('reconcileSubmittedTransaction strictly validates submission identifiers', async () => {
  const connection = {} as Connection;
  const recentBlockhash = Keypair.generate().publicKey.toBase58();

  await assert.rejects(
    reconcileSubmittedTransaction(connection, {
      signature: '1'.repeat(64),
      recentBlockhash,
    }),
    /invalid transaction signature/i,
  );
  await assert.rejects(
    reconcileSubmittedTransaction(connection, {
      signature: SIGNATURE,
      recentBlockhash: bs58.encode(new Uint8Array(31).fill(7)),
    }),
    /invalid recent blockhash/i,
  );
  await assert.rejects(
    reconcileSubmittedTransaction(connection, {
      signature: SIGNATURE,
      recentBlockhash: '1'.repeat(32),
    }),
    /invalid recent blockhash/i,
  );
  await assert.rejects(
    reconcileSubmittedTransaction(connection, {
      signature: SIGNATURE,
      recentBlockhash,
      blockhashContextSlot: -1,
    }),
    /invalid blockhash context slot/i,
  );
});

test('classifySignedTransactionSendError does not mark deterministic preflight failures as pending', () => {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const preflightError = new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage: 'Transaction simulation failed: Error processing Instruction 0',
    logs: ['Program log: deterministic rejection'],
  });

  assert.equal(classifySignedTransactionSendError(tx, preflightError), preflightError);
  assert.equal(isPotentiallySubmittedTransactionError(classifySignedTransactionSendError(tx, preflightError)), false);
});

test('classifySignedTransactionSendError treats an internal JSON-RPC failure as ambiguous', () => {
  const payer = Keypair.generate();
  const tx = VersionedTransaction.deserialize(
    Buffer.from(buildEncodedPreparedTransaction(payer.publicKey), 'base64'),
  );
  tx.sign([payer]);
  const rpcError = Object.assign(new Error('Internal error'), {
    name: 'SolanaJSONRPCError',
    code: -32603,
  });

  const classified = classifySignedTransactionSendError(tx, rpcError);
  assert.equal(isPotentiallySubmittedTransactionError(classified), true);
  if (!isPotentiallySubmittedTransactionError(classified)) return;
  assert.equal(classified.signature, bs58.encode(tx.signatures[0]));
  assert.equal(classified.cause, rpcError);
});

test('classifySignedTransactionSendError preserves shop RPC pre-provider failures as ordinary errors', () => {
  const payer = Keypair.generate();
  const tx = VersionedTransaction.deserialize(
    Buffer.from(buildEncodedPreparedTransaction(payer.publicKey), 'base64'),
  );
  tx.sign([payer]);
  const rateLimitError = new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage: 'Rate limit exceeded',
  });
  const originCause = new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage: 'Origin not allowed',
  });
  const originError = new WalletSendTransactionError(originCause.message, originCause);
  const rateLimitUnavailableCause = new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage: 'Rate limit unavailable',
  });
  const rateLimitUnavailableError = new WalletSendTransactionError(
    rateLimitUnavailableCause.message,
    rateLimitUnavailableCause,
  );
  const rawRateLimitCodeError = Object.assign(new Error('RPC request failed'), { code: -32005 });
  const nestedOriginCodeError = new WalletSendTransactionError(
    'Wallet adapter send failed',
    Object.assign(new Error('RPC request failed'), { code: -32096 }),
  );
  const nestedRateLimitUnavailableCodeError = Object.assign(new Error('Wallet adapter send failed'), {
    cause: Object.assign(new Error('RPC request failed'), {
      error: Object.assign(new Error('RPC request failed'), { code: -32097 }),
    }),
  });

  for (const rpcError of [
    rateLimitError,
    originError,
    rateLimitUnavailableError,
    rawRateLimitCodeError,
    nestedOriginCodeError,
    nestedRateLimitUnavailableCodeError,
  ]) {
    const classified = classifySignedTransactionSendError(tx, rpcError);
    assert.equal(classified, rpcError);
    assert.equal(isPotentiallySubmittedTransactionError(classified), false);
  }
});

test('classifySignedTransactionSendError keeps provider timeout and unavailable failures ambiguous', () => {
  const payer = Keypair.generate();
  const tx = VersionedTransaction.deserialize(
    Buffer.from(buildEncodedPreparedTransaction(payer.publicKey), 'base64'),
  );
  tx.sign([payer]);
  const providerTimeoutCause = Object.assign(new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage: 'Provider timeout',
  }), { code: -32098 });
  const providerTimeoutError = new WalletSendTransactionError(
    providerTimeoutCause.message,
    providerTimeoutCause,
  );
  const providerUnavailableCause = Object.assign(new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage: 'Provider unavailable',
  }), { code: -32099 });
  const providerUnavailableError = new WalletSendTransactionError(
    providerUnavailableCause.message,
    providerUnavailableCause,
  );

  for (const rpcError of [providerTimeoutError, providerUnavailableError]) {
    const classified = classifySignedTransactionSendError(tx, rpcError);
    assert.equal(isPotentiallySubmittedTransactionError(classified), true);
    if (!isPotentiallySubmittedTransactionError(classified)) continue;
    assert.equal(classified.signature, bs58.encode(tx.signatures[0]));
    assert.equal(classified.cause, rpcError);
  }
});

test('classifySignedTransactionSendError preserves a signature returned inside a wallet adapter error', () => {
  const tx = VersionedTransaction.deserialize(Buffer.from(buildEncodedPreparedTransaction(), 'base64'));
  const transportError = Object.assign(new Error('Wallet transport closed after broadcast'), {
    signature: SIGNATURE,
  });

  const classified = classifySignedTransactionSendError(tx, transportError);
  assert.equal(isPotentiallySubmittedTransactionError(classified), true);
  if (!isPotentiallySubmittedTransactionError(classified)) return;
  assert.equal(classified.signature, SIGNATURE);
  assert.equal(classified.cause, transportError);
});

test('classifySignedTransactionSendError rejects zero and wrong-length signature candidates', () => {
  const tx = VersionedTransaction.deserialize(Buffer.from(buildEncodedPreparedTransaction(), 'base64'));
  const invalidSignatures: unknown[] = [
    '1'.repeat(64),
    bs58.encode(new Uint8Array(63).fill(7)),
    bs58.encode(new Uint8Array(65).fill(7)),
    new Uint8Array(64),
    new Uint8Array(63).fill(7),
    new Uint8Array(65).fill(7),
  ];

  invalidSignatures.forEach((signature) => {
    const transportError = Object.assign(new Error('Wallet transport failed'), { signature });
    assert.equal(classifySignedTransactionSendError(tx, transportError), transportError);
    assert.equal(isPotentiallySubmittedTransactionError(classifySignedTransactionSendError(tx, transportError)), false);
  });
});

test('isPotentiallySubmittedTransactionError validates structural signatures', () => {
  assert.equal(
    isPotentiallySubmittedTransactionError({
      name: 'PotentiallySubmittedTransactionError',
      signature: SIGNATURE,
    }),
    true,
  );
  assert.equal(
    isPotentiallySubmittedTransactionError({
      name: 'PotentiallySubmittedTransactionError',
      signature: '1'.repeat(64),
    }),
    false,
  );
});

test('isSubmittedTransactionFailureError validates structural signatures', () => {
  assert.equal(
    isSubmittedTransactionFailureError({
      name: 'SubmittedTransactionFailureError',
      signature: SIGNATURE,
    }),
    true,
  );
  assert.equal(
    isSubmittedTransactionFailureError({
      name: 'SubmittedTransactionFailureError',
      signature: '1'.repeat(64),
    }),
    false,
  );
  assert.equal(
    isSubmittedTransactionFailureError({
      name: 'SubmittedTransactionFailureError',
      signature: bs58.encode(new Uint8Array(63).fill(7)),
    }),
    false,
  );
});

test('classifySignedTransactionSendError immediately preserves an already-processed signature', () => {
  const payer = Keypair.generate();
  const tx = VersionedTransaction.deserialize(
    Buffer.from(buildEncodedPreparedTransaction(payer.publicKey), 'base64'),
  );
  tx.sign([payer]);
  const alreadyProcessedError = new Error('This transaction has already been processed');

  const classified = classifySignedTransactionSendError(tx, alreadyProcessedError);
  assert.equal(isPotentiallySubmittedTransactionError(classified), true);
  if (!isPotentiallySubmittedTransactionError(classified)) return;
  assert.equal(classified.signature, bs58.encode(tx.signatures[0]));
  assert.equal(classified.cause, alreadyProcessedError);
});
