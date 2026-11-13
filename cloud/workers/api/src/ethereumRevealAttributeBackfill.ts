import { createHash } from 'node:crypto';
import type { EthereumRevealAttributeAuditToken, EthereumRevealAttributeBackfillPage, EthereumRevealAttributeBackfillRequest } from '../../../../shared/ethereum/revealMaintenance.js';
import { REVEAL_ENRICHMENT_VERSION } from '../../../../shared/ethereum/reveal.js';
import { getOwnerHatchingGrail } from '../../../../shared/ethereum/ownerHatchingCatalog.js';
import { lookupRevealCollectionBlock } from '../../../../shared/ethereum/revealCollectionBlocks.js';
import type { RevealSql } from './ethereumRevealStore.js';
import { acknowledgedEnrichmentHash, matchesEnrichmentChecksum } from './ethereumRevealEnrichmentStore.js';
import { EthereumRevealCatalogUpdateStore } from './ethereumRevealCatalogUpdateStore.js';
import { revealCollectionBlocks } from './ethereumRevealCollectionBlocks.js';
import { parseMetadataJson } from './ethereumMetadataJson.js';

const PAGE_SIZE = 256;
const hash = (json: string) => createHash('sha256').update(json).digest('hex');

function assignmentRevision(sql: RevealSql, table: string, alias: string): string {
  return sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some(column => column.name === 'assignment_revision')
    ? `${alias}.assignment_revision` : '0';
}

function ownerOverrideGuard(sql: RevealSql): string {
  return sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='owner_hatching_slot_overrides'").toArray().length
    ? 'AND NOT EXISTS(SELECT 1 FROM owner_hatching_slot_overrides o WHERE o.origin_category=a.category AND o.origin_asset_id=a.asset_id)' : '';
}

function auditRevealAttributePage(sql: RevealSql, afterTokenId: string | null, frozenThroughMs: number): EthereumRevealAttributeBackfillPage {
  const hasJobs = sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_enrichment'").toArray().length > 0;
  const actualRevision = assignmentRevision(sql, 'assignments', 'a');
  const jobRevision = hasJobs ? assignmentRevision(sql, 'reveal_enrichment', 'e') : '0';
  type AuditRow = { token_id: string; eligible: number; job_status: NonNullable<EthereumRevealAttributeAuditToken['enrichment']>['status'] | null;
    last_error: string | null; attempts: number; assignment_revision: number; target_sha256: string | null };
  const rows = sql.exec<AuditRow>(`WITH page AS MATERIALIZED (
      SELECT p.token_id FROM publication p JOIN assignments a ON a.token_id=p.token_id
      WHERE p.token_id>? AND p.status='published' AND a.frozen_at_ms<=? ORDER BY p.token_id LIMIT ?
    ) SELECT page.token_id,(a.category!='egg' ${ownerOverrideGuard(sql)}) AS eligible,
      ${hasJobs ? `e.status AS job_status,e.last_error,e.attempts,${jobRevision} AS assignment_revision,e.target_sha256`
        : 'NULL AS job_status,NULL AS last_error,0 AS attempts,0 AS assignment_revision,NULL AS target_sha256'}
    FROM page JOIN assignments a ON a.token_id=page.token_id
    ${hasJobs ? `LEFT JOIN reveal_enrichment e ON e.token_id=page.token_id AND e.version=? AND ${jobRevision}=${actualRevision}` : ''}
    ORDER BY page.token_id`, afterTokenId ?? '', frozenThroughMs, PAGE_SIZE, ...(hasJobs ? [REVEAL_ENRICHMENT_VERSION] : [])).toArray();
  const catalogs = new EthereumRevealCatalogUpdateStore(sql, action => action());
  const blocks = revealCollectionBlocks(catalogs.effectiveCatalog());
  const tokens = rows.map(row => {
    const current = catalogs.canonicalMetadata([row.token_id])[0];
    if (!current) throw new Error('Published artwork is missing canonical metadata.');
    const frozen = sql.exec<{ metadata_json: string }>('SELECT metadata_json FROM assignments WHERE token_id=?', row.token_id).toArray()[0];
    if (!frozen) throw new Error('Published artwork is missing frozen metadata.');
    const { attributes: _attributes, ...metadata } = parseMetadataJson(current.metadataJson) as Record<string, unknown>;
    let enrichment: EthereumRevealAttributeAuditToken['enrichment'] = null;
    if (row.eligible && row.job_status !== null && row.assignment_revision === current.assignmentRevision) {
      const target = sql.exec<{ target_json: string | null }>('SELECT target_json FROM reveal_enrichment WHERE token_id=? AND version=?',
        row.token_id, REVEAL_ENRICHMENT_VERSION).toArray()[0];
      if (!target) throw new Error('Published artwork enrichment changed during audit.');
      enrichment = { status: row.job_status, assignmentRevision: row.assignment_revision,
        attempts: row.attempts, lastError: row.last_error, targetSha256: row.target_sha256,
        checksumValid: target.target_json === null && row.target_sha256 === null ? null : matchesEnrichmentChecksum(target.target_json, row.target_sha256,
          acknowledgedEnrichmentHash(sql, row.token_id, REVEAL_ENRICHMENT_VERSION, row.assignment_revision)) };
    }
    return { tokenId: row.token_id, category: current.category, assetId: current.assetId,
      assignmentRevision: current.assignmentRevision, metadataRevision: current.metadataRevision,
      metadataSha256: current.targetSha256, frozenMetadataSha256: hash(frozen.metadata_json), nonAttributeSha256: hash(JSON.stringify(metadata)),
      collectionBlock: getOwnerHatchingGrail(current.category, current.assetId)?.collectionBlock
        ?? lookupRevealCollectionBlock(blocks, current.category, current.assetId),
      enrichment };
  });
  const eligible = rows.filter(row => row.eligible);
  return { nextCursor: rows.length === PAGE_SIZE ? rows[rows.length - 1].token_id : null, eligible: eligible.length,
    missing: eligible.filter(row => row.job_status === null).length, invalid: eligible.filter(row => row.job_status === 'invalid').length,
    conflict: eligible.filter(row => row.job_status === 'conflict').length,
    conflictRechecks: eligible.filter(row => row.last_error === 'conflict-recheck').length, enqueued: 0, requeued: 0,
    frozenThroughMs, tokens };
}

