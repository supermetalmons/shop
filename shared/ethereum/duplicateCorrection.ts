import type { EthereumRevealDeployment } from './revealDeployment.ts';
import type { DuplicateCorrectionLedgerResult } from './duplicateCorrectionLedger.ts';

export type DuplicateCorrectionDefinition = {
  version: 1;
  operationId: string;
  deploymentId: string;
  chainId: number;
  contractAddress: string;
  metadataBaseUri: string;
  deploymentBlock: number;
  originCatalogVersion: string;
  catalogVersion: string;
  manifestSha256: string;
  groups: readonly (readonly number[])[];
  eggCandidates: readonly number[];
};

export type DuplicateCorrectionRequest = {
  action: 'inspect' | 'apply' | 'verify';
  deploymentId: string;
  operationId: string;
  definitionSha256: string;
  expectedRevision: number;
  sourceCatalogRevision: number;
};

export type DuplicateCorrectionPhase = 'unstarted' | 'claimed' | 'mirrored' | 'complete';

export type DuplicateCorrectionResult = {
  deploymentId: string;
  operationId: string;
  definitionSha256: string;
  expectedRevision: number;
  sourceCatalogRevision: number;
  registryRevision: number;
  catalogRevision: number;
  phase: DuplicateCorrectionPhase;
  ledger: DuplicateCorrectionLedgerResult;
};

export function parseDuplicateCorrectionRequest(value: unknown, definition: DuplicateCorrectionDefinition, digest: string): DuplicateCorrectionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid duplicate correction request.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 6 || !['inspect','apply','verify'].includes(String(row.action)) ||
    row.deploymentId !== definition.deploymentId || row.operationId !== definition.operationId ||
    !/^[0-9a-f]{64}$/.test(digest) || row.definitionSha256 !== digest ||
    !Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 1 ||
    !Number.isSafeInteger(row.sourceCatalogRevision) || Number(row.sourceCatalogRevision) < 0) {
    throw new Error('Incorrect duplicate correction request identity, action, or revision.');
  }
  return row as DuplicateCorrectionRequest;
}

export function requireDuplicateCorrectionScope(row: EthereumRevealDeployment | null | undefined, d: DuplicateCorrectionDefinition): asserts row is EthereumRevealDeployment {
  if (d.chainId !== 1 || !row || row.chainId !== 1 || row.deploymentId !== d.deploymentId || row.dropId !== '111k' ||
    row.contractAddress !== d.contractAddress || row.metadataBaseUri !== d.metadataBaseUri || row.deploymentBlock !== d.deploymentBlock ||
    row.catalogVersion !== d.originCatalogVersion || row.state !== 'active' || !row.provisionedAtMs || row.retiredAtMs != null ||
    row.lastError !== null || !Number.isSafeInteger(row.catalogRevision)) throw new Error('Mainnet duplicate correction deployment identity or readiness changed.');
}

export function duplicateCorrectionRegistryPhase(row: EthereumRevealDeployment, d: DuplicateCorrectionDefinition, request: DuplicateCorrectionRequest): DuplicateCorrectionPhase {
  requireDuplicateCorrectionScope(row, d);
  const step = row.revision - request.expectedRevision, pointer = row.catalogUpdateId;
  const catalog = row.effectiveCatalogVersion === d.catalogVersion && row.effectiveCatalogSha256 === d.manifestSha256;
  const source = row.catalogRevision === request.sourceCatalogRevision;
  const target = row.catalogRevision === request.sourceCatalogRevision + 1;
  if (step === 0 && pointer == null && source && catalog) return 'unstarted';
  if (step === 1 && pointer === d.operationId && source && catalog) return 'claimed';
  if (step === 2 && pointer === d.operationId && target && catalog) return 'mirrored';
  if (step >= 3 && pointer !== d.operationId && (target && catalog || row.catalogRevision! > request.sourceCatalogRevision + 1)) return 'complete';
  throw new Error('Correction registry owner, catalog or revision changed. Inspect with the original journal.');
}
