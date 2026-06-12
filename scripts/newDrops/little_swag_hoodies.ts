import { defineNewDropConfig } from '../shared/newDropConfig.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: true,
    dropSymbol: 'hoodie',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: false,
  },
  onchain: {
    dropId: 'little_swag_hoodies',
    dropFamily: 'little_swag_hoodies',
    metadataBase: 'bafybeid5fkhvxxtvajnyeq3brvmepadmqyvmlt7wwifrwfgzzdhurzcmpy',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 15 },
        { key: 'XL', label: 'XL', startId: 16, endId: 30 },
        { key: '2XL', label: '2XL', startId: 31, endId: 34 },
      ],
    },
    collectionMetadata: {
      name: 'Little Swag Hoodies',
      description: 'lsw cobalt blue hoodie · physical on mons dot shop',
      externalUrl: 'https://mons.shop',
      image: 'ipfs://bafybeiaka2o45fhcmufpvthgp53xslhnblmqzeg4dri2rqozd7yqndjck4/hoodie.webp',
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/little_swag_hoodies.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 3,
    discountPriceSol: 2.55,
    stripeCheckoutEnabled: true,
    stripeLiveUnitAmountCents: 21900,
    stripeProductTaxCode: 'txcd_30011000',
    discountMintsPerWallet: 1,
    maxSupply: 34,
    itemsPerBox: 0,
    maxPerTx: 15,
    namePrefix: 'hoodie',
    figureNamePrefix: 'hoodie',
  },
});
