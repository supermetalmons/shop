import { defineNewDropConfig } from '../shared/newDropConfig.ts';
import { MONS_SHOP_RECEIPTS_POOL_ID } from '../shared/receiptPoolConfig.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: false,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: true,
    reuseProgramIdFromDropId: 'little_swag_hoodies_devnet',
  },
  onchain: {
    dropId: 'card_nft_binder_devnet',
    dropFamily: 'card_nft_binder',
    displayName: 'Card NFT Binder',
    salesMode: 'stripe_receipt_only',
    receiptPoolId: MONS_SHOP_RECEIPTS_POOL_ID,
    metadataBase: 'https://cdn.lil.org/nft/card_nft_binder/json',
    discountWhitelistCsvRelativePath:
      'scripts/discounts/card_nft_binder.csv',
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 1_000_000,
    discountPriceSol: 1_000_000,
    stripeCheckoutEnabled: true,
    stripeProductTaxCode: 'txcd_99999999',
    discountMintsPerWallet: 1,
    maxSupply: 15,
    itemsPerBox: 0,
    maxPerTx: 1,
    namePrefix: 'binder',
    figureNamePrefix: 'binder',
  },
});
