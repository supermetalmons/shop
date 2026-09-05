import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { runMintWorkflow, type MintMode } from '../src/shop/mint.ts';

type Options = Parameters<typeof runMintWorkflow>[0];
type Operations = Parameters<typeof runMintWorkflow>[1];
type Config = Awaited<ReturnType<Operations['fetchConfig']>>;
type Mint = Awaited<ReturnType<Operations['buildTransaction']>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function harness(mode: MintMode = 'mint') {
  const key = new PublicKey(new Uint8Array(32).fill(1));
  const config: Config = {
    pubkey: key,
    admin: key,
    treasury: key,
    coreCollection: key,
    priceLamports: 1n,
    discountPriceLamports: 1n,
    discountMerkleRoot: new Uint8Array(32),
    discountMintsPerWallet: 5,
    maxSupply: 100,
    maxPerTx: 5,
    itemsPerBox: 1,
    started: true,
    minted: 0,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: 'test',
    uriBase: '',
    bump: 1,
    mintVariantKind: 0,
    mintVariantStartIds: [0, 0, 0],
    mintVariantEndIds: [0, 0, 0],
    mintVariantNextIds: [0, 0, 0],
    paymentRouting: { schema: 'legacy', mintProceeds: [], deliveryPaymentReceiver: key },
  };
  const options: Options = {
    mode,
    quantity: 2,
    drop: { namePrefix: 'pack' },
    discountRemainingCount: 4,
    lock: { current: null },
  };
  const events: string[] = [];
  const busy: boolean[] = [];
  const confirmed: Array<{ quantity: number; assetIds: string[] }> = [];
  const discounts: Array<{ remaining: number; used: number | undefined }> = [];
  const toasts: string[] = [];
  const warnings: Array<{ message: string; error: unknown }> = [];
  const built: Mint[] = [];
  const sent: Mint[] = [];
  const refreshed: boolean[] = [];
  const proof = [new Uint8Array([1, 2, 3])];
  const rejected = new Error('Wallet rejected request');
  const operations: Operations = {
    setBusy: (value) => {
      events.push(`busy:${value}`);
      busy.push(value);
    },
    getDiscountProof: async () => {
      events.push('proof');
      return proof;
    },
    fetchConfig: async () => {
      events.push('config');
      return config;
    },
    fetchDiscountUsedCount: async () => {
      events.push('used');
      return 1;
    },
    buildTransaction: async (receivedConfig, receivedProof) => {
      events.push('build');
      assert.equal(receivedConfig, config);
      assert.equal(receivedProof, mode === 'discount' ? proof : null);
      const mint: Mint = {
        tx: new VersionedTransaction(new TransactionMessage({
          payerKey: key,
          recentBlockhash: key.toBase58(),
          instructions: [],
        }).compileToV0Message()),
        boxAccounts: [new PublicKey(new Uint8Array(32).fill(built.length + 2))],
      };
      built.push(mint);
      return mint;
    },
    sendAndConfirm: async (mint) => {
      events.push('send');
      sent.push(mint);
      return false;
    },
    onConfirmed: (quantity, assetIds) => {
      events.push('confirmed');
      confirmed.push({ quantity, assetIds });
    },
    updateDiscount: (remaining, used) => {
      events.push('discount');
      discounts.push({ remaining, used });
    },
    refresh: async (value) => {
      events.push('refresh');
      refreshed.push(value);
    },
    isUserRejectedError: (error) => error === rejected,
    showToast: (message) => { toasts.push(message); },
    warn: (message, error) => { warnings.push({ message, error }); },
  };
  return { options, operations, config, proof, rejected, events, busy, confirmed, discounts, toasts, warnings, built, sent, refreshed };
}

for (const mode of ['mint', 'discount'] as const) {
  for (const sizeSelection of [false, true]) {
    test(`${mode} records the correct quantity for ${sizeSelection ? 'size' : 'quantity'} selection`, async () => {
      const h = harness(mode);
      if (sizeSelection) {
        h.options.drop.mintSelection = {
          kind: 'size',
          options: [{ key: 'L', label: 'L', startId: 1, endId: 5 }],
        };
      }
      await runMintWorkflow(h.options, h.operations);
      const quantity = sizeSelection ? 1 : 2;
      assert.deepEqual(h.confirmed, [{ quantity, assetIds: h.built[0].boxAccounts.map((key) => key.toBase58()) }]);
      assert.deepEqual(h.sent, h.built);
      assert.deepEqual(h.refreshed, [true]);
      assert.deepEqual(h.discounts, mode === 'discount' ? [{ remaining: 4 - quantity, used: 1 + quantity }] : []);
      assert.deepEqual(h.events, [
        'busy:true',
        ...(mode === 'discount' ? ['proof', 'config', 'used'] : ['config']),
        'build', 'send', 'confirmed',
        ...(mode === 'discount' ? ['discount'] : []),
        'refresh', 'busy:false',
      ]);
      assert.equal(h.options.lock.current, null);
    });
  }
}

