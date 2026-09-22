import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  AddressLookupTableAccount,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  SOLANA_MAX_RAW_TX_BYTES,
  buildSizedTransaction,
  isTransactionEncodingTooLarge,
} from '../src/solanaTransaction.ts';

const SIGNER = Keypair.generate();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const LOOKUPS = [new AddressLookupTableAccount({
  key: Keypair.generate().publicKey,
  state: {
    deactivationSlot: 0xffffffffffffffffn,
    lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0,
    addresses: [],
  },
})];

function transaction(): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({
    payerKey: SIGNER.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [],
  }).compileToV0Message());
}

function serializedTransaction(context: TestContext, result: Uint8Array | Error): VersionedTransaction {
  const built = transaction();
  context.mock.method(built, 'serialize', () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return built;
}

function overflow(): RangeError {
  return new RangeError('encoding overruns Uint8Array');
}

function sizeErrors() {
  const encodingError = new Error('Unable to encode transaction.');
  const packetError = new Error('Transaction exceeds packet limit.');
  const packetSizes: number[] = [];
  return {
    encodingError,
    packetError,
    packetSizes,
    factories: {
      encodingError: () => encodingError,
      packetSizeError: (rawBytes: number) => {
        packetSizes.push(rawBytes);
        return packetError;
      },
    },
  };
}

test('transaction encoding overflow recognizes only supported RangeError failures', () => {
  assert.equal(SOLANA_MAX_RAW_TX_BYTES, 1_232);
  for (const error of [
    overflow(),
    new RangeError('Offset is out of range'),
    Object.assign(new RangeError('Buffer write failed'), { code: 'ERR_OUT_OF_RANGE' }),
  ]) {
    assert.equal(isTransactionEncodingTooLarge(error), true);
  }
  for (const error of [
    new RangeError('Unrelated range failure'),
    new Error('encoding overruns Uint8Array'),
    Object.assign(new Error('Buffer write failed'), { code: 'ERR_OUT_OF_RANGE' }),
    'encoding overruns Uint8Array',
    null,
  ]) {
    assert.equal(isTransactionEncodingTooLarge(error), false);
  }
});

for (const length of [SOLANA_MAX_RAW_TX_BYTES - 1, SOLANA_MAX_RAW_TX_BYTES]) {
  test(`transactions of ${length} bytes return without loading lookup tables`, async (context) => {
    const raw = new Uint8Array(length);
    const built = serializedTransaction(context, raw);
    const build = context.mock.fn((_tables: AddressLookupTableAccount[]) => built);
    const loadLookupTables = context.mock.fn(async () => LOOKUPS);
    const result = await buildSizedTransaction({
      build,
      loadLookupTables,
      signal: new AbortController().signal,
      ...sizeErrors().factories,
    });
    assert.equal(result.transaction, built);
    assert.equal(result.raw, raw);
    assert.equal(build.mock.callCount(), 1);
    assert.deepEqual(build.mock.calls[0].arguments, [[]]);
    assert.equal(loadLookupTables.mock.callCount(), 0);
  });
}

for (const trigger of ['encoding overflow', 'packet overflow'] as const) {
  const initialResult = () => trigger === 'encoding overflow'
    ? overflow()
    : new Uint8Array(SOLANA_MAX_RAW_TX_BYTES + 1);

  test(`${trigger} loads lookup tables once and returns the rebuilt transaction`, async (context) => {
    const initial = serializedTransaction(context, initialResult());
    const raw = new Uint8Array(SOLANA_MAX_RAW_TX_BYTES);
    const rebuilt = serializedTransaction(context, raw);
    const build = context.mock.fn((tables: AddressLookupTableAccount[]) => tables.length ? rebuilt : initial);
    const loadLookupTables = context.mock.fn(async () => LOOKUPS);
    const result = await buildSizedTransaction({
      build,
      loadLookupTables,
      signal: new AbortController().signal,
      ...sizeErrors().factories,
    });
    assert.equal(result.transaction, rebuilt);
    assert.equal(result.raw, raw);
    assert.equal(build.mock.callCount(), 2);
    assert.deepEqual(build.mock.calls[0].arguments, [[]]);
    assert.equal(build.mock.calls[1].arguments[0], LOOKUPS);
    assert.equal(loadLookupTables.mock.callCount(), 1);
  });

  for (const lookupFailure of ['missing', 'failed'] as const) {
    test(`${trigger} preserves the size error when lookups are ${lookupFailure}`, async (context) => {
      const errors = sizeErrors();
      const built = serializedTransaction(context, initialResult());
      const build = context.mock.fn((_tables: AddressLookupTableAccount[]) => built);
      const loadLookupTables = context.mock.fn(async () => {
        if (lookupFailure === 'failed') throw new Error('Lookup provider unavailable');
        return [];
      });
      await assert.rejects(buildSizedTransaction({
        build,
        loadLookupTables,
        signal: new AbortController().signal,
        ...errors.factories,
      }), (error) => error === (trigger === 'encoding overflow' ? errors.encodingError : errors.packetError));
      assert.deepEqual(errors.packetSizes, trigger === 'encoding overflow' ? [] : [SOLANA_MAX_RAW_TX_BYTES + 1]);
      assert.equal(build.mock.callCount(), 1);
      assert.equal(loadLookupTables.mock.callCount(), 1);
    });
  }

  for (const retryFailure of ['encoding overflow', 'packet overflow'] as const) {
    test(`${trigger} maps rebuilt ${retryFailure} without another retry`, async (context) => {
      const errors = sizeErrors();
      const initial = serializedTransaction(context, initialResult());
      const rebuilt = serializedTransaction(context, retryFailure === 'encoding overflow'
        ? overflow()
        : new Uint8Array(SOLANA_MAX_RAW_TX_BYTES + 7));
      const build = context.mock.fn((tables: AddressLookupTableAccount[]) => tables.length ? rebuilt : initial);
      const loadLookupTables = context.mock.fn(async () => LOOKUPS);
      await assert.rejects(buildSizedTransaction({
        build,
        loadLookupTables,
        signal: new AbortController().signal,
        ...errors.factories,
      }), (error) => error === (retryFailure === 'encoding overflow' ? errors.encodingError : errors.packetError));
      assert.deepEqual(errors.packetSizes, retryFailure === 'encoding overflow' ? [] : [SOLANA_MAX_RAW_TX_BYTES + 7]);
      assert.equal(build.mock.callCount(), 2);
      assert.equal(loadLookupTables.mock.callCount(), 1);
    });
  }

  for (const cancellation of ['direct', 'wrapped'] as const) {
    test(`${trigger} preserves the exact ${cancellation} lookup cancellation reason`, async (context) => {
      const controller = new AbortController();
      const reason = new DOMException('Request cancelled', 'AbortError');
      const built = serializedTransaction(context, initialResult());
      const build = context.mock.fn((_tables: AddressLookupTableAccount[]) => built);
      const loadLookupTables = context.mock.fn(async () => {
        controller.abort(reason);
        throw cancellation === 'direct' ? reason : new Error('Lookup interrupted', { cause: reason });
      });
      await assert.rejects(buildSizedTransaction({
        build,
        loadLookupTables,
        signal: controller.signal,
        ...sizeErrors().factories,
      }), (error) => error === reason);
      assert.equal(build.mock.callCount(), 1);
      assert.equal(loadLookupTables.mock.callCount(), 1);
    });
  }

  test(`${trigger} does not turn an unrelated lookup failure into a late cancellation`, async (context) => {
    const errors = sizeErrors();
    const controller = new AbortController();
    const built = serializedTransaction(context, initialResult());
    await assert.rejects(buildSizedTransaction({
      build: () => built,
      loadLookupTables: async () => {
        controller.abort(new DOMException('Request cancelled', 'AbortError'));
        throw new Error('Lookup provider unavailable');
      },
      signal: controller.signal,
      ...errors.factories,
    }), (error) => error === (trigger === 'encoding overflow' ? errors.encodingError : errors.packetError));
  });
}

for (const stage of ['initial', 'lookup retry'] as const) {
  for (const operation of ['build', 'serialize'] as const) {
    test(`unrelated ${operation} failures during ${stage} propagate unchanged`, async (context) => {
      const failure = new Error('Invalid transaction instruction');
      const oversized = serializedTransaction(context, new Uint8Array(SOLANA_MAX_RAW_TX_BYTES + 1));
      const invalid = serializedTransaction(context, failure);
      const build = context.mock.fn((tables: AddressLookupTableAccount[]) => {
        if (stage === 'lookup retry' && tables.length === 0) return oversized;
        if (operation === 'build') throw failure;
        return invalid;
      });
      const loadLookupTables = context.mock.fn(async () => LOOKUPS);
      await assert.rejects(buildSizedTransaction({
        build,
        loadLookupTables,
        signal: new AbortController().signal,
        ...sizeErrors().factories,
      }), (error) => error === failure);
      assert.equal(build.mock.callCount(), stage === 'initial' ? 1 : 2);
      assert.equal(loadLookupTables.mock.callCount(), stage === 'initial' ? 0 : 1);
    });
  }
}

test('recognized overflow while building the initial transaction also retries with lookup tables', async (context) => {
  const built = transaction();
  const build = context.mock.fn((tables: AddressLookupTableAccount[]) => {
    if (tables.length === 0) throw overflow();
    return built;
  });
  const result = await buildSizedTransaction({
    build,
    loadLookupTables: async () => LOOKUPS,
    signal: new AbortController().signal,
    ...sizeErrors().factories,
  });
  assert.equal(result.transaction, built);
  assert.deepEqual(result.raw, built.serialize());
  assert.equal(build.mock.callCount(), 2);
});

for (const useLookup of [false, true]) {
  test(`signed transaction and bytes remain unchanged ${useLookup ? 'after lookup retry' : 'without retry'}`, async (context) => {
    const signed = transaction();
    signed.sign([SIGNER]);
    const signatures = signed.signatures.map((signature) => Uint8Array.from(signature));
    const raw = signed.serialize();
    const oversized = serializedTransaction(context, new Uint8Array(SOLANA_MAX_RAW_TX_BYTES + 1));
    const result = await buildSizedTransaction({
      build: (tables) => useLookup && tables.length === 0 ? oversized : signed,
      loadLookupTables: async () => LOOKUPS,
      signal: new AbortController().signal,
      ...sizeErrors().factories,
    });
    assert.equal(result.transaction, signed);
    assert.deepEqual(signed.signatures, signatures);
    assert.deepEqual(result.raw, raw);
    assert.deepEqual(VersionedTransaction.deserialize(result.raw).signatures, signatures);
  });
}
