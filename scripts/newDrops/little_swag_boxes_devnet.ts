import { defineNewDropConfig } from '../shared/newDropConfig.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: false,
    dropSymbol: 'lsb',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: true,
  },
  onchain: {
    dropId: 'little_swag_boxes_devnet',
    dropFamily: 'little_swag_boxes',
    metadataBase: 'https://assets.mons.link/drops/lsb',
    collectionMetadata: {
      name: 'Little Swag Boxes',
      description: 'a collection of little swag boxes, figures and receipts',
      externalUrl: 'https://mons.shop',
      image: 'https://assets.mons.link/drops/lsb/box/default.webp',
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/little_swag_boxes.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 0.042,
    discountPriceSol: 0.01,
    discountMintsPerWallet: 1,
    maxSupply: 333,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'box',
    figureNamePrefix: 'figure',
  },
});
