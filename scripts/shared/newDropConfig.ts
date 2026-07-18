import {
  normalizeAndValidateMetadataBaseInput,
  type DropFamily,
  type MintSelectionConfigSerialized,
} from './deploymentRegistry.ts';

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

type NewDropDeployConfig = {
  solanaCluster: SolanaCluster;
  solanaRpcUrl?: string;
  coreCollectionPubkey?: string;
  reuseProgramId: boolean;
  reuseProgramIdFromDropId?: string;
};

export type NewDropOnchainConfig = {
  dropId: string;
  dropFamily: DropFamily;
  // Accept either `https://...`, `ipfs://...`, or a raw IPFS CID like `bafy...`.
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
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
  stripeProductTaxCode?: string;
  discountMintsPerWallet: number;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;
};

type NewDropSharedConfig = {
  isMainnet: boolean;
  dropSymbol: string;
  sellerFeeBasisPoints: number;
};

export type NewDropConfig = {
  shared: NewDropSharedConfig;
  deploy: NewDropDeployConfig;
  onchain: NewDropOnchainConfig;
};

export type NewDropConfigInput = {
  shared: NewDropSharedConfig;
  deploy: Omit<NewDropDeployConfig, 'solanaCluster'>;
  onchain: Omit<NewDropOnchainConfig, 'collectionMetadata' | 'coreCollectionRoyaltiesBps' | 'symbol'> & {
    collectionMetadata: Omit<
      NewDropOnchainConfig['collectionMetadata'],
      'symbol' | 'sellerFeeBasisPoints'
    >;
  };
};

export const defineNewDropConfig = (config: NewDropConfigInput): NewDropConfig => {
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
      metadataBase: normalizeAndValidateMetadataBaseInput(onchain.metadataBase),
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
