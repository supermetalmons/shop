import assert from 'node:assert/strict';
import test from 'node:test';
import { AddressLookupTableProgram, PublicKey } from '@solana/web3.js';
import { API_DROPS } from '../src/dropConfig.ts';
import { deliveryPrepareTestHooks } from '../src/deliveryPrepare.ts';
import { irlClaimTestHooks } from '../src/irlClaim.ts';
import { receiptTransferTestHooks } from '../src/receiptTransfer.ts';
import {
  loadLatestBlockhash as loadAdminBlockhash,
  loadLookupTable as loadAdminLookupTable,
} from '../src/adminIrlRedeemOnchain.ts';
import { buildRuntime as buildAdminRuntime } from '../src/adminIrlRedeemRuntime.ts';
import { loadLatestBlockhash as loadRevealBlockhash } from '../src/revealDudesOnchain.ts';
import { runtimeForDrop } from '../src/revealDudesDomain.ts';
import type { ProfileProviderFetch } from '../src/boundedResponse.ts';

const ADDRESS = new PublicKey(new Uint8Array(32).fill(1));
const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const ACTIVE_SLOT = 0xffffffffffffffffn;
const DROP = { ...API_DROPS.card_nft_2, deliveryLookupTable: ADDRESS.toBase58() };

type ProviderContext = {
  apiKey: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
};

function providerContext(result: unknown): ProviderContext {
  return {
    apiKey: 'test-key',
    signal: new AbortController().signal,
    providerFetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: string };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    },
  };
}

function lookupAccount(deactivationSlot = ACTIVE_SLOT) {
  const data = Buffer.alloc(56);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(deactivationSlot, 4);
  return {
    owner: AddressLookupTableProgram.programId.toBase58(),
    data: [data.toString('base64'), 'base64'],
  };
}

const adapters = [
  {
    name: 'delivery',
    errorName: 'DeliveryPrepareError',
    providerName: 'Delivery',
    contextual: true,
    missing: 'error',
    inactive: 'error',
    loadBlockhash: (context: ProviderContext) =>
      deliveryPrepareTestHooks.loadLatestBlockhash(context, deliveryPrepareTestHooks.buildRuntime(DROP)),
    loadLookup: (context: ProviderContext) =>
      deliveryPrepareTestHooks.loadLookupTable(context, deliveryPrepareTestHooks.buildRuntime(DROP)),
  },
  {
    name: 'IRL claim',
    errorName: 'IrlClaimError',
    providerName: 'Claim',
    contextual: true,
    missing: 'empty',
    inactive: 'allow',
    loadBlockhash: (context: ProviderContext) =>
      irlClaimTestHooks.loadLatestBlockhash(context, irlClaimTestHooks.buildRuntime(DROP)),
    loadLookup: (context: ProviderContext) =>
      irlClaimTestHooks.loadLookupTable(context, irlClaimTestHooks.buildRuntime(DROP)),
  },
  {
    name: 'receipt transfer',
    errorName: 'ReceiptTransferError',
    providerName: 'Receipt transfer',
    contextual: false,
    missing: 'empty',
    inactive: 'allow',
    loadBlockhash: (context: ProviderContext) =>
      receiptTransferTestHooks.loadLatestBlockhash(context, receiptTransferTestHooks.buildRuntime(DROP)),
    loadLookup: (context: ProviderContext) =>
      receiptTransferTestHooks.loadLookupTable(context, receiptTransferTestHooks.buildRuntime(DROP)),
  },
  {
    name: 'admin redeem',
    errorName: 'AdminIrlRedeemPrepareError',
    providerName: 'Admin IRL redeem',
    contextual: false,
    missing: 'empty',
    inactive: 'empty',
    loadBlockhash: (context: ProviderContext) => loadAdminBlockhash(context, buildAdminRuntime(DROP)),
    loadLookup: (context: ProviderContext) => loadAdminLookupTable(context, buildAdminRuntime(DROP)),
  },
] as const;

