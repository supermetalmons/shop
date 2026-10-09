/**
 * Canonical, committed deployment registry.
 *
 * This is the only source of deployment rows. Frontend and API
 * configs project their public shapes from this secret-free superset.
 *
 * Secrets must never be added here.
 */

import type {
  DropFamily,
  DropSalesMode,
  MetadataPathFormat,
  MintSelectionConfig,
  SolanaCluster,
} from './deploymentCore.ts';
import type { SharedMediaMapConfig } from './mediaMap.ts';
import type { DropInventoryManifest } from './dropInventoryManifest.ts';
import type { DropOperationsConfig } from './dropConfigRoles.ts';

export type DeploymentMediaMapConfig = SharedMediaMapConfig;

export type PaymentRoutingMintProceedsRecipient = {
  readonly address: string;
  readonly percentage: number;
};

export type PaymentRoutingMintProceeds =
  | readonly [
      PaymentRoutingMintProceedsRecipient,
      PaymentRoutingMintProceedsRecipient,
    ]
  | readonly [
      PaymentRoutingMintProceedsRecipient,
      PaymentRoutingMintProceedsRecipient,
      PaymentRoutingMintProceedsRecipient,
    ];

export type PaymentRoutingConfig = {
  readonly mintProceeds: PaymentRoutingMintProceeds;
  readonly deliveryPaymentReceiver: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58PublicKey(value: string): Uint8Array | undefined {
  let numericValue = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return undefined;
    numericValue = numericValue * 58n + BigInt(digit);
  }
  const decoded: number[] = [];
  while (numericValue > 0n) {
    decoded.push(Number(numericValue & 0xffn));
    numericValue >>= 8n;
  }
  decoded.reverse();
  const leadingZeroes = value.length - value.replace(/^1+/, '').length;
  if (leadingZeroes + decoded.length !== 32) return undefined;
  return Uint8Array.from([
    ...Array.from({ length: leadingZeroes }, () => 0),
    ...decoded,
  ]);
}

function normalizePaymentRoutingAddress(value: unknown, label: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const bytes = trimmed ? decodeBase58PublicKey(trimmed) : undefined;
  if (!bytes) {
    throw new Error(`${label} must be a valid Solana public key`);
  }
  if (bytes.every((byte) => byte === 0)) {
    throw new Error(`${label} must not be the default public key`);
  }
  return trimmed;
}

export function normalizeAndValidatePaymentRouting(
  value: unknown,
  label = 'paymentRouting',
): PaymentRoutingConfig {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unknownField = Object.keys(value).find(
    (field) =>
      field !== 'mintProceeds' && field !== 'deliveryPaymentReceiver',
  );
  if (unknownField) {
    throw new Error(`${label} has unknown field ${unknownField}`);
  }
  if (!Array.isArray(value.mintProceeds)) {
    throw new Error(`${label}.mintProceeds must be an array`);
  }
  if (value.mintProceeds.length < 2 || value.mintProceeds.length > 3) {
    throw new Error(`${label}.mintProceeds must contain 2 or 3 recipients`);
  }
  const seenAddresses = new Set<string>();
  let percentageTotal = 0;
  const mintProceeds = value.mintProceeds.map((recipient, index) => {
    const recipientLabel = `${label}.mintProceeds[${index}]`;
    if (!isPlainRecord(recipient)) {
      throw new Error(`${recipientLabel} must be an object`);
    }
    const unknownRecipientField = Object.keys(recipient).find(
      (field) => field !== 'address' && field !== 'percentage',
    );
    if (unknownRecipientField) {
      throw new Error(
        `${recipientLabel} has unknown field ${unknownRecipientField}`,
      );
    }
    const address = normalizePaymentRoutingAddress(
      recipient.address,
      `${recipientLabel}.address`,
    );
    if (seenAddresses.has(address)) {
      throw new Error(`${label}.mintProceeds addresses must be distinct`);
    }
    seenAddresses.add(address);
    const percentage = recipient.percentage;
    if (
      typeof percentage !== 'number' ||
      !Number.isInteger(percentage) ||
      percentage <= 0 ||
      percentage > 100
    ) {
      throw new Error(
        `${recipientLabel}.percentage must be a positive whole integer`,
      );
    }
    percentageTotal += percentage;
    return { address, percentage };
  });
  if (percentageTotal !== 100) {
    throw new Error(`${label}.mintProceeds percentages must total 100`);
  }
  const deliveryPaymentReceiver = normalizePaymentRoutingAddress(
    value.deliveryPaymentReceiver,
    `${label}.deliveryPaymentReceiver`,
  );
  const normalizedMintProceeds: PaymentRoutingMintProceeds =
    mintProceeds.length === 2
      ? [mintProceeds[0], mintProceeds[1]]
      : [mintProceeds[0], mintProceeds[1], mintProceeds[2]];
  return {
    mintProceeds: normalizedMintProceeds,
    deliveryPaymentReceiver,
  };
}

export function clonePaymentRoutingConfig(
  value: unknown,
  label = 'paymentRouting',
): PaymentRoutingConfig {
  return normalizeAndValidatePaymentRouting(value, label);
}

