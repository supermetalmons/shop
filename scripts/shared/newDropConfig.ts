import {
  normalizeAndValidateMetadataBaseInput,
  type DropFamily,
  type MintSelectionConfigSerialized,
} from './deploymentRegistry.ts';
import {
  normalizeDropSalesMode,
  type DropSalesMode,
} from '../../functions/src/shared/deploymentCore.ts';

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
  displayName?: string;
  salesMode?: DropSalesMode;
  receiptPoolId?: string;
  // Accept either `https://...`, `ipfs://...`, or a raw IPFS CID like `bafy...`.
  metadataBase: string;
  mintSelection?: MintSelectionConfigSerialized;
  collectionMetadata?: {
    name: string;
    symbol: string;
    sellerFeeBasisPoints: number;
    description?: string;
    externalUrl?: string;
    image?: string;
  };
  discountWhitelistCsvRelativePath: string;
  receiptsTree?: {
    maxDepth: number;
    maxBufferSize: number;
    canopyDepth: number;
  };
  coreCollectionRoyaltiesBps?: number;
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
  symbol?: string;
};

type NewDropSharedConfig = {
  isMainnet: boolean;
  dropSymbol?: string;
  sellerFeeBasisPoints?: number;
};

export type NewDropConfig = {
  shared: NewDropSharedConfig;
  deploy: NewDropDeployConfig;
  onchain: NewDropOnchainConfig;
};

type NewDropConfigInputBase = {
  shared: NewDropSharedConfig;
  deploy: Omit<NewDropDeployConfig, 'solanaCluster'>;
  onchain: Omit<
    NewDropOnchainConfig,
    | 'collectionMetadata'
    | 'coreCollectionRoyaltiesBps'
    | 'receiptsTree'
    | 'symbol'
  >;
};

type DedicatedNewDropConfigInput = NewDropConfigInputBase & {
  shared: NewDropSharedConfig & {
    dropSymbol: string;
    sellerFeeBasisPoints: number;
  };
  onchain: NewDropConfigInputBase['onchain'] & {
    receiptPoolId?: undefined;
    collectionMetadata: Omit<
      NonNullable<NewDropOnchainConfig['collectionMetadata']>,
      'symbol' | 'sellerFeeBasisPoints'
    >;
    receiptsTree: NonNullable<NewDropOnchainConfig['receiptsTree']>;
  };
};

type PooledNewDropConfigInput = NewDropConfigInputBase & {
  shared: Omit<
    NewDropSharedConfig,
    'dropSymbol' | 'sellerFeeBasisPoints'
  > & {
    dropSymbol?: never;
    sellerFeeBasisPoints?: never;
  };
  onchain: NewDropConfigInputBase['onchain'] & {
    receiptPoolId: string;
    collectionMetadata?: never;
    receiptsTree?: never;
  };
};

export type NewDropConfigInput =
  | DedicatedNewDropConfigInput
  | PooledNewDropConfigInput;

export const defineNewDropConfig = (config: NewDropConfigInput): NewDropConfig => {
  const { shared, deploy, onchain } = config;
  const solanaCluster: SolanaCluster = shared.isMainnet ? 'mainnet-beta' : 'devnet';
  const receiptPoolId = String(onchain.receiptPoolId || '')
    .trim()
    .toLowerCase();
  let dedicatedResources: Pick<
    NewDropOnchainConfig,
    'collectionMetadata' | 'coreCollectionRoyaltiesBps' | 'receiptsTree'
  > = {};
  if (receiptPoolId) {
    if (
      shared.dropSymbol != null ||
      shared.sellerFeeBasisPoints != null
    ) {
      throw new Error(
        'Pooled drops derive symbol and royalties from the receipt pool spec',
      );
    }
  } else {
    const dropSymbol = String(shared.dropSymbol || '').trim();
    if (!dropSymbol) {
      throw new Error(
        'dropSymbol is required for a dedicated receipt collection',
      );
    }
    const sellerFeeBasisPoints = Number(shared.sellerFeeBasisPoints);
    if (
      !Number.isInteger(sellerFeeBasisPoints) ||
      sellerFeeBasisPoints < 0 ||
      sellerFeeBasisPoints > 10_000
    ) {
      throw new Error(
        'sellerFeeBasisPoints is required for a dedicated receipt collection',
      );
    }
    const dedicated = onchain as DedicatedNewDropConfigInput['onchain'];
    dedicatedResources = {
      collectionMetadata: {
        ...dedicated.collectionMetadata,
        symbol: dropSymbol,
        sellerFeeBasisPoints,
      },
      coreCollectionRoyaltiesBps: sellerFeeBasisPoints,
      receiptsTree: dedicated.receiptsTree,
    };
  }

  return {
    shared,
    deploy: {
      ...deploy,
      solanaCluster,
    },
    onchain: {
      ...onchain,
      ...(String(onchain.displayName || '').trim()
        ? { displayName: String(onchain.displayName).trim() }
        : {}),
      ...(normalizeDropSalesMode(onchain.salesMode) !== 'standard'
        ? { salesMode: normalizeDropSalesMode(onchain.salesMode) }
        : {}),
      ...(String(onchain.receiptPoolId || '').trim()
        ? {
            receiptPoolId,
          }
        : {}),
      metadataBase: normalizeAndValidateMetadataBaseInput(onchain.metadataBase),
      ...dedicatedResources,
      ...(String(shared.dropSymbol || '').trim()
        ? { symbol: String(shared.dropSymbol).trim() }
        : {}),
    } as NewDropOnchainConfig,
  };
};