for (const adapter of adapters) {
  test(`${adapter.name} keeps its configured lookup-table policies`, async () => {
    const tables = await adapter.loadLookup(providerContext({ value: lookupAccount() }));
    assert.equal(tables.length, 1);
    assert.ok(tables[0].key.equals(ADDRESS));
    assert.equal(tables[0].isActive(), true);

    const missing = adapter.loadLookup(providerContext({ value: null }));
    if (adapter.missing === 'error') {
      await assert.rejects(missing, {
        name: adapter.errorName,
        code: 'failed-precondition',
        message: 'DELIVERY_LOOKUP_TABLE not found on-chain.',
      });
    } else {
      assert.deepEqual(await missing, []);
    }

    const inactive = adapter.loadLookup(providerContext({ value: lookupAccount(1n) }));
    if (adapter.inactive === 'error') {
      await assert.rejects(inactive, {
        name: adapter.errorName,
        code: 'failed-precondition',
        message: 'DELIVERY_LOOKUP_TABLE is inactive.',
      });
    } else {
      const inactiveTables = await inactive;
      assert.equal(inactiveTables.length, adapter.inactive === 'allow' ? 1 : 0);
      if (inactiveTables.length) assert.equal(inactiveTables[0].isActive(), false);
    }
  });

  test(`${adapter.name} keeps lookup ownership, shape, bytes, and layout errors distinct`, async () => {
    for (const { value, code, message } of [
      {
        value: { ...lookupAccount(), owner: PublicKey.default.toBase58() },
        code: 'failed-precondition',
        message: 'DELIVERY_LOOKUP_TABLE has an unexpected owner.',
      },
      {
        value: {},
        code: 'failed-precondition',
        message: 'DELIVERY_LOOKUP_TABLE is invalid.',
      },
      {
        value: { ...lookupAccount(), data: ['', 'base58'] },
        code: 'unavailable',
        message: `${adapter.providerName} provider returned invalid account data.`,
      },
      {
        value: { ...lookupAccount(), data: [Buffer.alloc(1).toString('base64'), 'base64'] },
        code: 'failed-precondition',
        message: 'DELIVERY_LOOKUP_TABLE is invalid.',
      },
    ]) {
      await assert.rejects(adapter.loadLookup(providerContext({ value })), {
        name: adapter.errorName,
        code,
        message,
      });
    }
  });

  test(`${adapter.name} keeps the exact lookup cancellation reason`, async () => {
    const controller = new AbortController();
    const reason = new DOMException('Client disconnected', 'AbortError');
    const context = providerContext(undefined);
    await assert.rejects(adapter.loadLookup({
      ...context,
      signal: controller.signal,
      providerFetch: async () => {
        controller.abort(reason);
        throw new Error('Provider failed after cancellation');
      },
    }), (error) => error === reason);
  });
}

const blockhashAdapters = [
  ...adapters,
  {
    name: 'reveal',
    errorName: 'RevealDudesError',
    providerName: 'Reveal',
    contextual: true,
    loadBlockhash: (context: ProviderContext) => loadRevealBlockhash({
      apiKey: context.apiKey,
      fetch: context.providerFetch,
      signal: context.signal,
    }, runtimeForDrop(DROP.dropId)),
  },
];

for (const adapter of blockhashAdapters) {
  test(`${adapter.name} keeps its blockhash context and domain-error contract`, async () => {
    const result = await adapter.loadBlockhash(providerContext({
      context: { slot: 123 },
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 456 },
    }));
    assert.deepEqual(result, adapter.contextual ? { blockhash: BLOCKHASH, blockhashContextSlot: 123 } : BLOCKHASH);

    for (const blockhash of [BLOCKHASH, PublicKey.default.toBase58()]) {
      const withoutContext = adapter.loadBlockhash(providerContext({ value: { blockhash } }));
      if (adapter.contextual) {
        await assert.rejects(withoutContext, {
          name: adapter.errorName,
          code: 'unavailable',
          message: `${adapter.providerName} provider returned an invalid blockhash.`,
        });
      } else {
        assert.equal(await withoutContext, blockhash);
      }
    }
    await assert.rejects(adapter.loadBlockhash(providerContext({ value: { blockhash: 'invalid' } })), {
      name: adapter.errorName,
      code: 'unavailable',
      message: `${adapter.providerName} provider returned an invalid blockhash.`,
    });
  });
}
