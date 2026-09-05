import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import type { DecodedBoxMinterConfigData } from '../../../../shared/boxMinterConfigCodec.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import { StripeCheckoutFulfillmentError } from '../src/stripeCheckout/errors.ts';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { isCommerceServerTimestamp } from '../src/commerceRepositoryTypes.ts';
import { createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import {
  flowDependencies,
  fulfillmentRuntime,
  isMplCoreCollectionAccount,
  lazyAddressEncryptor,
  packStatusEventQuantity,
  validateOnchainConfig,
  workerFulfillmentCompletionFields,
} from '../src/stripeCheckoutFulfillment.ts';

const stripeCheckoutFulfillmentTestHooks = {
  flowDependencies,
  fulfillmentRuntime,
  isMplCoreCollectionAccount,
  lazyAddressEncryptor,
  packStatusEventQuantity,
  validateOnchainConfig,
  workerFulfillmentCompletionFields,
};

function commerceFixture(context: TestContext) {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  return {
    harness,
    commerce: { repository: new D1CommerceRepository(harness.db), nowMs: Date.now },
  };
}

function matchingConfig(): {
  decoded: DecodedBoxMinterConfigData;
  runtime: ReturnType<typeof stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime>;
} {
  const runtime = stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_binder_devnet');
  const treasury = new PublicKey(runtime.config.treasury);
  return {
    runtime,
    decoded: {
      admin: PublicKey.unique().toBytes(),
      treasury: treasury.toBytes(),
      coreCollection: runtime.collectionMint.toBytes(),
      priceLamports: 0n,
      discountPriceLamports: 0n,
      discountMerkleRoot: new Uint8Array(32),
      discountMintsPerWallet: runtime.config.discountMintsPerWallet,
      maxSupply: runtime.config.maxSupply,
      maxPerTx: runtime.config.maxPerTx,
      itemsPerBox: runtime.itemsPerBox,
      started: true,
      minted: 0,
      namePrefix: runtime.config.namePrefix,
      figureNamePrefix: runtime.config.figureNamePrefix,
      symbol: runtime.config.symbol,
      uriBase: runtime.config.metadataBase,
      bump: 1,
      mintVariantKind: 0,
      mintVariantStartIds: [0, 0, 0],
      mintVariantEndIds: [0, 0, 0],
      mintVariantNextIds: [0, 0, 0],
      paymentRouting: {
        schema: 'legacy',
        mintProceeds: [{ address: treasury.toBytes(), percentage: 100 }],
        deliveryPaymentReceiver: treasury.toBytes(),
      },
    },
  };
}

test('Stripe fulfillment validates deployment invariants against on-chain config', () => {
  const { decoded, runtime } = matchingConfig();
  const result = stripeCheckoutFulfillmentTestHooks.validateOnchainConfig(runtime, decoded);
  assert.equal(result.coreCollection.toBase58(), runtime.collectionMint.toBase58());
  assert.throws(
    () => stripeCheckoutFulfillmentTestHooks.validateOnchainConfig(runtime, {
      ...decoded,
      maxSupply: decoded.maxSupply + 1,
    }),
    (error: unknown) => error instanceof StripeCheckoutFulfillmentError && error.code === 'failed-precondition',
  );
});

test('Stripe fulfillment accepts only MPL Core collection accounts', () => {
  const data = new Uint8Array(49);
  data[0] = 5;
  const collection = { data, owner: new PublicKey(MPL_CORE_PROGRAM_ADDRESS) };
  assert.equal(stripeCheckoutFulfillmentTestHooks.isMplCoreCollectionAccount(collection), true);
  assert.equal(stripeCheckoutFulfillmentTestHooks.isMplCoreCollectionAccount({
    ...collection,
    data: new Uint8Array(48),
  }), false);
  assert.equal(stripeCheckoutFulfillmentTestHooks.isMplCoreCollectionAccount({
    ...collection,
    data: new Uint8Array(49),
  }), false);
  assert.equal(stripeCheckoutFulfillmentTestHooks.isMplCoreCollectionAccount({
    ...collection,
    owner: PublicKey.unique(),
  }), false);
});

test('Stripe fulfillment pack-status events use card-equivalent quantity', () => {
  const runtime = stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_2');
  assert.equal(runtime.itemsPerBox, 3);
  assert.equal(stripeCheckoutFulfillmentTestHooks.packStatusEventQuantity(runtime, 2), 6);
});

test('Stripe fulfillment resolves late checkout ownership through Ops D1', async (context) => {
  const wallet = PublicKey.unique().toBase58();
  const opsDb = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return {
            auth_subject: 'anonymous-subject',
            wallet,
            updated_at_ms: 1,
            revision: 1,
            reconcile_lease_id: null,
            reconcile_lease_expires_at_ms: null,
          };
        },
      };
    },
  } as unknown as D1Database;
  const dependencies = stripeCheckoutFulfillmentTestHooks.flowDependencies(
    { ADDRESS_DECRYPTION_SECRET: '', OPS_DB: opsDb } as any,
    commerceFixture(context).commerce,
    new AbortController().signal,
  );
  assert.equal(await dependencies.resolveWalletOwner?.('anonymous-subject'), wallet);
});