function recheckPublishedToken(sql: RevealSql, tokenId: string, write: boolean, hasJobs: boolean): EthereumRevealAttributeBackfillPage {
  const page = { eligible: 0, missing: 0, invalid: 0, conflict: 0, conflictRechecks: 0, enqueued: 0, requeued: 0, nextCursor: null };
  if (!hasJobs) return page;
  const version = REVEAL_ENRICHMENT_VERSION;
  const actualRevision = assignmentRevision(sql, 'assignments', 'a');
  const jobRevision = assignmentRevision(sql, 'reveal_enrichment', 'e');
  const ownerGuard = ownerOverrideGuard(sql);
  const job = sql.exec<{ status: string; target_json: string | null; target_sha256: string | null; last_error: string | null; assignment_revision: number }>(
    `SELECT e.status,e.target_json,e.target_sha256,e.last_error,${jobRevision} AS assignment_revision FROM reveal_enrichment e
     JOIN publication p ON p.token_id=e.token_id JOIN assignments a ON a.token_id=e.token_id
     WHERE e.token_id=? AND e.version=? AND p.status='published' AND a.category!='egg' AND ${jobRevision}=${actualRevision}
       ${ownerGuard}`, tokenId, version).toArray()[0];
  if (!job) return page;
  const acknowledged = acknowledgedEnrichmentHash(sql, tokenId, version, job.assignment_revision);
  if (job.status !== 'published' && !acknowledged) return page;
  page.eligible = 1;
  if (!matchesEnrichmentChecksum(job.target_json, job.target_sha256, acknowledged)) {
    if (!write) throw new Error('Invalid acknowledged enrichment checksum.');
    sql.exec(`UPDATE reveal_enrichment SET status='conflict',last_error='conflict',claim_id=NULL,next_check_ms=0
      WHERE token_id=? AND version=?`, tokenId, version);
    page.conflict = 1;
    return page;
  }
  page.conflict = Number(job.status === 'conflict');
  page.conflictRechecks = Number(job.last_error === 'conflict-recheck');
  if (write && job.status !== 'pending') {
    sql.exec(`INSERT INTO reveal_enrichment_acknowledgments(token_id,version,target_sha256,assignment_revision) VALUES(?,?,?,?)
      ON CONFLICT(token_id,version) DO NOTHING`, tokenId, version, job.target_sha256, job.assignment_revision);
    page.requeued = sql.exec(`UPDATE reveal_enrichment SET status='pending',last_error='conflict-recheck',next_check_ms=?,claim_id=NULL
      WHERE token_id=? AND version=? RETURNING token_id`, Date.now(), tokenId, version).toArray().length;
  }
  return page;
}

