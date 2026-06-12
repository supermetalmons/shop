import { defineNewDropConfig } from '../shared/newDropConfig.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: true,
    dropSymbol: 'cardnft2',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: true,
  },
  onchain: {
    dropId: 'card_nft_2',
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
      // 3711 packs * (3 cards + 1 pack receipt) = 14844 leaves; 2^14 = 16384.
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 0.44,
    discountPriceSol: 0.36,
    discountMintsPerWallet: 1,
    maxSupply: 3711,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
  },
});
