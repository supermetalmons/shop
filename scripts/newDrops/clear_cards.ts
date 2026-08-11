import { defineNewDropConfig } from '../shared/newDropConfig.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: true,
    dropSymbol: 'clear',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: true,
    reuseProgramIdFromDropId: 'little_swag_hoodies',
  },
  onchain: {
    dropId: 'clear_cards',
    dropFamily: 'clear_cards',
    metadataBase: 'https://cdn.lil.org/nft/clear_cards/json',
    collectionMetadata: {
      name: 'Clear Cards',
      description: 'clear cards by duguccipourmonchat · physical on mons dot shop',
      externalUrl: 'https://mons.shop',
      image: 'https://cdn.lil.org/nft/clear_cards/pack.webp',
      creators: [
        {
          address: 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE',
          share: 100,
        },
      ],
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/clear_cards.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    paymentRouting: {
      mintProceeds: [
        {
          address: 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE',
          percentage: 70,
        },
        {
          address: 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz',
          percentage: 30,
        },
      ],
      deliveryPaymentReceiver:
        'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    },
    priceSol: 0.069,
    discountPriceSol: 0.01,
    stripeCheckoutEnabled: false,
    discountMintsPerWallet: 1,
    maxSupply: 192,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
  },
});
