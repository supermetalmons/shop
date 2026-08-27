/**
 * API Worker projection of the canonical deployment registry.
 *
 * Deployment rows live in shared/deploymentRegistry.ts so the frontend and
 * API Worker cannot drift.
 */

import {
  DEPLOYMENT_DROPS,
  type DeploymentRegistryDrop,
} from '../../../../shared/deploymentRegistry.js';
import {
  normalizeDropId as normalizeSharedDropId,
} from '../../../../shared/deploymentCore.js';
import type {
  DropFamily as SharedDropFamily,
  MintSelectionConfig as SharedMintSelectionConfig,
  SolanaCluster as SharedSolanaCluster,
} from '../../../../shared/deploymentCore.js';
import {
  resolveStripeProductTaxCodeForDropFamily,
} from '../../../../shared/stripeCheckoutCore.js';
import {
  projectDeploymentDropCore,
  type DeploymentDropProjectionCore,
} from '../../../../shared/deploymentProjection.js';

export type SolanaCluster = SharedSolanaCluster;
export type DropFamily = SharedDropFamily;
export type MintSelectionConfig = SharedMintSelectionConfig;

export type ApiDropConfig = DeploymentDropProjectionCore & {
  stripeProductTaxCode?: string;
  receiptsTreeMaxDepth?: number;
  receiptsTreeCanopyDepth?: number;
  deliveryLookupTable: string;
};

export type ApiDropsMap = Record<string, ApiDropConfig>;

export const normalizeDropId = normalizeSharedDropId;

function projectApiDrop(
  config: DeploymentRegistryDrop,
): ApiDropConfig {
  const core = projectDeploymentDropCore(config);
  const stripeProductTaxCode =
    resolveStripeProductTaxCodeForDropFamily(
      // Preserve this API projection's truthy coercion. Tooling intentionally
      // keeps the shared helper's nullish-only coercion policy.
      config.stripeProductTaxCode || '',
      core.dropFamily,
      core.stripeCheckoutEnabled === true,
    );

  return {
    ...core,
    ...(config.receiptsTreeMaxDepth != null
      ? { receiptsTreeMaxDepth: config.receiptsTreeMaxDepth }
      : {}),
    ...(config.receiptsTreeCanopyDepth != null
      ? { receiptsTreeCanopyDepth: config.receiptsTreeCanopyDepth }
      : {}),
    deliveryLookupTable: config.deliveryLookupTable,
    ...(stripeProductTaxCode ? { stripeProductTaxCode } : {}),
  };
}

export const API_DROPS: ApiDropsMap = Object.fromEntries(
  Object.entries(DEPLOYMENT_DROPS).map(([dropId, drop]) => [
    dropId,
    projectApiDrop(drop),
  ]),
);

export function getApiDrop(
  dropId: string,
): ApiDropConfig | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return Object.prototype.hasOwnProperty.call(API_DROPS, normalizedDropId)
    ? API_DROPS[normalizedDropId]
    : undefined;
}

export function requireApiDrop(dropId: string): ApiDropConfig {
  const found = getApiDrop(dropId);
  if (!found) throw new Error(`Unknown API dropId: ${dropId}`);
  return found;
}
