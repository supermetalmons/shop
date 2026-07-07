import { defineNewDropConfig } from '../shared/newDropConfig.ts';
import { LITTLE_SWAG_HOODIE_COLLECTION_IMAGE_URL } from '../../src/config/dropMediaDefaults.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: false,
    dropSymbol: 'hoodie',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: false,
  },
  onchain: {
    dropId: 'little_swag_hoodies_devnet',
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
      image: LITTLE_SWAG_HOODIE_COLLECTION_IMAGE_URL,
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/little_swag_hoodies.csv',
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
