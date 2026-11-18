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
  phase: 'scanning' | 'staging' | 'prepared' | 'activating' | 'publishing' | 'observing' | 'complete' | 'cancelled';
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

export function redactOwnerHatchingCursor(cursor: string | null): 'pending' | null {
  if (cursor === null) return null;
  if (typeof cursor !== 'string' || !cursor) throw new Error('Invalid owner hatching verification cursor.');
  return 'pending';
}

export function parseHistoricalOwnerHatchingRequest(value: unknown): OwnerHatchingMaintenanceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid owner hatching history request.');
  const row = value as Record<string, unknown>;
  if (row.action !== 'status' && row.action !== 'verify') throw new Error('Use mixed allocation to prepare or activate eggs.');
  if (Object.keys(row).length !== 4 || typeof row.deploymentId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.deploymentId) ||
    typeof row.batchId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.batchId) ||
    !Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 1) throw new Error('Invalid owner hatching history request.');
  return row as OwnerHatchingMaintenanceRequest;
}
