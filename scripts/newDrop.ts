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
const isMainnet = true;
const solanaCluster: SolanaCluster = isMainnet ? 'mainnet-beta' : 'devnet';
const dropSymbol = 'poncho';
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
    dropId: 'Poncho_Drifella',
    metadataBase: 'https://assets.mons.link/drops/poncho',
    collectionMetadata: {
      name: 'Poncho Drifella',
      symbol: dropSymbol,
      sellerFeeBasisPoints,
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
    coreCollectionRoyaltiesBps: sellerFeeBasisPoints,
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 0.69,
    discountPriceSol: 0.42,
    discountMintsPerWallet: 3,
    maxSupply: 207,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: dropSymbol,
  },
};
