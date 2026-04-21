import type { DropFamily, MintSelectionConfigSerialized } from './shared/deploymentRegistry.ts';

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

export type NewDropDeployConfig = {
  solanaCluster: SolanaCluster;
  solanaRpcUrl?: string;
  coreCollectionPubkey?: string;
  reuseProgramId: boolean;
};

export type NewDropOnchainConfig = {
  dropId: string;
  dropFamily: DropFamily;
  metadataBase: string;
  mintSelection?: MintSelectionConfigSerialized;
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

export type NewDropSharedConfig = {
  isMainnet: boolean;
  dropSymbol: string;
  sellerFeeBasisPoints: number;
};

export type NewDropConfig = {
  shared: NewDropSharedConfig;
  deploy: NewDropDeployConfig;
  onchain: NewDropOnchainConfig;
};

type NewDropConfigInput = {
  shared: NewDropSharedConfig;
  deploy: Omit<NewDropDeployConfig, 'solanaCluster'>;
  onchain: Omit<NewDropOnchainConfig, 'collectionMetadata' | 'coreCollectionRoyaltiesBps' | 'symbol'> & {
    collectionMetadata: Omit<
      NewDropOnchainConfig['collectionMetadata'],
      'symbol' | 'sellerFeeBasisPoints'
    >;
  };
};

const defineNewDropConfig = (config: NewDropConfigInput): NewDropConfig => {
  const { shared, deploy, onchain } = config;
  const solanaCluster: SolanaCluster = shared.isMainnet ? 'mainnet-beta' : 'devnet';

  return {
    shared,
    deploy: {
      ...deploy,
      solanaCluster,
    },
    onchain: {
      ...onchain,
      collectionMetadata: {
        ...onchain.collectionMetadata,
        symbol: shared.dropSymbol,
        sellerFeeBasisPoints: shared.sellerFeeBasisPoints,
      },
      coreCollectionRoyaltiesBps: shared.sellerFeeBasisPoints,
      symbol: shared.dropSymbol,
    },
  };
};

/**
 * Single source of truth for editable deploy + drop metadata.
 * Update this file for each new drop.
 */
export const NEW_DROP: NewDropConfig = defineNewDropConfig({
  shared: {
    isMainnet: false,
    dropSymbol: 'hoodie',
    sellerFeeBasisPoints: 500,
  },
  deploy: {
    solanaRpcUrl: undefined,
    coreCollectionPubkey: undefined,
    // Steady-state drop deploys should reuse the shared program.
    // Set this to false only when intentionally deploying/upgrading the shared program id itself.
    reuseProgramId: true,
  },
  onchain: {
    dropId: 'lsw_cobalt_figure_hoodie_26_devnet_x3',
    dropFamily: 'lsw_cobalt_figure_hoodie',
    metadataBase: 'https://assets.mons.link/drops/hoodie',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 15 },
        { key: 'XL', label: 'XL', startId: 16, endId: 30 },
        { key: '2XL', label: '2XL', startId: 31, endId: 34 },
      ],
    },
    collectionMetadata: {
      name: 'lsw cobalt figure hoodie 26',
      description: 'little swag world hoodie · redeem physical on mons.shop',
      externalUrl: 'https://mons.shop',
      image: 'https://assets.mons.link/drops/hoodie/hoodie.webp',
    },
    discountWhitelistCsvRelativePath: 'scripts/discounts/lsw_hoodie.csv',
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 0,
    },
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 0.069,
    discountPriceSol: 0.042,
    discountMintsPerWallet: 1,
    maxSupply: 34,
    itemsPerBox: 0,
    maxPerTx: 15,
    namePrefix: 'hoodie',
    figureNamePrefix: 'hoodie',
  },
});
