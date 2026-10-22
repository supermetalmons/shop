import type { PreorderCollectionConfig } from '../shared/preorderCollectionConfig.ts';
import { NEW_PREORDER_COLLECTION as MAINNET_COLLECTION } from './mi_note_cards.ts';

export const NEW_PREORDER_COLLECTION: PreorderCollectionConfig = {
  ...MAINNET_COLLECTION,
  collectionId: 'mi_note_cards_devnet',
  isMainnet: false,
  solanaRpcUrl: undefined,
  collectionMetadataUri: 'https://cdn.lil.org/nft/mi_note_cards/preorder/collection.json',
  collectionMetadata: {
    ...MAINNET_COLLECTION.collectionMetadata,
    image: 'https://cdn.lil.org/nft/mi_note_cards/preorder/cover.jpg',
  },
};
