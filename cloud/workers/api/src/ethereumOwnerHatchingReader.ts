import type { EthereumArtworkCategory } from '../../../../shared/ethereum/reveal.js';
import type { RevealOriginUnit } from './ethereumRevealCatalogTypes.js';
import type { RevealSql } from './ethereumRevealStore.js';
import { parseMetadataJson } from './ethereumMetadataJson.js';
import {
  OWNER_HATCHING_ENRICHMENT_CLAIM_MS,
  type OwnerHatchingBatchRow,
  type OwnerHatchingBatchStatus,
  type OwnerHatchingCanonical,
  type OwnerHatchingEnrichmentError,
  type OwnerHatchingEnrichmentSummary,
  type OwnerHatchingTokenRow,
} from './ethereumOwnerHatchingTypes.js';

export class EthereumOwnerHatchingReader {
  private schemaAvailable: boolean;
  private currentSchema = false;

  constructor(private readonly sql: RevealSql) {
    this.schemaAvailable = this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='owner_hatching_tokens'").toArray().length > 0;
  }

  noteSchemaInitialized(): void {
    this.schemaAvailable = true;
    this.currentSchema = true;
  }

  get available(): boolean {
    if (!this.schemaAvailable) this.schemaAvailable = this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='owner_hatching_tokens'").toArray().length > 0;
    return this.schemaAvailable;
  }

  token(tokenId: string): OwnerHatchingTokenRow | undefined {
    if (!this.available) return;
    return this.sql.exec<OwnerHatchingTokenRow>('SELECT * FROM owner_hatching_tokens WHERE token_id=?', tokenId).toArray()[0];
  }

  hasBatch(): boolean {
    if (!this.available) return false;
    return this.sql.exec('SELECT 1 FROM owner_hatching_batches LIMIT 1').toArray().length > 0;
  }

  isRetiredEgg(eggId: number): boolean {
    if (!this.available) return false;
    return this.sql.exec('SELECT 1 FROM owner_hatching_retired_eggs WHERE egg_id=?', eggId).toArray().length > 0;
  }

  hasProtectedEgg(eggId: number): boolean {
    if (!this.available) return false;
    return this.sql.exec('SELECT 1 FROM owner_hatching_tokens WHERE egg_id=?', eggId).toArray().length > 0 || this.isRetiredEgg(eggId);
  }

  usedFreshEgg(eggId: number): boolean {
    if (!this.available) return false;
    return this.sql.exec('SELECT 1 FROM owner_hatching_fresh_eggs WHERE egg_id=?', eggId).toArray().length > 0;
  }

