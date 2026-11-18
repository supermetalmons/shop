import type { OwnerHatchingMaintenanceRequest, OwnerHatchingMaintenanceResult } from './ownerHatchingMaintenance.ts';

export const MIXED_MAINNET_BATCH_ID = 'mainnet-mixed-20261117';

export type MixedAllocationMaintenanceRequest = Pick<OwnerHatchingMaintenanceRequest, 'deploymentId' | 'batchId' | 'expectedRevision'> & {
  action: OwnerHatchingMaintenanceRequest['action'] | 'cancel';
};

export type MixedAllocationMaintenanceResult = Omit<OwnerHatchingMaintenanceResult, 'phase' | 'verificationCursor'> & {
  phase: OwnerHatchingMaintenanceResult['phase'] | 'unstarted';
  verificationInProgress: boolean;
  verificationPasses: number;
  generationSeeded: number;
  futureCount: number;
  registryRevision: number;
  catalogRevision: number;
  catalogUpdateId: string | null;
  targetVersion: string;
  targetSha256: string;
  sourceSha256: string;
  remainingCleanup?: number;
};

export function parseMixedAllocationMaintenanceRequest(value: unknown): MixedAllocationMaintenanceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid mixed allocation request.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || !['begin','scan','refresh-scan','stage','activate','refresh-activation','status','verify','complete','cancel'].includes(String(row.action)) ||
    row.deploymentId !== 'mainnet-v1' || row.batchId !== MIXED_MAINNET_BATCH_ID || !Number.isSafeInteger(row.expectedRevision) ||
    Number(row.expectedRevision) < 1) throw new Error('Invalid mixed allocation identity or action.');
  return row as MixedAllocationMaintenanceRequest;
}
