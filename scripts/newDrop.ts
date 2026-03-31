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
const dropSymbol = 'green';
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
    dropId: 'green_boxes_devnet',
    metadataBase: 'https://assets.mons.link/drops/test/green',
    collectionMetadata: {
      name: 'green test',
      symbol: dropSymbol,
      sellerFeeBasisPoints,
      description: 'green test mons.shop drop',
      externalUrl: 'https://mons.shop',
      image: 'https://assets.mons.link/drops/test/green/box/default.png',
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/little_swag_boxes.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    coreCollectionRoyaltiesBps: sellerFeeBasisPoints,
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 0.05,
    discountPriceSol: 0.023,
    discountMintsPerWallet: 3,
    maxSupply: 33,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'chest',
    figureNamePrefix: 'item',
    symbol: dropSymbol,
  },
};
