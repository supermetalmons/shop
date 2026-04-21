import { defineNewDropConfig } from '../shared/newDropConfig.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: true,
    dropSymbol: 'poncho',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: true,
  },
  onchain: {
    dropId: 'poncho_drifella',
    dropFamily: 'poncho_drifella',
    metadataBase: 'https://assets.mons.link/drops/poncho',
    collectionMetadata: {
      name: 'Poncho Drifella',
      description: 'poncho drifella cards · redeem physical on mons.shop',
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
    priceSol: 0.69,
    discountPriceSol: 0.42,
    discountMintsPerWallet: 3,
    maxSupply: 207,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
  },
});
