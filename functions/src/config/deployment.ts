/**
 * Cloud Functions projection of the canonical deployment registry.
 *
 * Deployment rows live in ../shared/deploymentRegistry.ts so the frontend and
 * Cloud Functions cannot drift.
 */

import {
  DEPLOYMENT_DROPS,
  projectDeploymentPaymentRouting,
  type DeploymentRegistryDrop,
  type PaymentRoutingConfig,
} from '../shared/deploymentRegistry.js';
import {
  canonicalizeDropAssetUrl as canonicalizeSharedDropAssetUrl,
  defaultDropFamilyForDropId as defaultSharedDropFamilyForDropId,
  normalizeDiscountMintsPerWallet,
  normalizeDropBase as normalizeSharedDropBase,
  normalizeDropFamily as normalizeSharedDropFamily,
  normalizeDropId as normalizeSharedDropId,
  normalizeDropSalesMode,
  normalizeMetadataPathFormat,
  normalizeMetadataBaseAliases,
  normalizeMintSelectionConfig,
} from '../shared/deploymentCore.js';
import type {
  DropFamily as SharedDropFamily,
  DropSalesMode,
  MintSelectionConfig as SharedMintSelectionConfig,
  SolanaCluster as SharedSolanaCluster,
} from '../shared/deploymentCore.js';
import {
  assertStripeLivePriceConfigured,
  resolveStripeCheckoutEnabledForDropFamily,
  resolveStripeProductTaxCodeForDropFamily,
} from '../shared/stripeCheckoutCore.js';

export type SolanaCluster = SharedSolanaCluster;
export type DropFamily = SharedDropFamily;
export type MintSelectionConfig = SharedMintSelectionConfig;

export type FunctionsDropConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;
  displayName?: string;
  salesMode?: DropSalesMode;
  receiptPoolId?: string;
  metadataBase: string;
  metadataBaseAliases?: string[];
  metadataPathFormat: 'legacy' | 'compact';
  mintSelection?: MintSelectionConfig;
  treasury: string;
  paymentRouting?: PaymentRoutingConfig;
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

export type FunctionsDropsMap = Record<string, FunctionsDropConfig>;

export const normalizeDropBase = normalizeSharedDropBase;
export const canonicalizeDropAssetUrl = canonicalizeSharedDropAssetUrl;
export const normalizeDropId = normalizeSharedDropId;
export const defaultDropFamilyForDropId = defaultSharedDropFamilyForDropId;
export const normalizeDropFamily = normalizeSharedDropFamily;

function projectFunctionsDrop(
  config: DeploymentRegistryDrop,
): FunctionsDropConfig {
  const dropId = normalizeDropId(config.dropId);
  const dropFamily = normalizeDropFamily(config.dropFamily, dropId);
  const metadataPathFormat = normalizeMetadataPathFormat(
    config.metadataPathFormat,
  );
  const metadataBase = normalizeDropBase(config.metadataBase);
  const metadataBaseAliases = normalizeMetadataBaseAliases(
    metadataBase,
    config.metadataBaseAliases,
  );
  const mintSelection = normalizeMintSelectionConfig(config.mintSelection);
  const boxMinterConfigPda = String(config.boxMinterConfigPda || '').trim();
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
  const stripeProductTaxCode =
    resolveStripeProductTaxCodeForDropFamily(
      // Preserve this facade's legacy truthy coercion. Tooling intentionally
      // keeps the shared helper's nullish-only coercion policy.
      config.stripeProductTaxCode || '',
      dropFamily,
      stripeCheckout.enabled,
    );

  return {
    solanaCluster: config.solanaCluster,
    dropId,
    dropFamily,
    collectionName: config.collectionName,
    ...(String(config.displayName || '').trim()
      ? { displayName: String(config.displayName).trim() }
      : {}),
    ...(normalizeDropSalesMode(config.salesMode) !== 'standard'
      ? { salesMode: normalizeDropSalesMode(config.salesMode) }
      : {}),
    ...(String(config.receiptPoolId || '').trim()
      ? { receiptPoolId: String(config.receiptPoolId).trim() }
      : {}),
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
    figureNamePrefix: String(config.figureNamePrefix || '').trim() || 'figure',
    symbol: config.symbol,
    boxMinterProgramId: config.boxMinterProgramId,
    ...(boxMinterConfigPda ? { boxMinterConfigPda } : {}),
    collectionMint: config.collectionMint,
    receiptsMerkleTree: config.receiptsMerkleTree,
    ...(config.receiptsTreeMaxDepth != null
      ? { receiptsTreeMaxDepth: config.receiptsTreeMaxDepth }
      : {}),
    ...(config.receiptsTreeCanopyDepth != null
      ? { receiptsTreeCanopyDepth: config.receiptsTreeCanopyDepth }
      : {}),
    deliveryLookupTable: config.deliveryLookupTable,
    ...(stripeCheckout.enabled
      ? { stripeCheckoutEnabled: true }
      : stripeCheckout.disabledOverride
        ? { stripeCheckoutEnabled: false }
        : {}),
    ...(stripeProductTaxCode ? { stripeProductTaxCode } : {}),
  };
}

export const FUNCTIONS_DROPS: FunctionsDropsMap = Object.fromEntries(
  Object.entries(DEPLOYMENT_DROPS).map(([dropId, drop]) => [
    dropId,
    projectFunctionsDrop(drop),
  ]),
);

export function getFunctionsDrop(
  dropId: string,
): FunctionsDropConfig | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return Object.prototype.hasOwnProperty.call(FUNCTIONS_DROPS, normalizedDropId)
    ? FUNCTIONS_DROPS[normalizedDropId]
    : undefined;
}

export function requireFunctionsDrop(dropId: string): FunctionsDropConfig {
  const found = getFunctionsDrop(dropId);
  if (!found) throw new Error(`Unknown functions dropId: ${dropId}`);
  return found;
}
