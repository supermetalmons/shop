import type { PreorderCollectionConfig } from '../shared/preorderCollectionConfig.ts';

export const NEW_PREORDER_COLLECTION: PreorderCollectionConfig = {
  collectionId: 'mi_note_cards',
  isMainnet: true,
  solanaRpcUrl: undefined,
  authority: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
  collectionMetadataUri: 'https://cdn.lil.org/nft/mi_note_cards/preorder/collection.json',
  collectionMetadata: {
    name: 'Mi Note Cards',
    symbol: 'minote',
    description: 'mi note cards · physical on mons dot shop',
    image: 'https://cdn.lil.org/nft/mi_note_cards/preorder/cover.jpg',
    externalUrl: 'https://mons.shop',
    sellerFeeBasisPoints: 500,
    creators: [
      { address: 'BmV4TRHUfMZcaa6iZA4tSGf6ACGoLLsYEHcC55AEKAYf', share: 100 },
    ],
  },
};