type DeploymentRegistryDropBase = {
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;
  displayName?: string;
  salesMode?: DropSalesMode;
  receiptPoolId?: string;

  metadataBase: string;
  metadataBaseAliases?: string[];
  metadataPathFormat: MetadataPathFormat;
  secondaryMarketHref?: string;
  figureMedia?: DeploymentMediaMapConfig;
  boxMedia?: DeploymentMediaMapConfig;
  forceSoldOut?: boolean;
  mintSelection?: MintSelectionConfig;

  priceSol: number;
  discountPriceSol: number;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
  stripeProductTaxCode?: string;
  discountMintsPerWallet: number;
  discountMerkleRoot: string;
  maxSupply: number;
  operationsConfig?: DropOperationsConfig;
  inventoryManifest?: DropInventoryManifest;
  receiptMaxId?: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;

  boxMinterProgramId: string;
  boxMinterConfigPda?: string;
  collectionMint: string;
  receiptsMerkleTree: string;
  receiptsTreeMaxDepth?: number;
  receiptsTreeCanopyDepth?: number;
  deliveryLookupTable: string;
};

export type DeploymentRegistryDrop = DeploymentRegistryDropBase &
  (
    | {
        treasury: string;
        paymentRouting?: never;
      }
    | {
        treasury?: never;
        paymentRouting: PaymentRoutingConfig;
      }
  );

export function deploymentTreasuryAlias(
  drop: DeploymentRegistryDrop,
): string {
  if (drop.paymentRouting) return drop.paymentRouting.deliveryPaymentReceiver;
  return drop.treasury;
}

export function projectDeploymentPaymentRouting(
  drop: DeploymentRegistryDrop,
): { treasury: string; paymentRouting?: PaymentRoutingConfig } {
  if (!drop.paymentRouting) return { treasury: drop.treasury };
  const paymentRouting = clonePaymentRoutingConfig(drop.paymentRouting);
  return {
    treasury: paymentRouting.deliveryPaymentReceiver,
    paymentRouting,
  };
}

export type DeploymentRegistryDropFieldSpecs = {
  readonly [Field in keyof DeploymentRegistryDrop]-?: {
    readonly required: {} extends Pick<DeploymentRegistryDrop, Field>
      ? false
      : true;
  };
};

/**
 * Browser-safe runtime description of the canonical row shape.
 *
 * Node-only tooling derives its accepted and required fields from this object,
 * while the mapped type keeps it exhaustive as DeploymentRegistryDrop evolves.
 * Property order matches the canonical source renderer.
 */
export const DEPLOYMENT_REGISTRY_DROP_FIELDS = {
  solanaCluster: { required: true },
  dropId: { required: true },
  dropFamily: { required: true },
  collectionName: { required: true },
  displayName: { required: false },
  salesMode: { required: false },
  receiptPoolId: { required: false },
  metadataBase: { required: true },
  metadataBaseAliases: { required: false },
  metadataPathFormat: { required: true },
  secondaryMarketHref: { required: false },
  figureMedia: { required: false },
  boxMedia: { required: false },
  forceSoldOut: { required: false },
  mintSelection: { required: false },
  treasury: { required: false },
  paymentRouting: { required: false },
  priceSol: { required: true },
  discountPriceSol: { required: true },
  stripeCheckoutEnabled: { required: false },
  stripeLiveUnitAmountCents: { required: false },
  stripeProductTaxCode: { required: false },
  discountMintsPerWallet: { required: true },
  discountMerkleRoot: { required: true },
  maxSupply: { required: true },
  operationsConfig: { required: false },
  inventoryManifest: { required: false },
  receiptMaxId: { required: false },
  itemsPerBox: { required: true },
  maxPerTx: { required: true },
  namePrefix: { required: true },
  figureNamePrefix: { required: true },
  symbol: { required: true },
  boxMinterProgramId: { required: true },
  boxMinterConfigPda: { required: false },
  collectionMint: { required: true },
  receiptsMerkleTree: { required: true },
  receiptsTreeMaxDepth: { required: false },
  receiptsTreeCanopyDepth: { required: false },
  deliveryLookupTable: { required: true },
} as const satisfies DeploymentRegistryDropFieldSpecs;

export type ReceiptPoolDeployment = {
  solanaCluster: SolanaCluster;
  receiptPoolId: string;
  collectionMint: string;
  receiptsMerkleTree: string;
  authority: string;
  collectionMetadataUri: string;
  collectionName: string;
  collectionSymbol: string;
  royaltiesBasisPoints: number;
  royaltiesRecipient: string;
  receiptsTreeMaxDepth: number;
  receiptsTreeMaxBufferSize: number;
  receiptsTreeCanopyDepth: number;
};

export type ReceiptPoolDeploymentsMap = Record<
  string,
  ReceiptPoolDeployment
>;

export type DeploymentDropsMap = Record<string, DeploymentRegistryDrop>;

type BoxMinterConfigTombstoneBase = {
  readonly solanaCluster: SolanaCluster;
  readonly dropId: string;
  readonly dropSeed: string;
  readonly boxMinterProgramId: string;
  readonly boxMinterConfigPda: string;
  readonly collectionMint: string;
  readonly reason: 'historical-orphan' | 'drop-wiped';
};

export type BoxMinterConfigTombstone = BoxMinterConfigTombstoneBase &
  (
    | {
        readonly accountSize: 376;
        readonly schema: 'legacy';
        readonly treasury: string;
        readonly paymentRouting?: never;
      }
    | {
        readonly accountSize: 488;
        readonly schema: 'split-payments-v1';
        readonly treasury?: never;
        readonly paymentRouting: PaymentRoutingConfig;
      }
  );

export type BoxMinterConfigTombstonesMap = Record<
  string,
  BoxMinterConfigTombstone
>;

