import { defineNewDropConfig } from '../shared/newDropConfig.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: false,
    dropSymbol: 'poncho',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: true,
  },
  onchain: {
    dropId: 'poncho_drifella_devnet_x10',
    dropFamily: 'poncho_drifella',
    metadataBase: 'https://assets.mons.link/drops/poncho',
    collectionMetadata: {
      name: 'Poncho Drifella',
      description: 'poncho drifella cards · physical on mons dot shop',
      externalUrl: 'https://mons.shop',
      image: 'https://assets.mons.link/drops/poncho/pack.webp',
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/poncho_drifella.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 0.069,
    discountPriceSol: 0.042,
    discountMintsPerWallet: 3,
    maxSupply: 207,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
  },
});
