import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import type { DecodedBoxMinterConfigData } from '../../../../shared/boxMinterConfigCodec.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import { StripeCheckoutFulfillmentError } from '../src/stripeCheckout/errors.ts';
import {
  StripeCheckoutServerTimestamp,
} from '../src/stripeCheckout/store.ts';
import { stripeCheckoutFulfillmentTestHooks } from '../src/stripeCheckoutFulfillment.ts';

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

test('Stripe pack-status repair skips unsupported drops and rejects inconsistent orders', async () => {
  let reads = 0;
  const store = {
    doc: () => {
      reads += 1;
      return {
        get: async () => ({
          exists: true,
          data: () => ({
            dropId: 'card_nft_2',
            deliveryId: 123,
            source: 'stripe_offchain',
            stripeCheckoutSessionId: 'wrong-session',
            offchainOrderHash: '00'.repeat(32),
            metadataIds: [1, 'invalid'],
          }),
        }),
      };
    },
  } as any;
  const dependencies = stripeCheckoutFulfillmentTestHooks.flowDependencies(
    { ADDRESS_DECRYPTION_SECRET: '' } as any,
    store,
    new AbortController().signal,
  );
  const repairPackStatus = dependencies.repairPackStatus;
  assert.ok(repairPackStatus);
  await repairPackStatus({
    dropRuntime: stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_binder_devnet'),
    checkoutRef: { get: async () => assert.fail('unsupported drops must not be read') } as any,
    sessionId: 'cs_test_skip',
  });
  assert.equal(reads, 0);
  await assert.rejects(
    repairPackStatus({
      dropRuntime: stripeCheckoutFulfillmentTestHooks.fulfillmentRuntime('card_nft_2'),
      checkoutRef: {
        get: async () => ({
          exists: true,
          data: () => ({
            dropId: 'card_nft_2',
            sessionId: 'cs_test_repair',
            deliveryId: 123,
            livemode: true,
          }),
        }),
      } as any,
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
  assert.ok(fields.fulfillmentCompletedAt instanceof StripeCheckoutServerTimestamp);
});