export const DEPLOYMENT_DROPS: DeploymentDropsMap = {
  card_nft_2: {
    solanaCluster: 'mainnet-beta',
    dropId: 'card_nft_2',
    dropFamily: 'card_nft_2',
    collectionName: 'Card NFT 2',
    metadataBase: 'https://cdn.lil.org/nft/card_nft_2/json',
    metadataBaseAliases: ['https://assets.mons.link/drops/cardnft2/json'],
    metadataPathFormat: 'compact',
    forceSoldOut: true,
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 0.44,
    discountPriceSol: 0.36,
    stripeLiveUnitAmountCents: 4400,
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'a8cdf1ec11dbfacb15e9859d0d1484d95f388d883c012314db51e80e5f8021d3',
    maxSupply: 3711,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: 'cardnft2',
    boxMinterProgramId: '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
    boxMinterConfigPda: '5Wm8XacaTagt9UTdYuGSUmVk87GgMLeyeV5JerzjTNqm',
    collectionMint: 'EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu',
    receiptsMerkleTree: 'EsGrHZjZzHmxzCSrqjyzuBBC4oAq3yS87ZNF1JdvDBh',
    deliveryLookupTable: '27S1HddzYtfhYpwq4QHxnnXAkRt6JFx9Kad9KMnRUpcd',
  },
  card_nft_binder: {
    solanaCluster: 'mainnet-beta',
    dropId: 'card_nft_binder',
    dropFamily: 'card_nft_binder',
    collectionName: 'mons shop receipts',
    displayName: 'Card NFT Binder',
    salesMode: 'stripe_receipt_only',
    receiptPoolId: 'mons_shop_receipts',
    metadataBase: 'https://cdn.lil.org/nft/card_nft_binder/json',
    metadataPathFormat: 'compact',
    forceSoldOut: true,
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 1000000,
    discountPriceSol: 1000000,
    stripeCheckoutEnabled: true,
    stripeLiveUnitAmountCents: 10000,
    stripeProductTaxCode: 'txcd_99999999',
    discountMintsPerWallet: 1,
    discountMerkleRoot: '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
    maxSupply: 15,
    receiptMaxId: 20,
    itemsPerBox: 0,
    maxPerTx: 1,
    namePrefix: 'binder',
    figureNamePrefix: 'binder',
    symbol: 'receipts',
    boxMinterProgramId: '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
    boxMinterConfigPda: '9fd9YF6ZYMZw9ERwdnc798xoUFo584Tmqxc5bWu8j1Bi',
    collectionMint: '57rWZEQFtgsWf846fu9VjA89TkMkbmgbUvmqc8z56WLD',
    receiptsMerkleTree: 'A84bJxATE2V1S3Gsr2VVoqLpitmfAGCXt7BAgLKp5QCF',
    receiptsTreeMaxDepth: 14,
    receiptsTreeCanopyDepth: 8,
    deliveryLookupTable: 'BJFaddrJFYzZ8jJNHwCdb9d9qnESBazDmw6V9xiadP9G',
  },
  card_nft_binder_devnet: {
    solanaCluster: 'devnet',
    dropId: 'card_nft_binder_devnet',
    dropFamily: 'card_nft_binder',
    collectionName: 'mons shop receipts',
    displayName: 'Card NFT Binder',
    salesMode: 'stripe_receipt_only',
    receiptPoolId: 'mons_shop_receipts',
    metadataBase: 'https://cdn.lil.org/nft/card_nft_binder/json',
    metadataPathFormat: 'compact',
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 1000000,
    discountPriceSol: 1000000,
    stripeCheckoutEnabled: true,
    stripeProductTaxCode: 'txcd_99999999',
    discountMintsPerWallet: 1,
    discountMerkleRoot: '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
    maxSupply: 15,
    itemsPerBox: 0,
    maxPerTx: 1,
    namePrefix: 'binder',
    figureNamePrefix: 'binder',
    symbol: 'receipts',
    boxMinterProgramId: '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
    boxMinterConfigPda: 'CziiZZkPYnZuEzPap8SKj3N8KvL1zrdbGPuR9kNd92NT',
    collectionMint: 'CGHkcyW17zzC99rdjcv7sMv1ehH3uKEihgvxXDAmFm9Z',
    receiptsMerkleTree: '5PvWhuvqrtKxYY1LWgKRLTWMmTPGJAuVFKarVwsikcku',
    receiptsTreeMaxDepth: 14,
    receiptsTreeCanopyDepth: 8,
    deliveryLookupTable: '7wmwxQfiChg822oE4RiUzmRdJyEhbdsMQu4UTaNK62tp',
  },
  clear_cards: {
    solanaCluster: 'mainnet-beta',
    dropId: 'clear_cards',
    dropFamily: 'clear_cards',
    collectionName: 'Clear Cards',
    metadataBase: 'https://cdn.lil.org/nft/clear_cards/json',
    metadataPathFormat: 'compact',
    forceSoldOut: true,
    paymentRouting: {
      mintProceeds: [
        { address: 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE', percentage: 70 },
        { address: 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz', percentage: 30 },
      ],
      deliveryPaymentReceiver: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    },
    priceSol: 0.5,
    discountPriceSol: 0.01,
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'b46cf8075518cffa82093f5903c7295659ef0e609b1f20fc3946159625aad91c',
    maxSupply: 192,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: 'clear',
    boxMinterProgramId: '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
    boxMinterConfigPda: '7yqyrPyYvy7uwkWDy7NaSSP14vrmqVqTGWLe26qGhGCK',
    collectionMint: '3fYe95cviaHzka38Q82q64JLhhddKQm37Jt4dQSxPKxz',
    receiptsMerkleTree: '65VeAMmCNL4eNVH93aegjVHtQQyaBtVsn41UvuvdCLKo',
    receiptsTreeMaxDepth: 14,
    receiptsTreeCanopyDepth: 0,
    deliveryLookupTable: 'BqTzDAWiKyCknWmRC1a6sYnufHJA8y3fTQ4i5oFJLeQg',
  },
  clear_cards_devnet_v2: {
    solanaCluster: 'devnet',
    dropId: 'clear_cards_devnet_v2',
    dropFamily: 'clear_cards',
    collectionName: 'Clear Cards',
    metadataBase: 'https://cdn.lil.org/nft/clear_cards/json',
    metadataPathFormat: 'compact',
    treasury: 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE',
    priceSol: 0.069,
    discountPriceSol: 0.01,
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'b46cf8075518cffa82093f5903c7295659ef0e609b1f20fc3946159625aad91c',
    maxSupply: 192,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: 'clear',
    boxMinterProgramId: '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
    boxMinterConfigPda: '2TupdgyHKyDFiRj4oKYAoXoFzK2nxPCZYu3xfL5ZgT7Q',
    collectionMint: '8kWzCNU3GkGjQXbKDQ4p41undzExiSmKAt6uraenqi74',
    receiptsMerkleTree: 'Dx5TpGivZW2B3FNj44Q6rStpoCdMDTztzUVGqjK3irQz',
    receiptsTreeMaxDepth: 14,
    receiptsTreeCanopyDepth: 0,
    deliveryLookupTable: '6hkRkFkksqqfgzdBcJGJhbANcH1THRKqJpkwdAFtzFRM',
  },
  clear_cards_devnet_v3: {
    solanaCluster: 'devnet',
    dropId: 'clear_cards_devnet_v3',
    dropFamily: 'clear_cards',
    collectionName: 'Clear Cards',
    metadataBase: 'https://cdn.lil.org/nft/clear_cards/json',
    metadataPathFormat: 'compact',
    paymentRouting: {
      mintProceeds: [
        { address: 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE', percentage: 70 },
        { address: 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz', percentage: 30 },
      ],
      deliveryPaymentReceiver: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    },
    priceSol: 0.069,
    discountPriceSol: 0.01,
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'b46cf8075518cffa82093f5903c7295659ef0e609b1f20fc3946159625aad91c',
    maxSupply: 192,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: 'clear',
    boxMinterProgramId: '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
    boxMinterConfigPda: 'dWd4jHmVQLKhiKEzqnsdYRee5v5Ud4WGf3RfZb6KJ4j',
    collectionMint: '8idJjHp1PhE1a4UuzaapYFpA9PBuFCbmz2KZMKDMjd1M',
    receiptsMerkleTree: '5zXH3hzqUtzmWVyhug8wz29oSQhyAq57By4nqmdUh6h2',
    receiptsTreeMaxDepth: 14,
    receiptsTreeCanopyDepth: 0,
    deliveryLookupTable: '4YYy2b7u77MMHqrywsu1sSgBfkQ4QdZ6ff4MgMSq7MVR',
  },
  drifella_shirt: {
    solanaCluster: 'mainnet-beta',
    dropId: 'drifella_shirt',
    dropFamily: 'drifella_shirt',
    collectionName: 'Drifella Shirt',
    metadataBase: 'https://cdn.lil.org/nft/drifella_shirt/json',
    metadataPathFormat: 'compact',
    forceSoldOut: true,
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 10 },
        { key: 'XL', label: 'XL', startId: 11, endId: 23 },
        { key: '2XL', label: '2XL', startId: 24, endId: 26 },
      ],
    },
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 1.44,
    discountPriceSol: 1.44,
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'f57ec834ceefb43cdfb28c79ecf907835c55b0b0e6b83031cab1f9952e018d08',
    maxSupply: 26,
    itemsPerBox: 0,
    maxPerTx: 1,
    namePrefix: 'shirt',
    figureNamePrefix: 'shirt',
    symbol: 'shirt',
    boxMinterProgramId: '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
    boxMinterConfigPda: 'FRJeVgAF9sjUgUJD6Da4eRCBSyfzxjoU4wjxStp8RGXG',
    collectionMint: 'BKcqopLrCYefribMaHhKL46jzsTGkzKpem4pAEWac8dE',
    receiptsMerkleTree: 'BQfWzXcA1tBw5brb8ZAJnaMurh46SJzJC4PpNhnapqPq',
    deliveryLookupTable: 'DiSkmukL79B64kshZWETSVNcD2y2GP6dcZ1WfZP4jXqi',
  },
  drifella_shirt_devnet: {
    solanaCluster: 'devnet',
    dropId: 'drifella_shirt_devnet',
    dropFamily: 'drifella_shirt',
    collectionName: 'Drifella Shirt',
    metadataBase: 'https://cdn.lil.org/nft/drifella_shirt/json',
    metadataPathFormat: 'compact',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 10 },
        { key: 'XL', label: 'XL', startId: 11, endId: 23 },
        { key: '2XL', label: '2XL', startId: 24, endId: 26 },
      ],
    },
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 1.44,
    discountPriceSol: 0.069,
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'f57ec834ceefb43cdfb28c79ecf907835c55b0b0e6b83031cab1f9952e018d08',
    maxSupply: 26,
    itemsPerBox: 0,
    maxPerTx: 1,
    namePrefix: 'shirt',
    figureNamePrefix: 'shirt',
    symbol: 'shirt',
    boxMinterProgramId: 'Hr39xMTdeQFPkLb9D6yYxxzTTkfW6QgVyyUETT7jyfZw',
    boxMinterConfigPda: '4BkG2CssMjw6bvTCV7EykbvDRnJD4EqVAw1qJFLweVEz',
    collectionMint: 'RimmxrTuNbpvc129x9kNXJbB7dtDfjq3oKsYSLP8vkf',
    receiptsMerkleTree: 'BDsKJbsAHXjaCoL3kaeDu5M8Cr2PgsSfxVRnJrcKgf1h',
    deliveryLookupTable: '64cNojYRPCgspviUahby2Y6m4Dhba4eneoid1x7VTQhq',
  },
  little_swag_boxes: {
    solanaCluster: 'mainnet-beta',
    dropId: 'little_swag_boxes',
    dropFamily: 'little_swag_boxes',
    collectionName: 'Little Swag Boxes',
    metadataBase: 'https://cdn.lil.org/nft/little_swag_boxes',
    metadataBaseAliases: ['https://assets.mons.link/drops/lsb'],
    metadataPathFormat: 'legacy',
    forceSoldOut: true,
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 1,
    discountPriceSol: 0.55,
    discountMintsPerWallet: 1,
    discountMerkleRoot: '6f1626377cd32663ba24a8b3788eddcddca6feac46a827eee8053e5b0fd5c14c',
    maxSupply: 333,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'box',
    figureNamePrefix: 'figure',
    symbol: 'box',
    boxMinterProgramId: '22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep',
    collectionMint: '7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr',
    receiptsMerkleTree: 'Bep28XBM8LEjdCHgTzhuo5hFazpKrKgxDaEcnRg2VThV',
    deliveryLookupTable: 'F51Mj4JFGdVKJfdbYc4aT4de8Dbst7BmWr2P2Bwxa8Wz',
  },
  little_swag_hoodies: {
    solanaCluster: 'mainnet-beta',
    dropId: 'little_swag_hoodies',
    dropFamily: 'little_swag_hoodies',
    collectionName: 'Little Swag Hoodies',
    metadataBase: 'ipfs://bafybeid5fkhvxxtvajnyeq3brvmepadmqyvmlt7wwifrwfgzzdhurzcmpy',
    metadataPathFormat: 'compact',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 15 },
        { key: 'XL', label: 'XL', startId: 16, endId: 30 },
        { key: '2XL', label: '2XL', startId: 31, endId: 34 },
      ],
    },
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 3,
    discountPriceSol: 2.55,
    stripeCheckoutEnabled: true,
    stripeLiveUnitAmountCents: 21900,
    stripeProductTaxCode: 'txcd_30011000',
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'e35a4009c844dcb102d8f21a5b3c7f38842bf3224006b547e68be0dca9ba1871',
    maxSupply: 34,
    itemsPerBox: 0,
    maxPerTx: 15,
    namePrefix: 'hoodie',
    figureNamePrefix: 'hoodie',
    symbol: 'hoodie',
    boxMinterProgramId: '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU',
    boxMinterConfigPda: '3WSAzs8qN1kQoFM8eSKXAYkHXxZ3UianQDRVbVazb8Hi',
    collectionMint: '5nguer6MR8uY2SQfcQi7r6uVgw24ZXJh1vghZez9pU3o',
    receiptsMerkleTree: 'kjCLigZAjtydLvWYWoXQV7X3cM5widBkDznfZpLtEAE',
    deliveryLookupTable: '2dLo2T2JRZtH1mbSQMMUYjFGx8YrBjEkj668C8fGbou7',
  },
  little_swag_hoodies_devnet: {
    solanaCluster: 'devnet',
    dropId: 'little_swag_hoodies_devnet',
    dropFamily: 'little_swag_hoodies',
    collectionName: 'Little Swag Hoodies',
    metadataBase: 'ipfs://bafybeid5fkhvxxtvajnyeq3brvmepadmqyvmlt7wwifrwfgzzdhurzcmpy',
    metadataPathFormat: 'compact',
    mintSelection: {
      kind: 'size',
      options: [
        { key: 'L', label: 'L', startId: 1, endId: 15 },
        { key: 'XL', label: 'XL', startId: 16, endId: 30 },
        { key: '2XL', label: '2XL', startId: 31, endId: 34 },
      ],
    },
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 0.069,
    discountPriceSol: 0.042,
    stripeCheckoutEnabled: true,
    stripeProductTaxCode: 'txcd_30011000',
    discountMintsPerWallet: 1,
    discountMerkleRoot: 'e35a4009c844dcb102d8f21a5b3c7f38842bf3224006b547e68be0dca9ba1871',
    maxSupply: 34,
    itemsPerBox: 0,
    maxPerTx: 15,
    namePrefix: 'hoodie',
    figureNamePrefix: 'hoodie',
    symbol: 'hoodie',
    boxMinterProgramId: '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
    boxMinterConfigPda: 'J78XFzZ4ZZ4ykYVYofEDPD8yPc5TZxDeDrM7dikwNMZn',
    collectionMint: 'DTDkHsCGJfBAnXqR5YPbsbzegnPSF5FUh4g3ckH5hV3w',
    receiptsMerkleTree: '3JycJA4eKp611yDqCf2ZTAQwRaV7u57WAaMRWLEDd1ak',
    deliveryLookupTable: '6poyGyRRoTy1dY9qC1vo6iXy9yH7ya4SRaBZQgBxPKB6',
  },
  mi_note_cards_devnet: {
    solanaCluster: 'devnet',
    dropId: 'mi_note_cards_devnet',
    dropFamily: 'mi_note_cards',
    collectionName: 'Mi Note Cards',
    metadataBase: 'https://cdn.lil.org/nft/mi_note_cards/json/pre',
    metadataPathFormat: 'compact',
    paymentRouting: {
      mintProceeds: [
        { address: 'BmV4TRHUfMZcaa6iZA4tSGf6ACGoLLsYEHcC55AEKAYf', percentage: 50 },
        { address: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM', percentage: 50 },
      ],
      deliveryPaymentReceiver: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
    },
    priceSol: 0.25,
    discountPriceSol: 0.25,
    discountMintsPerWallet: 1,
    discountMerkleRoot: '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
    maxSupply: 704,
    operationsConfig: {
      configId: 'mi_note_cards_devnet_operations',
      boxMinterConfigPda: 'FdHqdSLxUDenJki3eHXBVf6m49h5nnyM5jNreTHzUS6d',
      maxSupply: 715,
    },
    inventoryManifest: {
      sha256: '198e6c6421cbca20ab3ebec25e7efca07c5fa62072bf8e12dce65e6fbf75242d',
      cardIds: [
        3, 11, 13, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
        33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
        53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72,
        73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92,
        93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112,
        113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132,
        133, 134, 135, 136, 137, 138, 139, 140, 141, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153,
        154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173,
        174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 193, 194,
        195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214,
        215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234,
        235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254,
        255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 270, 271, 272, 273, 274, 275,
        276, 277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295,
        296, 297, 298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315,
        316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326, 327, 328, 329, 330, 331, 332, 333, 334, 335,
        336, 337, 338, 339, 340, 341, 342, 343, 344, 345, 346, 347, 348, 349, 350, 351, 352, 353, 354, 355,
        356, 357, 358, 359, 360, 361, 362, 363, 364, 365, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375,
        376, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386, 387, 388, 389, 390, 391, 392, 393, 394, 395,
        396, 397, 398, 399, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415,
        416, 417, 418, 419, 420, 421, 422, 423, 424, 425, 426, 427, 428, 429, 430, 431, 432, 433, 434, 435,
        436, 437, 438, 439, 440, 441, 442, 443, 444, 445, 446, 447, 448, 449, 450, 451, 452, 453, 454, 455,
        456, 457, 458, 459, 460, 461, 462, 463, 464, 465, 466, 467, 468, 469, 470, 471, 472, 473, 474, 475,
        476, 477, 478, 479, 480, 481, 482, 483, 484, 485, 486, 487, 488, 489, 490, 491, 492, 493, 494, 495,
        496, 497, 498, 499, 500, 501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 511, 512, 513, 514, 515,
        516, 517, 518, 519, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530, 531, 532, 533, 534, 535,
        536, 537, 538, 539, 540, 541, 542, 543, 544, 545, 546, 547, 548, 549, 550, 551, 552, 553, 554, 555,
        556, 557, 558, 559, 560, 561, 562, 563, 564, 565, 566, 567, 568, 569, 570, 571, 572, 573, 574, 575,
        576, 577, 578, 579, 580, 581, 582, 584, 585, 586, 587, 588, 589, 590, 591, 592, 593, 594, 595, 596,
        597, 598, 599, 600, 601, 602, 603, 604, 605, 606, 607, 608, 609, 611, 612, 613, 614, 615, 616, 617,
        618, 619, 620, 621, 622, 623, 624, 625, 626, 627, 628, 629, 630, 631, 632, 633, 634, 635, 636, 637,
        638, 639, 640, 641, 642, 643, 644, 645, 646, 647, 648, 649, 650, 651, 652, 653, 654, 655, 656, 657,
        658, 659, 660, 661, 662, 663, 664, 665, 666, 667, 668, 669, 670, 671, 672, 673, 674, 675, 676, 677,
        678, 679, 680, 681, 682, 683, 684, 685, 686, 687, 688, 689, 690, 691, 692, 693, 694, 695, 696, 697,
        698, 699, 700, 701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 711, 712, 713, 714, 715, 716, 717,
        718, 719, 720, 721, 722, 723, 724, 725, 726, 727, 728, 729, 730, 731, 732, 733, 734, 735, 736, 737,
        738, 739, 740, 741, 742, 743, 744, 745, 746, 747, 748, 749, 750, 751, 752, 753, 754, 755, 756, 757,
        758, 759, 760, 761, 762, 763, 764, 765, 766, 767, 768, 769, 770, 771, 772, 773, 774, 775, 776, 777,
        778, 779, 780, 781, 782, 783, 784, 785, 786, 787, 788, 789, 790, 791, 792, 793, 794, 795, 796, 797,
        798, 799, 800, 801, 802, 803, 804, 805, 806, 807, 808, 809, 810, 811, 812, 813, 814, 815, 816, 817,
        818, 819, 820, 821, 822, 823, 824, 825, 826, 827, 828, 829, 830, 831, 832, 833, 834, 835, 836, 837,
        838, 839, 840, 841, 842, 843, 844, 845, 846, 847, 849, 850, 851, 852, 853, 854, 855, 856, 857, 858,
        859, 860, 861, 862, 863, 864, 865, 866, 867, 868, 869, 870, 871, 872, 873, 874, 875, 876, 877, 878,
        879, 880, 881, 882, 883, 884, 885, 886, 887, 888, 889, 890, 891, 892, 893, 894, 895, 896, 897, 898,
        899, 900, 901, 902, 903, 904, 905, 906, 907, 908, 909, 910, 911, 912, 913, 914, 915, 916, 917, 918,
        919, 920, 921, 922, 923, 924, 925, 926, 927, 928, 929, 930, 931, 932, 933, 934, 935, 936, 937, 938,
        939, 940, 941, 942, 943, 944, 945, 946, 947, 948, 949, 950, 951, 952, 953, 954, 955, 956, 957, 958,
        959, 960, 961, 962, 963, 964, 965, 966, 967, 968, 969, 970, 971, 972, 973, 974, 975, 976, 977, 978,
        979, 980, 981, 982, 983, 984, 985, 986, 987, 988, 989, 990, 991, 992, 993, 994, 995, 996, 997, 998,
        999, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018,
        1019, 1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029, 1030, 1031, 1032, 1033, 1034, 1035, 1036, 1037, 1038,
        1039, 1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047, 1048, 1049, 1050, 1051, 1052, 1053, 1054, 1055, 1056, 1057, 1058,
        1059, 1060, 1061, 1062, 1063, 1064, 1065, 1066, 1067, 1068, 1069, 1070, 1071, 1072, 1073, 1074, 1075, 1076, 1077, 1078,
        1079, 1080, 1081, 1082, 1083, 1084, 1085, 1086, 1087, 1088, 1089, 1090, 1091, 1092, 1093, 1094, 1095, 1096, 1097, 1098,
        1099, 1100, 1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108, 1109, 1110, 1111, 1112, 1113, 1114, 1115, 1116, 1117, 1118,
        1119, 1120, 1121, 1122, 1123, 1124, 1125, 1126, 1127, 1128, 1129, 1130, 1131, 1132, 1133, 1134, 1135, 1136, 1137, 1138,
        1139, 1140, 1141, 1142, 1143, 1144, 1145, 1146, 1147, 1148, 1149, 1150, 1151, 1152, 1153, 1154, 1155, 1156, 1157, 1158,
        1159, 1160, 1161, 1162, 1163, 1164, 1165, 1166, 1167, 1168, 1169, 1170, 1171, 1172, 1173, 1174, 1175, 1176, 1177, 1178,
        1179, 1180, 1181, 1182, 1183, 1184, 1185, 1186, 1187, 1188, 1189, 1190, 1191, 1192, 1193, 1194, 1195, 1196, 1197, 1198,
        1199, 1200, 1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208, 1209, 1210, 1211, 1212, 1213, 1214, 1215, 1216, 1217, 1218,
        1219, 1220, 1221, 1222, 1223, 1224, 1225, 1226, 1227, 1228, 1229, 1230, 1231, 1232, 1233, 1234, 1235, 1236, 1238, 1239,
        1240, 1241, 1242, 1243, 1244, 1245, 1246, 1248, 1249, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258, 1259, 1260,
        1261, 1262, 1263, 1264, 1265, 1266, 1267, 1268, 1269, 1270, 1271, 1272, 1273, 1274, 1275, 1276, 1277, 1278, 1279, 1280,
        1281, 1282, 1283, 1284, 1286, 1287, 1288, 1289, 1290, 1291, 1292, 1293, 1294, 1295, 1296, 1297, 1298, 1299, 1300, 1302,
        1303, 1304, 1305, 1306, 1307, 1308, 1309, 1310, 1311, 1312, 1313, 1314, 1315, 1316, 1317, 1318, 1319, 1320, 1321, 1322,
        1323, 1324, 1325, 1326, 1327, 1328, 1329, 1330, 1331, 1332, 1333, 1334, 1335, 1336, 1337, 1338, 1339, 1340, 1341, 1342,
        1343, 1344, 1345, 1346, 1347, 1348, 1349, 1350, 1351, 1352, 1353, 1354, 1355, 1356, 1357, 1358, 1359, 1360, 1361, 1362,
        1363, 1364, 1365, 1366, 1367, 1368, 1369, 1370, 1371, 1372, 1373, 1374, 1375, 1376, 1377, 1378, 1379, 1380, 1381, 1382,
        1383, 1384, 1385, 1386, 1387, 1388, 1389, 1390, 1391, 1392, 1393, 1394, 1395, 1396, 1397, 1398, 1399, 1400, 1401, 1402,
        1403, 1404, 1405, 1406, 1407, 1408, 1409, 1410, 1411, 1412, 1413, 1414, 1415, 1416, 1417, 1418, 1419, 1420, 1421, 1422,
        1423, 1424, 1425, 1426, 1427, 1428, 1429, 1430,
      ],
    },
    itemsPerBox: 2,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: 'minote',
    boxMinterProgramId: '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
    boxMinterConfigPda: '8Cb6FqM1ymyULJZ6htwJAHH8n4pbMMqMz2yfDLLSicPY',
    collectionMint: '65JF5n29WqB5Z7YsHQXLAPvgsytHRZDixKzqSq2D1RMv',
    receiptsMerkleTree: 'FLHhgXrEEwDWvVkFHPK22cNL3DcZHq1GGxuvkoS2V1rG',
    receiptsTreeMaxDepth: 14,
    receiptsTreeCanopyDepth: 0,
    deliveryLookupTable: '5B1c2Q2kATTJcsGxkWsxvqJjNCU8BvQRRUJj9eKCwGG3',
  },
  poncho_drifella: {
    solanaCluster: 'mainnet-beta',
    dropId: 'poncho_drifella',
    dropFamily: 'poncho_drifella',
    collectionName: 'Poncho Drifella',
    metadataBase: 'https://cdn.lil.org/nft/poncho_drifella',
    metadataBaseAliases: ['https://assets.mons.link/drops/poncho'],
    metadataPathFormat: 'legacy',
    forceSoldOut: true,
    treasury: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    priceSol: 0.69,
    discountPriceSol: 0.42,
    discountMintsPerWallet: 3,
    discountMerkleRoot: '57a899219adfcf52baa508f4093ab40338326957ea322d51efc60b678292727d',
    maxSupply: 207,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: 'pack',
    figureNamePrefix: 'card',
    symbol: 'poncho',
    boxMinterProgramId: 'C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A',
    collectionMint: 'JCTP3kK3xGtWs5mDHxJBuRro38HftaiCDdKsfkXuK2gH',
    receiptsMerkleTree: '5wCjVex6yXCms518RccxmAaVMGoPvTEQcb4UR3MYtQow',
    deliveryLookupTable: '4j1YHm1iwmYDZegY5CxJUYqBcxtpPy7UBkSUfRfz6W8c',
  },
};

