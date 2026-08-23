import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import type { DecodedBoxMinterConfigData } from '../../../../functions/src/shared/boxMinterConfigCodec.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../functions/src/shared/solanaProgramAddresses.ts';
import { StripeCheckoutFulfillmentError } from '../../../../functions/src/stripeCheckout/errors.ts';
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