  unbackedOrdinaryCount(): number {
    if (!this.available) return 0;
    const hasBacking = this.currentSchema || this.sql.exec(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='owner_hatching_ordinary_backing'").toArray().length > 0;
    const unbacked = hasBacking ? 'AND NOT EXISTS(SELECT 1 FROM owner_hatching_ordinary_backing b WHERE b.egg_id=f.egg_id)' : '';
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM owner_hatching_fresh_eggs f WHERE f.token_id IS NULL ${unbacked}`).toArray()[0].n;
  }

  reservedGrail(asset: RevealOriginUnit): boolean {
    if (!this.available) return false;
    return this.sql.exec('SELECT 1 FROM owner_hatching_grails WHERE category=? AND asset_id=?', asset.category, asset.assetId).toArray().length > 0;
  }

  claimedArtwork(asset: RevealOriginUnit): boolean {
    if (!this.available) return false;
    return this.sql.exec('SELECT 1 FROM owner_hatching_artwork_claims WHERE category=? AND asset_id=?', asset.category, asset.assetId).toArray().length > 0;
  }

  slotOverride(origin: RevealOriginUnit): RevealOriginUnit | null {
    if (!this.available) return null;
    const row = this.sql.exec<{ category: EthereumArtworkCategory; asset_id: number }>(
      'SELECT category,asset_id FROM owner_hatching_slot_overrides WHERE origin_category=? AND origin_asset_id=?', origin.category, origin.assetId).toArray()[0];
    return row ? { category: row.category, assetId: row.asset_id } : null;
  }

  slotOverrides(origins: readonly RevealOriginUnit[]): Array<RevealOriginUnit | null> {
    if (!origins.length || !this.available) return origins.map(() => null);
    const values = new Map<string, RevealOriginUnit>();
    const unique = [...new Map(origins.map(origin => [`${origin.category}:${origin.assetId}`, origin])).values()];
    for (let offset = 0; offset < unique.length; offset += 50) {
      const page = unique.slice(offset, offset + 50);
      const rows = this.sql.exec<{ origin_category: EthereumArtworkCategory; origin_asset_id: number;
        category: EthereumArtworkCategory; asset_id: number }>(
        `SELECT * FROM owner_hatching_slot_overrides
          WHERE (origin_category,origin_asset_id) IN (${page.map(() => '(?,?)').join(',')})`,
        ...page.flatMap(origin => [origin.category, origin.assetId])).toArray();
      for (const row of rows) values.set(`${row.origin_category}:${row.origin_asset_id}`, { category: row.category, assetId: row.asset_id });
    }
    return origins.map(origin => values.get(`${origin.category}:${origin.assetId}`) ?? null);
  }

  canonical(tokenId: string): OwnerHatchingCanonical | null {
    const row = this.token(tokenId);
    return row ? parseMetadataJson(row.canonical_json) as OwnerHatchingCanonical : null;
  }

  canonicals(tokenIds: readonly string[]): Map<string, OwnerHatchingCanonical> {
    const values = new Map<string, OwnerHatchingCanonical>();
    if (!tokenIds.length || !this.available) return values;
    const unique = [...new Set(tokenIds)];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const page = unique.slice(offset, offset + 100);
      const sizes = this.sql.exec<{ token_id: string; bytes: number }>(
        `SELECT token_id,length(CAST(canonical_json AS BLOB)) AS bytes FROM owner_hatching_tokens
          WHERE token_id IN (${page.map(() => '?').join(',')})`, ...page).toArray();
      for (let start = 0; start < sizes.length;) {
        let end = start + 1, bytes = sizes[start].bytes;
        while (end < sizes.length && bytes + sizes[end].bytes <= 1024 * 1024) bytes += sizes[end++].bytes;
        const ids = sizes.slice(start, end).map(row => row.token_id);
        const rows = this.sql.exec<Pick<OwnerHatchingTokenRow, 'token_id' | 'canonical_json'>>(
          `SELECT token_id,canonical_json FROM owner_hatching_tokens WHERE token_id IN (${ids.map(() => '?').join(',')})`, ...ids).toArray();
        for (const row of rows) values.set(row.token_id, parseMetadataJson(row.canonical_json) as OwnerHatchingCanonical);
        start = end;
      }
    }
    return values;
  }

  readyTokenIds(): string[] {
    if (!this.available) return [];
    return this.sql.exec<{ token_id: string }>("SELECT token_id FROM owner_hatching_tokens WHERE status='ready' ORDER BY CAST(token_id AS INTEGER)")
      .toArray().map(row => row.token_id);
  }

  batchStatus(batchId?: string): OwnerHatchingBatchStatus | null {
    if (!this.available) return null;
    const batch = (batchId === undefined
      ? this.sql.exec<OwnerHatchingBatchRow>('SELECT * FROM owner_hatching_batches ORDER BY created_at_ms DESC,batch_id DESC LIMIT 1')
      : this.sql.exec<OwnerHatchingBatchRow>('SELECT * FROM owner_hatching_batches WHERE batch_id=?', batchId)).toArray()[0];
    if (!batch) return null;
    const counts = this.sql.exec<{ ready: number; hatched: number; published: number; pending: number; conflicts: number }>(
      `SELECT COALESCE(SUM(t.status='ready'),0) AS ready,COALESCE(SUM(t.status='hatched'),0) AS hatched,
        COALESCE(SUM(p.status='published'),0) AS published,COALESCE(SUM(p.status='pending'),0) AS pending,
        COALESCE(SUM(p.status='conflict'),0) AS conflicts FROM owner_hatching_tokens t
        JOIN owner_hatching_publication p ON p.token_id=t.token_id WHERE t.batch_id=?`, batch.batch_id).toArray()[0];
    const enrichment = this.enrichmentSummary(batch.batch_id);
    return { batchId: batch.batch_id, sourceSha256: batch.source_sha256, phase: counts.pending || counts.conflicts ? 'publishing' : 'complete',
      prepared: true, readyCount: batch.ready_count, grailCount: batch.grail_count, freshEggCount: batch.fresh_egg_count,
      ready: counts.ready, hatched: counts.hatched, published: counts.published, pendingPublication: counts.pending, conflicts: counts.conflicts,
      pendingEnrichment: enrichment.pending, failedEnrichment: enrichment.failed };
  }

  enrichmentSummary(batchId?: string): OwnerHatchingEnrichmentSummary {
    const summary: OwnerHatchingEnrichmentSummary = { pending: 0, failed: 0, completed: 0, errors: {} };
    if (!this.available) return summary;
    const lastError = this.currentSchema || this.sql.exec<{ name: string }>('PRAGMA table_info(owner_hatching_enrichment)')
      .toArray().some(row => row.name === 'last_error') ? 'e.last_error' : 'NULL';
    const rows = this.sql.exec<{ status: 'pending' | 'complete'; last_error: OwnerHatchingEnrichmentError | null; count: number }>(
      `SELECT e.status,${lastError} AS last_error,COUNT(*) AS count FROM owner_hatching_enrichment e
        JOIN owner_hatching_tokens t ON t.token_id=e.token_id ${batchId === undefined ? '' : 'WHERE t.batch_id=?'}
        GROUP BY e.status,${lastError}`, ...(batchId === undefined ? [] : [batchId])).toArray();
    for (const row of rows) {
      if (row.status === 'complete') summary.completed += row.count;
      else {
        summary.pending += row.count;
        if (row.last_error !== null) {
          summary.failed += row.count;
          summary.errors[row.last_error] = row.count;
        }
      }
    }
    return summary;
  }

  nextWake(now: number, enrichmentBusy = false): number | null {
    if (!this.available) return null;
    const row = this.sql.exec<{ publication: number | null; enrichment: number | null }>(`SELECT
      (SELECT MIN(next_check_ms) FROM owner_hatching_publication WHERE status='pending') AS publication,
      (SELECT MIN(next_check_ms) FROM owner_hatching_enrichment WHERE status='pending') AS enrichment`).toArray()[0];
    const enrichment = row.enrichment === null ? null : Math.max(row.enrichment, enrichmentBusy ? now + OWNER_HATCHING_ENRICHMENT_CLAIM_MS : now);
    const times = [row.publication, enrichment].filter((value): value is number => value !== null);
    return times.length ? Math.max(now, Math.min(...times)) : null;
  }

  publicationError(): 'metadata-conflict' | 'publication-unavailable' | null {
    if (!this.available) return null;
    if (this.sql.exec("SELECT 1 FROM owner_hatching_publication WHERE status='conflict' LIMIT 1").toArray().length) return 'metadata-conflict';
    if (this.sql.exec("SELECT 1 FROM owner_hatching_publication WHERE status='pending' AND attempts>0 LIMIT 1").toArray().length) return 'publication-unavailable';
    return null;
  }
}