export const BOX_MINTER_CONFIG_TOMBSTONES: BoxMinterConfigTombstonesMap = {
  clear_cards_devnet: {
    solanaCluster: 'devnet',
    dropId: 'clear_cards_devnet',
    dropSeed: '0bedb02e16088cdc90077bde942099db106f9e7c2fb64ba8b15af51fd6984bf6',
    boxMinterProgramId: '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6',
    boxMinterConfigPda: 'DPBJSPawzRnSnrPkahbcFGMgYRZafn3dNgetUMQiKorW',
    collectionMint: 'FdcFWHrrjn2yy2Ce7d9ZfgJnrxP7nVzpAUqcJPT3wRJP',
    accountSize: 376,
    schema: 'legacy',
    treasury: 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE',
    reason: 'historical-orphan',
  },
};

export const RECEIPT_POOL_DEPLOYMENTS: ReceiptPoolDeploymentsMap = {
  'devnet:mons_shop_receipts': {
    solanaCluster: 'devnet',
    receiptPoolId: 'mons_shop_receipts',
    collectionMint: 'CGHkcyW17zzC99rdjcv7sMv1ehH3uKEihgvxXDAmFm9Z',
    receiptsMerkleTree: '5PvWhuvqrtKxYY1LWgKRLTWMmTPGJAuVFKarVwsikcku',
    authority: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
    collectionMetadataUri: 'https://cdn.lil.org/nft/mons_shop_receipts/collection.json',
    collectionName: 'mons shop receipts',
    collectionSymbol: 'receipts',
    royaltiesBasisPoints: 500,
    royaltiesRecipient: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    receiptsTreeMaxDepth: 14,
    receiptsTreeMaxBufferSize: 64,
    receiptsTreeCanopyDepth: 8,
  },
  'mainnet-beta:mons_shop_receipts': {
    solanaCluster: 'mainnet-beta',
    receiptPoolId: 'mons_shop_receipts',
    collectionMint: '57rWZEQFtgsWf846fu9VjA89TkMkbmgbUvmqc8z56WLD',
    receiptsMerkleTree: 'A84bJxATE2V1S3Gsr2VVoqLpitmfAGCXt7BAgLKp5QCF',
    authority: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
    collectionMetadataUri: 'https://cdn.lil.org/nft/mons_shop_receipts/collection.json',
    collectionName: 'mons shop receipts',
    collectionSymbol: 'receipts',
    royaltiesBasisPoints: 500,
    royaltiesRecipient: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    receiptsTreeMaxDepth: 14,
    receiptsTreeMaxBufferSize: 64,
    receiptsTreeCanopyDepth: 8,
  },
};

