import { ethereumItemDisplayIdMaximum } from './protocol.ts';
import type { RevealCatalogUpdateBatch } from './revealCatalogUpdate.ts';
import type { EthereumArtworkCategory } from './reveal.ts';

export type EthereumRevealEmptyPoolRequest = EthereumRevealMaintenanceRequest & {
  operationId: string;
  action: 'inspect' | 'begin' | 'advance' | 'verify' | 'cancel';
  batch?: RevealCatalogUpdateBatch;
};

export type EthereumRevealEmptyPoolResult = {
  deploymentId: string;
  operationId: string;
  phase: 'unstarted' | 'fencing' | 'staging' | 'activating' | 'observing' | 'complete' | 'cancelled';
  complete: boolean;
  catalogRevision: number;
  seeded: number;
  total: number;
  fenceActive: boolean;
  retryAfterMs: number;
  observationUntilMs?: number;
  emptyCounts?: Record<string, number>;
};

export type EthereumRevealCatalogUpdateRequest = EthereumRevealMaintenanceRequest & {
  batchId: string;
  action: 'inspect' | 'begin' | 'advance' | 'verify' | 'cancel';
  batch?: RevealCatalogUpdateBatch;
  verificationAfterEggId?: number;
  eggCutoff?: number;
  afterEggId?: number;
};

export type EthereumRevealCatalogUpdateResult = {
  deploymentId: string;
  batchId: string;
  phase: 'unstarted' | 'staging' | 'validating' | 'activating' | 'publishing' | 'verifying' | 'observing' | 'complete' | 'cancelled';
  complete: boolean;
  catalogRevision: number;
  total: number;
  staged: number;
  applied: number;
  published: number;
  frozen: number;
  conflicts?: number;
  retrying?: number;
  retryAfterMs: number;
  nextVerificationEggId?: number | null;
  eligibleEggIds?: number[];
  nextEligibleEggId?: number | null;
  refreshTransaction?: { chainId: number; to: string; data: string; value: '0x0' };
};

export function isRevealArtworkTokenId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,5}$/.test(value) && Number(value) <= ethereumItemDisplayIdMaximum('artwork');
}

export type EthereumRevealMaintenanceRequest = {
  deploymentId: string;
  expectedRevision: number;
};

export type EthereumRevealAttributeBackfillRequest = EthereumRevealMaintenanceRequest & {
  afterTokenId: string | null;
  write: boolean;
  retryBlocked?: boolean;
  recheckTokenId?: string;
  audit?: boolean;
  frozenThroughMs?: number;
};

export type EthereumRevealAttributeAuditToken = {
  tokenId: string;
  category: EthereumArtworkCategory;
  assetId: number;
  assignmentRevision: number;
  metadataRevision: number;
  metadataSha256: string;
  frozenMetadataSha256: string;
  nonAttributeSha256: string;
  collectionBlock: string | null;
  enrichment: {
    status: 'pending' | 'published' | 'invalid' | 'conflict';
    assignmentRevision: number;
    attempts: number;
    lastError: string | null;
    targetSha256: string | null;
    checksumValid: boolean | null;
  } | null;
};

export type EthereumRevealAttributeBackfillPage = {
  nextCursor: string | null;
  eligible: number;
  missing: number;
  invalid: number;
  conflict: number;
  conflictRechecks: number;
  enqueued: number;
  requeued: number;
  frozenThroughMs?: number;
  tokens?: EthereumRevealAttributeAuditToken[];
};

export type EthereumRevealInspection = {
  deploymentId: string;
  chainId: number;
  contractAddress: string;
  metadataBaseUri: string;
  revision: number;
  storageEmpty: boolean;
  alarmCleared: boolean;
};

export type EthereumRevealPurgeResult = EthereumRevealInspection & {
  purged: true;
  storageEmpty: true;
  alarmCleared: true;
};

export type EthereumRevealRetirementRequest = EthereumRevealMaintenanceRequest & {
  replacementDeploymentId: string;
  expectedReplacementRevision: number;
};

export type EthereumRevealRetirementResult = Omit<EthereumRevealInspection, 'storageEmpty' | 'alarmCleared'> & {
  retiredAtMs: number;
  replacementDeploymentId: string;
  replacementRevision: number;
  quiesced: true;
};

export type EthereumRevealRetirementCancellation = {
  deploymentId: string;
  replacementDeploymentId: string;
  revision: number;
  cancelled: boolean;
  retired: boolean;
};

export type EthereumRevealReplacementRequest = EthereumRevealMaintenanceRequest & {
  frozenThroughMs?: number;
};

export type EthereumRevealReplacementInspection = Omit<EthereumRevealInspection, 'storageEmpty' | 'alarmCleared'> & {
  ready: true;
  frozenThroughMs: number;
  frozenArtworks: number;
  frozenMetadataSha256: string;
  frozenSamples: Array<{ tokenId: string; metadataSha256: string;
    enrichment?: { version: 'v0'; sha256: string; published: boolean } }>;
};
