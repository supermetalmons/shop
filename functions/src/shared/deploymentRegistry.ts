/**
 * Canonical, committed deployment registry.
 *
 * This is the only source of deployment rows. Frontend and Cloud Functions
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
} from './deploymentCore.js';
import type { SharedMediaMapConfig } from './mediaMap.js';

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
    secondaryMarketHref: 'https://www.tensor.trade/trade/2d2bceeb-51ae-4d2a-a57e-cdb5509d6300',
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
