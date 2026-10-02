import type { NewDropConfigInput } from '../../shared/newDropConfig.ts';

export const NEW_DROP_INPUT = {
  shared: {
    isMainnet: false,
    dropSymbol: 'item',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    reuseProgramId: false,
  },
  onchain: {
    dropId: 'replace_variants_devnet',
    dropFamily: 'default',
    metadataBase: 'https://example.com/replace_variants/json',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 10 },
        { key: 'XL', label: 'XL', startId: 11, endId: 20 },
        { key: '2XL', label: '2XL', startId: 21, endId: 30 },
      ],
    },
    collectionMetadata: {
      name: 'REPLACE_COLLECTION_NAME',
      description: 'REPLACE_COLLECTION_DESCRIPTION',
      externalUrl: 'https://example.com',
      image: 'https://example.com/replace_variants/cover.png',
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/REPLACE_WHITELIST.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    treasury: 'REPLACE_TREASURY',
    priceSol: 0.1,
    discountPriceSol: 0.05,
    stripeCheckoutEnabled: false,
    discountMintsPerWallet: 1,
    maxSupply: 30,
    itemsPerBox: 0,
    maxPerTx: 1,
    namePrefix: 'item',
    figureNamePrefix: 'item',
  },
} satisfies NewDropConfigInput;