export function backfillRevealAttributePage(sql: RevealSql,
  request: Pick<EthereumRevealAttributeBackfillRequest, 'afterTokenId' | 'write' | 'retryBlocked' | 'recheckTokenId' | 'audit' | 'frozenThroughMs'>): EthereumRevealAttributeBackfillPage {
  if (request.audit) {
    if (request.write || request.retryBlocked || request.recheckTokenId || !Number.isSafeInteger(request.frozenThroughMs) ||
      request.frozenThroughMs! < 0 || request.frozenThroughMs! > Date.now()) throw new Error('Attribute audit requires a read-only frozen cutoff.');
    return auditRevealAttributePage(sql, request.afterTokenId, request.frozenThroughMs!);
  }
  const hasJobs = sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_enrichment'").toArray().length > 0;
  if (request.recheckTokenId) return recheckPublishedToken(sql, request.recheckTokenId, request.write, hasJobs);
  const actualRevision = assignmentRevision(sql, 'assignments', 'a');
  const jobRevision = hasJobs ? assignmentRevision(sql, 'reveal_enrichment', 'e') : '0';
  const ownerGuard = ownerOverrideGuard(sql);
  const rows = sql.exec<{ token_id: string; eligible: number; job_status: string | null; last_error: string | null }>(`WITH page AS MATERIALIZED (
      SELECT token_id,status FROM publication WHERE token_id>? ORDER BY token_id LIMIT ?
    ) SELECT page.token_id, (page.status='published' AND a.category!='egg' ${ownerGuard}) AS eligible,
      ${hasJobs ? 'e.status' : 'NULL'} AS job_status, ${hasJobs ? 'e.last_error' : 'NULL'} AS last_error
    FROM page JOIN assignments a ON a.token_id=page.token_id
    ${hasJobs ? `LEFT JOIN reveal_enrichment e ON e.token_id=page.token_id AND e.version=? AND ${jobRevision}=${actualRevision} ${ownerGuard}` : ''}
    ORDER BY page.token_id`, request.afterTokenId ?? '', PAGE_SIZE, ...(hasJobs ? [REVEAL_ENRICHMENT_VERSION] : [])).toArray();
  const eligible = rows.filter(row => row.eligible);
  const missing = eligible.filter(row => row.job_status === null).map(row => row.token_id);
  const blocked = eligible.filter(row => row.job_status === 'invalid' || row.job_status === 'conflict');
  const invalid = blocked.filter(row => row.job_status === 'invalid').length;
  const conflictRechecks = rows.filter(row => row.last_error === 'conflict-recheck').length;
  const enqueued = request.write && !request.retryBlocked && missing.length
    ? sql.exec(`INSERT INTO reveal_enrichment(token_id,version,next_check_ms,assignment_revision)
        SELECT a.token_id,?,?,${actualRevision} FROM assignments a WHERE a.token_id IN (SELECT value FROM json_each(?))
        ON CONFLICT(token_id,version) DO NOTHING RETURNING token_id`, REVEAL_ENRICHMENT_VERSION, Date.now(), JSON.stringify(missing)).toArray().length
    : 0;
  const requeued = request.write && request.retryBlocked && blocked.length
    ? sql.exec(`UPDATE reveal_enrichment SET status='pending', next_check_ms=?, claim_id=NULL,
        last_error=CASE WHEN status='conflict' OR last_error='conflict-recheck' THEN 'conflict-recheck' END
        WHERE version=? AND status IN ('invalid','conflict') AND token_id IN (SELECT value FROM json_each(?))
        RETURNING token_id`, Date.now(), REVEAL_ENRICHMENT_VERSION, JSON.stringify(blocked.map(row => row.token_id))).toArray().length
    : 0;
  return { eligible: eligible.length, missing: missing.length, invalid, conflict: blocked.length - invalid, conflictRechecks, enqueued, requeued,
    nextCursor: rows.length === PAGE_SIZE ? rows[rows.length - 1].token_id : null };
}