test('invalid local discount quantities stop before locking or fetching', async () => {
  for (const quantity of [0, -1, NaN, Infinity, 5]) {
    const h = harness('discount');
    h.options.quantity = quantity;
    await runMintWorkflow(h.options, h.operations);
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.toasts, ['Discount available for up to 4 packs']);
    assert.equal(h.options.lock.current, null);
  }
  const h = harness('discount');
  h.options.discountRemainingCount = 0;
  await runMintWorkflow(h.options, h.operations);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.toasts, ['Wallet is not eligible for the discount']);
});

test('missing discount proof resets eligibility without fetching config', async () => {
  const h = harness('discount');
  h.operations.getDiscountProof = async () => {
    h.events.push('proof');
    return null;
  };
  await runMintWorkflow(h.options, h.operations);
  assert.deepEqual(h.events, ['busy:true', 'proof', 'discount', 'busy:false']);
  assert.deepEqual(h.discounts, [{ remaining: 0, used: undefined }]);
  assert.deepEqual(h.toasts, ['Wallet is not eligible for the discount']);
  assert.equal(h.options.lock.current, null);
});

test('on-chain discount allowance is checked after proof and config, before building', async () => {
  for (const allowance of [1, 2]) {
    const h = harness('discount');
    h.config.discountMintsPerWallet = allowance;
    await runMintWorkflow(h.options, h.operations);
    assert.deepEqual(h.events, ['busy:true', 'proof', 'config', 'used', 'discount', 'busy:false']);
    assert.deepEqual(h.discounts, [{ remaining: allowance - 1, used: 1 }]);
    assert.deepEqual(h.toasts, [allowance === 1 ? 'Wallet is not eligible for the discount' : 'Discount available for up to 1 pack']);
    assert.equal(h.options.lock.current, null);
  }
});

test('the lock is acquired synchronously and excludes overlapping mint modes', async () => {
  for (const mode of ['mint', 'discount'] as const) {
    const h = harness(mode);
    const blocked = harness(mode === 'mint' ? 'discount' : 'mint');
    const config = deferred<Config>();
    h.operations.fetchConfig = () => config.promise;
    const activeRun = runMintWorkflow(h.options, h.operations);
    assert.equal(h.options.lock.current, mode);
    assert.deepEqual(h.busy, [true]);
    blocked.options.lock = h.options.lock;
    await runMintWorkflow(blocked.options, blocked.operations);
    assert.deepEqual(blocked.events, []);
    assert.deepEqual(blocked.toasts, []);
    config.resolve(h.config);
    await activeRun;
    assert.equal(h.options.lock.current, null);
    assert.deepEqual(h.busy, [true, false]);
  }
});

test('cleanup does not clear a lock belonging to the other mint mode', async () => {
  const h = harness();
  h.operations.refresh = async () => { h.options.lock.current = 'discount'; };
  await runMintWorkflow(h.options, h.operations);
  assert.equal(h.options.lock.current, 'discount');
  assert.deepEqual(h.busy, [true, false]);
});

test('blockhash expiry rebuilds once and confirms only the final attempt asset IDs', async () => {
  const h = harness('discount');
  h.operations.sendAndConfirm = async (mint) => {
    h.sent.push(mint);
    if (h.sent.length === 1) throw new Error('Blockhash not found');
    return false;
  };
  await runMintWorkflow(h.options, h.operations);
  assert.equal(h.built.length, 2);
  assert.deepEqual(h.sent, h.built);
  assert.notEqual(h.built[0].boxAccounts[0].toBase58(), h.built[1].boxAccounts[0].toBase58());
  assert.deepEqual(h.confirmed, [{ quantity: 2, assetIds: h.built[1].boxAccounts.map((key) => key.toBase58()) }]);
  assert.equal(h.events.filter((event) => event === 'proof').length, 1);
  assert.equal(h.events.filter((event) => event === 'config').length, 1);
  assert.equal(h.events.filter((event) => event === 'used').length, 1);
  assert.deepEqual(h.discounts, [{ remaining: 2, used: 3 }]);
  assert.deepEqual(h.toasts, ['Transaction expired before you approved it. Please approve again…']);
  assert.equal(h.options.lock.current, null);
});