test('Stripe fulfillment writes pack-status events to required D1 without reading commerce', async (context) => {
  let query = '';
  let bindings: unknown[] = [];
  let runs = 0;
  const dataDb = {
    prepare(value: string) {
      query = value;
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async run() {
          runs += 1;
          return { success: true, results: [], meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
  const { commerce } = commerceFixture(context);
  context.mock.method(commerce.repository, 'get', () => assert.fail('pack-status projection must not read commerce'));
  const dependencies = stripeCheckoutFulfillmentTestHooks.flowDependencies(
    { ADDRESS_DECRYPTION_SECRET: '', DATA_DB: dataDb } as any,
    commerce,
    new AbortController().signal,
  );
  assert.ok(dependencies.countPackStatus);
  await dependencies.countPackStatus({
    dropRuntime: stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_2'),
    orderHashHex: '12'.repeat(32),
    quantity: 2,
    deliveryId: 123,
    checkoutSessionId: 'cs_live_d1',
  });
  assert.match(query, /INSERT INTO pack_status_events/);
  assert.equal(runs, 1);
  assert.equal(bindings[0], 'card_nft_2');
  assert.equal(bindings[1], 'redeemedIrlStripe');
  assert.equal(bindings[2], '12'.repeat(32));
  assert.equal(bindings[3], 6);
  assert.equal(bindings[5], 0);
  assert.equal(bindings[6], 2);
  assert.equal(bindings[8], 123);
  assert.equal(bindings[9], 'cs_live_d1');
  assert.equal(bindings[12], 1);

  const missing = stripeCheckoutFulfillmentTestHooks.flowDependencies(
    { ADDRESS_DECRYPTION_SECRET: '' } as any,
    commerce,
    new AbortController().signal,
  );
  const missingCountPackStatus = missing.countPackStatus;
  assert.ok(missingCountPackStatus);
  await assert.rejects(
    missingCountPackStatus({
      dropRuntime: stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_2'),
      orderHashHex: '34'.repeat(32),
      quantity: 1,
      deliveryId: 124,
      checkoutSessionId: 'cs_live_missing_d1',
    }),
    /pack_status_data_db_not_configured/,
  );
});

test('Stripe pack-status repair skips unsupported drops and rejects inconsistent orders', async (context) => {
  const { harness, commerce } = commerceFixture(context);
  const reads = context.mock.method(commerce.repository, 'get', commerce.repository.get.bind(commerce.repository));
  const checkoutKey = commerceKeys.stripeCheckout('card_nft_2', 'cs_test_repair');
  seedCommerceDocument(harness, {
    key: checkoutKey,
    data: {
      dropId: 'card_nft_2',
      sessionId: 'cs_test_repair',
      deliveryId: 123,
      livemode: true,
    },
  });
  seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder('card_nft_2', '123'),
    data: {
      dropId: 'card_nft_2',
      deliveryId: 123,
      source: 'stripe_offchain',
      stripeCheckoutSessionId: 'wrong-session',
      offchainOrderHash: '00'.repeat(32),
      metadataIds: [1, 'invalid'],
    },
  });
  const dependencies = stripeCheckoutFulfillmentTestHooks.flowDependencies(
    { ADDRESS_DECRYPTION_SECRET: '' } as any,
    commerce,
    new AbortController().signal,
  );
  const repairPackStatus = dependencies.repairPackStatus;
  assert.ok(repairPackStatus);
  await repairPackStatus({
    dropRuntime: stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_binder_devnet'),
    checkoutKey: commerceKeys.stripeCheckout('card_nft_binder_devnet', 'cs_test_skip'),
    sessionId: 'cs_test_skip',
  });
  assert.equal(reads.mock.callCount(), 0);
  await assert.rejects(
    repairPackStatus({
      dropRuntime: stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_2'),
      checkoutKey,
      sessionId: 'cs_test_repair',
    }),
    /stripe_pack_status_repair_order_invalid/,
  );
});

test('Stripe fulfillment defers address encryption setup until the address is persisted', () => {
  const encryptAddress = stripeCheckoutFulfillmentTestHooks.lazyAddressEncryptor('');
  assert.throws(
    () => encryptAddress('Buyer Name\n1 Main St\nNew York, NY 10001\nUS'),
    (error: unknown) => error instanceof StripeCheckoutFulfillmentError && error.code === 'unavailable',
  );
});

test('Stripe fulfillment provides Worker completion fields for the atomic fulfilled write', () => {
  const fields = stripeCheckoutFulfillmentTestHooks.workerFulfillmentCompletionFields();
  assert.equal(fields.fulfillmentCompletedBy, 'cloudflare_queue_v1');
  assert.ok(isCommerceServerTimestamp(fields.fulfillmentCompletedAt));
});
