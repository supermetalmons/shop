import { ethereumMetadataBaseUri } from './config.ts';
import { normalizeEthereumAddress } from './protocol.ts';
import descriptor from './revealCatalog.json';

export const ETHEREUM_REVEAL_CATALOG_VERSION = descriptor.catalogVersion;
export const ETHEREUM_REVEAL_CATALOG_VERSION_PATTERN = /^111k-v[1-9]\d{0,8}$/;
export const ETHEREUM_REVEAL_DEPLOYMENTS_SQL = 'SELECT * FROM ethereum_reveal_deployments';
export const ETHEREUM_REVEAL_DEPLOYMENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type EthereumRevealDeployment = {
  deploymentId: string;
  dropId: string;
  chainId: number;
  contractAddress: string;
  metadataBaseUri: string;
  deploymentBlock: number;
  catalogVersion: string;
  templateJson: string;
  templateSha256: string;
  state: 'provisioning' | 'ready' | 'active' | 'paused';
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  activatedAtMs: number | null;
  provisionedAtMs: number | null;
  lastError: string | null;
  effectiveCatalogVersion?: string | null;
  effectiveCatalogSha256?: string | null;
  catalogRevision?: number;
  catalogUpdateId?: string | null;
  catalogUpdateStartedAtMs?: number | null;
  retiredAtMs?: number | null;
  replacementDeploymentId?: string | null;
};

type RegistryStatement = {
  bind(...values: unknown[]): RegistryStatement;
  first<T>(): Promise<T | null>;
};
type RegistryDatabase = { prepare(sql: string): RegistryStatement };

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Invalid reveal deployment integer.');
  return value;
}

function timestamp(value: unknown): number | null {
  return value === null ? null : integer(value);
}

export function parseEthereumRevealDeployment(row: Record<string, unknown>): EthereumRevealDeployment {
  const address = normalizeEthereumAddress(row.contract_address);
  if (typeof row.deployment_id !== 'string' || !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(row.deployment_id) ||
    typeof row.drop_id !== 'string' || !/^[a-z0-9_][a-z0-9_-]{0,63}$/.test(row.drop_id) ||
    !address || address !== row.contract_address || /^0x0{40}$/.test(address) ||
    typeof row.metadata_base_uri !== 'string' || typeof row.catalog_version !== 'string' ||
    !ETHEREUM_REVEAL_CATALOG_VERSION_PATTERN.test(row.catalog_version) ||
    typeof row.template_json !== 'string' || typeof row.template_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.template_sha256) ||
    !['provisioning', 'ready', 'active', 'paused'].includes(String(row.state)) ||
    row.last_error !== null && typeof row.last_error !== 'string') throw new Error('Invalid reveal deployment.');
  const chainId = integer(row.chain_id, 1);
  const metadataBaseUri = ethereumMetadataBaseUri(row.metadata_base_uri, chainId);
  const retiredAtMs = row.retired_at_ms == null ? null : integer(row.retired_at_ms, 1);
  const replacementDeploymentId = row.replacement_deployment_id ?? null;
  const effectiveCatalogVersion = row.effective_catalog_version ?? null;
  const effectiveCatalogSha256 = row.effective_catalog_sha256 ?? null;
  const catalogRevision = integer(row.catalog_revision ?? 0);
  const catalogUpdateId = row.catalog_update_id ?? null;
  const catalogUpdateStartedAtMs = row.catalog_update_started_at_ms == null ? null : integer(row.catalog_update_started_at_ms, 1);
  if ((effectiveCatalogVersion === null) !== (effectiveCatalogSha256 === null) ||
    effectiveCatalogVersion !== null && (typeof effectiveCatalogVersion !== 'string' || !ETHEREUM_REVEAL_CATALOG_VERSION_PATTERN.test(effectiveCatalogVersion)) ||
    effectiveCatalogSha256 !== null && (typeof effectiveCatalogSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(effectiveCatalogSha256)) ||
    (catalogUpdateId === null) !== (catalogUpdateStartedAtMs === null) ||
    catalogUpdateId !== null && (typeof catalogUpdateId !== 'string' || !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(catalogUpdateId)) ||
    catalogUpdateId !== null && retiredAtMs !== null ||
    catalogRevision > 0 && effectiveCatalogVersion === null) throw new Error('Invalid reveal catalog update.');
  if ((retiredAtMs === null) !== (replacementDeploymentId === null) ||
    replacementDeploymentId !== null && (typeof replacementDeploymentId !== 'string' ||
      !ETHEREUM_REVEAL_DEPLOYMENT_ID.test(replacementDeploymentId) || replacementDeploymentId === row.deployment_id) ||
    retiredAtMs !== null && (chainId !== 11155111 || row.drop_id !== '111k_devnet' || row.state !== 'paused')) {
    throw new Error('Invalid reveal retirement.');
  }
  const template: unknown = JSON.parse(row.template_json);
  if (!template || typeof template !== 'object' || Array.isArray(template) ||
    !('name' in template) || typeof template.name !== 'string' || !('description' in template) || typeof template.description !== 'string' ||
    !('image' in template) || typeof template.image !== 'string' || !('attributes' in template) || !Array.isArray(template.attributes)) {
    throw new Error('Invalid reveal metadata template.');
  }
  return {
    deploymentId: row.deployment_id, dropId: row.drop_id, chainId, contractAddress: address, metadataBaseUri,
    deploymentBlock: integer(row.deployment_block), catalogVersion: row.catalog_version,
    templateJson: row.template_json, templateSha256: row.template_sha256,
    state: row.state as EthereumRevealDeployment['state'], revision: integer(row.revision, 1),
    createdAtMs: integer(row.created_at_ms), updatedAtMs: integer(row.updated_at_ms),
    activatedAtMs: timestamp(row.activated_at_ms), provisionedAtMs: timestamp(row.provisioned_at_ms), lastError: row.last_error as string | null,
    effectiveCatalogVersion: effectiveCatalogVersion as string | null, effectiveCatalogSha256: effectiveCatalogSha256 as string | null,
    catalogRevision, catalogUpdateId: catalogUpdateId as string | null, catalogUpdateStartedAtMs,
    ...(retiredAtMs !== null ? { retiredAtMs, replacementDeploymentId: replacementDeploymentId as string } : {}),
  };
}

export async function readEthereumRevealDeployment(db: RegistryDatabase, scope: { chainId: number; contractAddress: string }): Promise<EthereumRevealDeployment | null> {
  const address = normalizeEthereumAddress(scope.contractAddress);
  if (!address || !Number.isSafeInteger(scope.chainId) || scope.chainId < 1) throw new Error('Invalid reveal deployment scope.');
  const row = await db.prepare(`${ETHEREUM_REVEAL_DEPLOYMENTS_SQL} WHERE chain_id = ? AND contract_address = ?`)
    .bind(scope.chainId, address).first<Record<string, unknown>>();
  return row ? parseEthereumRevealDeployment(row) : null;
}
