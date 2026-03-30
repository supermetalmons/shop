export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

export type NewDropDeployConfig = {
  solanaCluster: SolanaCluster;
  solanaRpcUrl?: string;
  coreCollectionPubkey?: string;
  reuseProgramId: boolean;
};

export type NewDropOnchainConfig = {
  dropId: string;
  metadataBase: string;
  collectionMetadata: {
    name: string;
    symbol: string;
    sellerFeeBasisPoints: number;
    description?: string;
    externalUrl?: string;
    image?: string;
  };
  discountWhitelistCsvRelativePath: string;
  receiptsTree: {
    maxDepth: number;
    maxBufferSize: number;
    canopyDepth: number;
  };
  coreCollectionRoyaltiesBps: number;
  treasury?: string;
  priceSol: number;
  discountPriceSol: number;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  symbol: string;
};

export type NewDropConfig = {
  deploy: NewDropDeployConfig;
  onchain: NewDropOnchainConfig;
};

/**
 * Single source of truth for editable deploy + drop metadata.
 * Update this file for each new drop.
 */
export const NEW_DROP: NewDropConfig = {
  deploy: {
    solanaCluster: 'mainnet-beta',
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: false,
  },
  onchain: {
    dropId: 'little_swag_boxes',
    metadataBase: 'https://assets.mons.link/drops/lsb',
    collectionMetadata: {
      name: 'Little Swag Boxes',
      symbol: 'lsb',
      sellerFeeBasisPoints: 500,
      description: 'a collection of little swag boxes, figures and receipts',
      externalUrl: 'https://mons.shop',
      image: 'https://assets.mons.link/drops/lsb/box/default.webp',
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/little_swag_boxes.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    coreCollectionRoyaltiesBps: 500,
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 1,
    discountPriceSol: 0.55,
    maxSupply: 333,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'box',
    symbol: 'box',
  },
};