test('a second blockhash expiry stops rather than starting a third attempt', async () => {
  for (const mode of ['mint', 'discount'] as const) {
    const h = harness(mode);
    const error = new Error('Blockhash not found');
    h.operations.sendAndConfirm = async () => { throw error; };
    const run = runMintWorkflow(h.options, h.operations);
    if (mode === 'mint') await assert.rejects(run, (failure) => failure === error);
    else await run;
    assert.equal(h.built.length, 2);
    assert.deepEqual(h.confirmed, []);
    assert.deepEqual(h.refreshed, []);
    assert.deepEqual(h.discounts, []);
    assert.deepEqual(h.toasts, [
      'Transaction expired before you approved it. Please approve again…',
      ...(mode === 'discount' ? ['Blockhash not found'] : []),
    ]);
    assert.equal(h.options.lock.current, null);
    assert.deepEqual(h.busy, [true, false]);
  }
});

test('failed confirmation refreshes without optimistic assets or consuming discount allowance', async () => {
  for (const mode of ['mint', 'discount'] as const) {
    const h = harness(mode);
    h.operations.sendAndConfirm = async () => true;
    await runMintWorkflow(h.options, h.operations);
    assert.deepEqual(h.confirmed, []);
    assert.deepEqual(h.refreshed, [false]);
    assert.deepEqual(h.discounts, mode === 'discount' ? [{ remaining: 4, used: 1 }] : []);
    assert.deepEqual(h.toasts, []);
    assert.equal(h.options.lock.current, null);
  }
});

test('regular mint errors propagate while discounted mint errors toast locally', async () => {
  for (const mode of ['mint', 'discount'] as const) {
    const h = harness(mode);
    const error = new Error('RPC unavailable');
    h.operations.fetchConfig = async () => { throw error; };
    const run = runMintWorkflow(h.options, h.operations);
    if (mode === 'mint') await assert.rejects(run, (failure) => failure === error);
    else await run;
    assert.deepEqual(h.toasts, mode === 'discount' ? ['RPC unavailable'] : []);
    assert.deepEqual(h.confirmed, []);
    assert.deepEqual(h.refreshed, []);
    assert.equal(h.options.lock.current, null);
    assert.deepEqual(h.busy, [true, false]);
  }
});

test('non-Error discounted failures retain the drop-specific fallback message', async () => {
  const h = harness('discount');
  h.operations.fetchConfig = async () => { throw 'unavailable'; };
  await runMintWorkflow(h.options, h.operations);
  assert.deepEqual(h.toasts, ['Failed to mint discounted pack']);
  assert.equal(h.options.lock.current, null);
});

test('wallet rejection stays silent and releases either mint mode', async () => {
  for (const mode of ['mint', 'discount'] as const) {
    const h = harness(mode);
    h.operations.sendAndConfirm = async () => { throw h.rejected; };
    await runMintWorkflow(h.options, h.operations);
    assert.equal(h.built.length, 1);
    assert.deepEqual(h.confirmed, []);
    assert.deepEqual(h.refreshed, []);
    assert.deepEqual(h.toasts, []);
    assert.deepEqual(h.warnings, []);
    assert.equal(h.options.lock.current, null);
    assert.deepEqual(h.busy, [true, false]);
  }
});

test('refresh errors after confirmed mints warn without reporting mint failure', async () => {
  for (const mode of ['mint', 'discount'] as const) {
    const h = harness(mode);
    const error = new Error('Refresh unavailable');
    h.operations.refresh = async (confirmed) => {
      assert.equal(confirmed, true);
      throw error;
    };
    await runMintWorkflow(h.options, h.operations);
    assert.equal(h.confirmed.length, 1);
    assert.deepEqual(h.toasts, []);
    assert.deepEqual(h.warnings, [{
      message: mode === 'discount'
        ? 'Discount mint succeeded but failed to refresh mint state'
        : 'Mint succeeded but failed to refresh mint state',
      error,
    }]);
    assert.equal(h.options.lock.current, null);
    assert.deepEqual(h.busy, [true, false]);
  }
});
