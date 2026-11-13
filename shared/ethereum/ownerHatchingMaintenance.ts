export type OwnerHatchingMaintenanceRequest = {
  action: 'begin' | 'scan' | 'refresh-scan' | 'stage' | 'activate' | 'refresh-activation' | 'status' | 'verify' | 'complete';
  deploymentId: string;
  batchId: string;
  expectedRevision: number;
  sourceSha256?: string;
  catalogSha256?: string;
  readyCount?: number;
  grailIds?: number[];
  freshEggIds?: number[];
};

export type OwnerHatchingMaintenanceResult = {
  deploymentId: string;
  batchId: string;
  phase: 'scanning' | 'staging' | 'prepared' | 'activating' | 'publishing' | 'observing' | 'complete';
  readyCount: number;
  grailCount: number;
  candidates: number;
  scanned: number;
  total: number;
  staged: number;
  activationChecked: number;
  activationSelected: number;
  published: number;
  hatched: number;
  retrying: number;
  conflicts: number;
  pendingEnrichment: number;
  failedEnrichment: number;
  retryAfterMs: number;
  verificationCursor: string | null;
  observationUntilMs: number | null;
  complete: boolean;
};

export function parseOwnerHatchingMaintenanceRequest(value: unknown): OwnerHatchingMaintenanceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid owner hatching operation.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['action', 'deploymentId', 'batchId', 'expectedRevision', 'sourceSha256',
    'catalogSha256', 'readyCount', 'grailIds', 'freshEggIds'].includes(key)) ||
    !['begin', 'scan', 'refresh-scan', 'stage', 'activate', 'refresh-activation', 'status', 'verify', 'complete'].includes(String(row.action)) ||
    typeof row.deploymentId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.deploymentId) ||
    typeof row.batchId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.batchId) ||
    !Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 1) throw new Error('Invalid owner hatching operation.');
  if (row.action === 'begin') {
    const ids = (input: unknown): input is number[] => Array.isArray(input) && input.length <= 2_000 &&
      new Set(input).size === input.length && input.every(id => Number.isSafeInteger(id) && id > 0);
    if (typeof row.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceSha256) ||
      typeof row.catalogSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.catalogSha256) ||
      !Number.isSafeInteger(row.readyCount) || Number(row.readyCount) < 1 || Number(row.readyCount) > 2_000 ||
      !ids(row.grailIds) || !row.grailIds.length || !ids(row.freshEggIds) ||
      row.grailIds.length + row.freshEggIds.length !== row.readyCount) throw new Error('Invalid owner hatching batch.');
  } else if (Object.keys(row).some(key => !['action', 'deploymentId', 'batchId', 'expectedRevision'].includes(key))) {
    throw new Error('Owner hatching continuation takes only its frozen operation identity.');
  }
  return row as OwnerHatchingMaintenanceRequest;
}
