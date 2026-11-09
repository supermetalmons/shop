import type { EthereumRevealAttributeBackfillPage, EthereumRevealAttributeBackfillRequest } from '../../../../shared/ethereum/revealMaintenance.js';
import { REVEAL_ENRICHMENT_VERSION } from '../../../../shared/ethereum/reveal.js';
import type { RevealSql } from './ethereumRevealStore.js';
import { acknowledgedEnrichmentHash, matchesEnrichmentChecksum } from './ethereumRevealEnrichmentStore.js';

const PAGE_SIZE = 256;

function recheckPublishedToken(sql: RevealSql, tokenId: string, write: boolean, hasJobs: boolean): EthereumRevealAttributeBackfillPage {
  const page = { eligible: 0, missing: 0, invalid: 0, conflict: 0, conflictRechecks: 0, enqueued: 0, requeued: 0, nextCursor: null };
  if (!hasJobs) return page;
  const version = REVEAL_ENRICHMENT_VERSION;
  const job = sql.exec<{ status: string; target_json: string | null; target_sha256: string | null; last_error: string | null }>(
    `SELECT e.status,e.target_json,e.target_sha256,e.last_error FROM reveal_enrichment e
     JOIN publication p ON p.token_id=e.token_id JOIN assignments a ON a.token_id=e.token_id
     WHERE e.token_id=? AND e.version=? AND p.status='published' AND a.category!='egg'`, tokenId, version).toArray()[0];
  if (!job) return page;
  const acknowledged = acknowledgedEnrichmentHash(sql, tokenId, version);
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
    sql.exec(`INSERT INTO reveal_enrichment_acknowledgments(token_id,version,target_sha256) VALUES(?,?,?)
      ON CONFLICT(token_id,version) DO NOTHING`, tokenId, version, job.target_sha256);
    page.requeued = sql.exec(`UPDATE reveal_enrichment SET status='pending',last_error='conflict-recheck',next_check_ms=?,claim_id=NULL
      WHERE token_id=? AND version=? RETURNING token_id`, Date.now(), tokenId, version).toArray().length;
  }
  return page;
}

export function backfillRevealAttributePage(sql: RevealSql,
  request: Pick<EthereumRevealAttributeBackfillRequest, 'afterTokenId' | 'write' | 'retryBlocked' | 'recheckTokenId'>): EthereumRevealAttributeBackfillPage {
  const hasJobs = sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_enrichment'").toArray().length > 0;
  if (request.recheckTokenId) return recheckPublishedToken(sql, request.recheckTokenId, request.write, hasJobs);
  const rows = sql.exec<{ token_id: string; eligible: number; job_status: string | null; last_error: string | null }>(`WITH page AS MATERIALIZED (
      SELECT token_id,status FROM publication WHERE token_id>? ORDER BY token_id LIMIT ?
    ) SELECT page.token_id, (page.status='published' AND a.category!='egg') AS eligible,
      ${hasJobs ? 'e.status' : 'NULL'} AS job_status, ${hasJobs ? 'e.last_error' : 'NULL'} AS last_error
    FROM page JOIN assignments a ON a.token_id=page.token_id
    ${hasJobs ? 'LEFT JOIN reveal_enrichment e ON e.token_id=page.token_id AND e.version=?' : ''}
    ORDER BY page.token_id`, request.afterTokenId ?? '', PAGE_SIZE, ...(hasJobs ? [REVEAL_ENRICHMENT_VERSION] : [])).toArray();
  const eligible = rows.filter(row => row.eligible);
  const missing = eligible.filter(row => row.job_status === null).map(row => row.token_id);
  const blocked = eligible.filter(row => row.job_status === 'invalid' || row.job_status === 'conflict');
  const invalid = blocked.filter(row => row.job_status === 'invalid').length;
  const conflictRechecks = rows.filter(row => row.last_error === 'conflict-recheck').length;
  const enqueued = request.write && !request.retryBlocked && missing.length
    ? sql.exec(`INSERT INTO reveal_enrichment(token_id,version,next_check_ms) SELECT value,?,? FROM json_each(?) WHERE true
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
