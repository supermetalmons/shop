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
  discountMintsPerWallet: number;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;
};

export type NewDropConfig = {
  deploy: NewDropDeployConfig;
  onchain: NewDropOnchainConfig;
};

// Toggle this to pick deployment network from one place.
const isMainnet = false;
const solanaCluster: SolanaCluster = isMainnet ? 'mainnet-beta' : 'devnet';
const dropSymbol = 'lsb';
const sellerFeeBasisPoints = 500;

/**
 * Single source of truth for editable deploy + drop metadata.
 * Update this file for each new drop.
 */
export const NEW_DROP: NewDropConfig = {
  deploy: {
    solanaCluster,
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    reuseProgramId: false,
  },
  onchain: {
    dropId: 'little_swag_boxes_devnet',
    metadataBase: 'https://assets.mons.link/drops/lsb',
    collectionMetadata: {
      name: 'Little Swag Boxes',
      symbol: dropSymbol,
      sellerFeeBasisPoints,
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
    coreCollectionRoyaltiesBps: sellerFeeBasisPoints,
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 0.1,
    discountPriceSol: 0.055,
    discountMintsPerWallet: 1,
    maxSupply: 333,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'box',
    figureNamePrefix: 'figure',
    symbol: dropSymbol,
  },
};
