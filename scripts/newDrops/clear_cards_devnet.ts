import { defineNewDropConfig } from '../shared/newDropConfig.ts';
import { CLEAR_CARDS_PACK_CLEAN_IMAGE_URL } from '../../functions/src/shared/dropMediaDefaults.ts';

export const NEW_DROP = defineNewDropConfig({
  shared: {
    isMainnet: false,
    dropSymbol: 'clear',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: true,
    reuseProgramIdFromDropId: 'little_swag_hoodies_devnet',
  },
  onchain: {
    dropId: 'clear_cards_devnet',
    dropFamily: 'clear_cards',
    metadataBase: 'https://cdn.lil.org/nft/clear_cards/wip/json',
    collectionMetadata: {
      name: 'Clear Cards',
      description: 'clear cards · physical on mons dot shop',
      externalUrl: 'https://mons.shop',
      image: CLEAR_CARDS_PACK_CLEAN_IMAGE_URL,
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/admin_only.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    treasury: 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE',
    priceSol: 0.069,
    discountPriceSol: 0.042,
    discountMintsPerWallet: 1,
    maxSupply: 192,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
  },
});
