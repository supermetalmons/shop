import {
  projectDeploymentPaymentRouting,
  type DeploymentRegistryDrop,
  type PaymentRoutingConfig,
} from './deploymentRegistry.ts';
import {
  normalizeDiscountMintsPerWallet,
  normalizeDropBase,
  normalizeDropFamily,
  normalizeDropId,
  normalizeDropSalesMode,
  normalizeMetadataBaseAliases,
  normalizeMetadataPathFormat,
  normalizeMintSelectionConfig,
  type DropFamily,
  type DropSalesMode,
  type MetadataPathFormat,
  type MintSelectionConfig,
  type SolanaCluster,
} from './deploymentCore.ts';
import {
  assertStripeLivePriceConfigured,
  resolveStripeCheckoutEnabledForDropFamily,
} from './stripeCheckoutCore.ts';

export type DeploymentDropProjectionCore = {
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
  mintSelection?: MintSelectionConfig;
  treasury: string;
  paymentRouting?: PaymentRoutingConfig;
  priceSol: number;
  discountPriceSol: number;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
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
};

function normalizeOptionalString(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed || undefined;
}

export function projectDeploymentDropCore(
  config: DeploymentRegistryDrop,
): DeploymentDropProjectionCore {
  const dropId = normalizeDropId(config.dropId);
  const dropFamily = normalizeDropFamily(config.dropFamily, dropId);
  const metadataBase = normalizeDropBase(config.metadataBase);
  const metadataBaseAliases = normalizeMetadataBaseAliases(
    metadataBase,
    config.metadataBaseAliases,
  );
  const metadataPathFormat = normalizeMetadataPathFormat(
    config.metadataPathFormat,
  );
  const mintSelection = normalizeMintSelectionConfig(config.mintSelection);
  const displayName = normalizeOptionalString(config.displayName);
  const receiptPoolId = normalizeOptionalString(config.receiptPoolId);
  const boxMinterConfigPda = normalizeOptionalString(config.boxMinterConfigPda);
  const salesMode = normalizeDropSalesMode(config.salesMode);
  const stripeCheckout = resolveStripeCheckoutEnabledForDropFamily(
    config.stripeCheckoutEnabled,
    dropFamily,
  );
  assertStripeLivePriceConfigured({
    dropId,
    solanaCluster: config.solanaCluster,
    stripeCheckoutEnabled: stripeCheckout.enabled,
    stripeLiveUnitAmountCents: config.stripeLiveUnitAmountCents,
  });

  return {
    solanaCluster: config.solanaCluster,
    dropId,
    dropFamily,
    collectionName: config.collectionName,
    ...(displayName ? { displayName } : {}),
    ...(salesMode !== 'standard' ? { salesMode } : {}),
    ...(receiptPoolId ? { receiptPoolId } : {}),
    metadataBase,
    ...(metadataBaseAliases.length ? { metadataBaseAliases } : {}),
    metadataPathFormat,
    ...(mintSelection ? { mintSelection } : {}),
    ...projectDeploymentPaymentRouting(config),
    priceSol: config.priceSol,
    discountPriceSol: config.discountPriceSol,
    ...(config.stripeLiveUnitAmountCents != null
      ? { stripeLiveUnitAmountCents: config.stripeLiveUnitAmountCents }
      : {}),
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(
      config.discountMintsPerWallet,
    ),
    discountMerkleRoot: config.discountMerkleRoot,
    maxSupply: config.maxSupply,
    ...(config.receiptMaxId != null
      ? { receiptMaxId: config.receiptMaxId }
      : {}),
    itemsPerBox: config.itemsPerBox,
    maxPerTx: config.maxPerTx,
    namePrefix: config.namePrefix,
    figureNamePrefix: normalizeOptionalString(config.figureNamePrefix) || 'figure',
    symbol: config.symbol,
    boxMinterProgramId: config.boxMinterProgramId,
    ...(boxMinterConfigPda ? { boxMinterConfigPda } : {}),
    collectionMint: config.collectionMint,
    receiptsMerkleTree: config.receiptsMerkleTree,
    ...(stripeCheckout.enabled
      ? { stripeCheckoutEnabled: true }
      : stripeCheckout.disabledOverride
        ? { stripeCheckoutEnabled: false }
        : {}),
  };
}