export function receiptPoolDeploymentKey(
  solanaCluster: SolanaCluster,
  receiptPoolId: string,
): string {
  return `${solanaCluster}:${String(receiptPoolId || '').trim().toLowerCase()}`;
}

export function getReceiptPoolDeployment(
  solanaCluster: SolanaCluster,
  receiptPoolId: string,
): ReceiptPoolDeployment | undefined {
  const key = receiptPoolDeploymentKey(solanaCluster, receiptPoolId);
  return Object.prototype.hasOwnProperty.call(RECEIPT_POOL_DEPLOYMENTS, key)
    ? RECEIPT_POOL_DEPLOYMENTS[key]
    : undefined;
}

function assertRegistryKeysMatchDropIds<T extends { dropId: string }>(
  drops: Record<string, T>,
): void {
  Object.entries(drops).forEach(([registryKey, drop]) => {
    if (registryKey !== drop.dropId) {
      throw new Error(`Deployment registry key ${registryKey} does not match embedded dropId ${drop.dropId}.`);
    }
  });
}

function assertSharedProgramDropsUseExplicitConfigPdas(drops: DeploymentDropsMap): void {
  const counts = new Map<string, number>();
  Object.values(drops).forEach((drop) => {
    const key = `${drop.solanaCluster}:${drop.boxMinterProgramId}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  Object.values(drops).forEach((drop) => {
    const key = `${drop.solanaCluster}:${drop.boxMinterProgramId}`;
    if ((counts.get(key) || 0) < 2) return;
    if (String(drop.boxMinterConfigPda || '').trim()) return;
    throw new Error(
      `Deployment registry drop ${drop.dropId} shares program ${drop.boxMinterProgramId} on ${drop.solanaCluster} and must set boxMinterConfigPda.`,
    );
  });
}

assertRegistryKeysMatchDropIds(DEPLOYMENT_DROPS);
assertSharedProgramDropsUseExplicitConfigPdas(DEPLOYMENT_DROPS);
assertRegistryKeysMatchDropIds(BOX_MINTER_CONFIG_TOMBSTONES);
Object.keys(BOX_MINTER_CONFIG_TOMBSTONES).forEach((dropId) => {
  if (Object.prototype.hasOwnProperty.call(DEPLOYMENT_DROPS, dropId)) {
    throw new Error(`Deployment registry drop ${dropId} cannot also be tombstoned.`);
  }
});

export function getDeploymentDrop(dropId: string): DeploymentRegistryDrop | undefined {
  const normalizedDropId = String(dropId || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DEPLOYMENT_DROPS, normalizedDropId)
    ? DEPLOYMENT_DROPS[normalizedDropId]
    : undefined;
}
