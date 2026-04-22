import { defineNewDropConfig } from '../shared/newDropConfig.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: false,
    dropSymbol: 'hoodie',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: true,
  },
  onchain: {
    dropId: 'lsw_cobalt_figure_hoodie_26_devnet_x3',
    dropFamily: 'lsw_cobalt_figure_hoodie',
    metadataBase: 'https://assets.mons.link/drops/hoodie',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 15 },
        { key: 'XL', label: 'XL', startId: 16, endId: 30 },
        { key: '2XL', label: '2XL', startId: 31, endId: 34 },
      ],
    },
    collectionMetadata: {
      name: 'lsw cobalt figure hoodie 26',
      description: 'little swag world hoodie - redeem physical on mons.shop',
      externalUrl: 'https://mons.shop',
      image: 'https://assets.mons.link/drops/hoodie/hoodie.webp',
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/lsw_hoodie.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 0.069,
    discountPriceSol: 0.042,
    discountMintsPerWallet: 1,
    maxSupply: 34,
    itemsPerBox: 0,
    maxPerTx: 15,
    namePrefix: 'hoodie',
    figureNamePrefix: 'hoodie',
  },
});
