import { defineNewDropConfig } from '../shared/newDropConfig.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: true,
    dropSymbol: 'shirt',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: true,
    reuseProgramIdFromDropId: 'little_swag_hoodies',
  },
  onchain: {
    dropId: 'drifella_shirt',
    dropFamily: 'drifella_shirt',
    metadataBase: 'https://cdn.lil.org/nft/drifella_shirt/json',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 10 },
        { key: 'XL', label: 'XL', startId: 11, endId: 23 },
        { key: '2XL', label: '2XL', startId: 24, endId: 26 },
      ],
    },
    collectionMetadata: {
      name: 'Drifella Shirt',
      description: 'drifella shirt · physical on mons dot shop',
      externalUrl: 'https://mons.shop',
      image: 'https://cdn.lil.org/nft/drifella_shirt/images/shirt.png',
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/drifella_shirt.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 1.44,
    discountPriceSol: 1.44,
    discountMintsPerWallet: 1,
    maxSupply: 26,
    itemsPerBox: 0,
    maxPerTx: 1,
    namePrefix: 'shirt',
    figureNamePrefix: 'shirt',
  },
});
