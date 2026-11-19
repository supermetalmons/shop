import { mixedAllocationHash } from './revealMixedAllocation.ts';
import type { TwinRole } from './twinMetadataTrait.ts';

export type TwinMetadataCohortRow = { tokenId: string; paintingId: number; role: TwinRole; beforeSha256: string; etag: string };
export type TwinMetadataMaintenanceRequest = {
  action: 'inspect' | 'prepare' | 'advance' | 'verify';
  deploymentId: string;
  operationId: string;
  expectedRevision: number;
  cohortSha256: string;
  rows?: TwinMetadataCohortRow[];
  after?: number;
};
export type TwinMetadataMaintenanceResult = {
  operationId: string; cohortSha256: string; phase: 'unstarted' | 'prepared' | 'publishing' | 'complete';
  total: number; good: number; evil: number; groups: number; published: number;
  registryRevision: number; catalogRevision: number; checked: number; next: number | null;
};

const TWIN_METADATA_OPERATION = 'mainnet-revealed-twins-20261119';
function twinMetadataCohortHash(rows: readonly TwinMetadataCohortRow[]): string {
  return mixedAllocationHash(rows.map(row => [row.tokenId, row.paintingId, row.role, row.beforeSha256, row.etag]));
}

export function parseTwinMetadataRequest(value: unknown): TwinMetadataMaintenanceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid twin metadata request.');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(key => !['action','deploymentId','operationId','expectedRevision','cohortSha256','rows','after'].includes(key)) ||
    !['inspect','prepare','advance','verify'].includes(String(r.action)) || r.deploymentId !== 'mainnet-v1' || r.operationId !== TWIN_METADATA_OPERATION ||
    !Number.isSafeInteger(r.expectedRevision) || Number(r.expectedRevision) < 1 || typeof r.cohortSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.cohortSha256) || ('rows' in r) !== (r.action === 'prepare') ||
    ('after' in r && (r.action !== 'verify' || !Number.isSafeInteger(r.after) || Number(r.after) < 0))) throw new Error('Invalid twin metadata scope or arguments.');
  if (r.action === 'prepare') {
    if (!Array.isArray(r.rows) || r.rows.length < 2 || r.rows.length > 628) throw new Error('Invalid twin metadata cohort size.');
    let previous = 0;
    const paintings = new Set<number>();
    for (const row of r.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 5 ||
        typeof row.tokenId !== 'string' || !/^[1-9]\d{0,5}$/.test(row.tokenId) || Number(row.tokenId) <= previous || Number(row.tokenId) > 111111 ||
        !Number.isSafeInteger(row.paintingId) || row.paintingId < 1 || row.paintingId > 111111 || paintings.has(row.paintingId) ||
        !['good twin','evil twin'].includes(row.role) || typeof row.beforeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.beforeSha256) ||
        typeof row.etag !== 'string' || !/^[a-f0-9]{32}$/.test(row.etag)) throw new Error('Invalid sorted twin metadata cohort.');
      previous = Number(row.tokenId);
      paintings.add(row.paintingId);
    }
    if (twinMetadataCohortHash(r.rows) !== r.cohortSha256) throw new Error('Twin metadata cohort checksum changed.');
  }
  return r as TwinMetadataMaintenanceRequest;
}
