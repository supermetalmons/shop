import type { NewDropConfigInput } from '../../shared/newDropConfig.ts';

export const NEW_DROP_INPUT = {
  shared: {
    isMainnet: false,
  },
  deploy: {
    reuseProgramId: false,
  },
  onchain: {
    dropId: 'replace_receipts_devnet',
    dropFamily: 'default',
    displayName: 'REPLACE_DISPLAY_NAME',
    salesMode: 'stripe_receipt_only',
    receiptPoolId: 'REPLACE_RECEIPT_POOL_ID',
    metadataBase: 'https://example.com/replace_receipts/json',
    treasury: 'REPLACE_TREASURY',
    priceSol: 1_000_000,
    discountPriceSol: 1_000_000,
    stripeCheckoutEnabled: true,
    stripeLiveUnitAmountCents: 1_000,
    stripeProductTaxCode: 'REPLACE_STRIPE_TAX_CODE',
    discountMintsPerWallet: 1,
    maxSupply: 10,
    itemsPerBox: 0,
    maxPerTx: 1,
    namePrefix: 'item',
    figureNamePrefix: 'item',
  },
} satisfies NewDropConfigInput;
