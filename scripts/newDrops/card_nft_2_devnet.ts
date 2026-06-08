import { defineNewDropConfig } from '../shared/newDropConfig.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: false,
    dropSymbol: 'cardnft2',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: false,
  },
  onchain: {
    dropId: 'card_nft_2_devnet',
    dropFamily: 'card_nft_2',
    metadataBase: 'https://assets.mons.link/drops/cardnft2/json',
    collectionMetadata: {
      name: 'Card NFT 2',
      description: 'card nft 2 · physical on mons dot shop',
      externalUrl: 'https://mons.shop',
      image: 'https://assets.mons.link/drops/cardnft2/img/cover.gif',
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/card_nft_2.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 0.069,
    discountPriceSol: 0.042,
    discountMintsPerWallet: 3,
    maxSupply: 65,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
  },
});
