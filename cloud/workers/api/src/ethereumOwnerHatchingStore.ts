import { initializeOwnerHatchingSchemaV1 } from './ethereumRevealSchema/ownerHatching.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { MAX_REVEAL_METADATA_BYTES } from './ethereumRevealAttributes.js';
import { parseMetadataJson } from './ethereumMetadataJson.js';
import { revealRandomInteger } from './ethereumRevealCatalog.js';
import type { RevealOriginUnit } from './ethereumRevealCatalogTypes.js';
import type { RevealPublicationJob, RevealPublicationResult, RevealSql } from './ethereumRevealStore.js';
import { EthereumOwnerHatchingReader } from './ethereumOwnerHatchingReader.js';
import {
  OWNER_HATCHING_ENRICHMENT_CLAIM_MS,
  type OwnerHatchingAsset,
  type OwnerHatchingBatchInput,
  type OwnerHatchingBatchRow,
  type OwnerHatchingBatchStatus,
  type OwnerHatchingCanonical,
  type OwnerHatchingEnrichment,
  type OwnerHatchingEnrichmentError,
  type OwnerHatchingHooks,
  type OwnerHatchingPublicationRow,
  type OwnerHatchingResult,
} from './ethereumOwnerHatchingTypes.js';

const SHA256 = /^[a-f0-9]{64}$/;
const CATEGORIES = new Set(['painting', 'video', '3d', 'animated']);
const hash = (value: string) => bytesToHex(sha256(value));

function integer(value: number, maximum = 111_111): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validAsset(asset: OwnerHatchingAsset): boolean {
  return CATEGORIES.has(asset.category) && integer(asset.assetId) && (asset.attributesJson === undefined ||
    typeof asset.attributesJson === 'string' && asset.attributesJson.length > 0 &&
    new TextEncoder().encode(asset.attributesJson).byteLength <= MAX_REVEAL_METADATA_BYTES && Array.isArray(parseMetadataJson(asset.attributesJson)));
}

function withReady(metadataJson: string): string {
  const value = parseMetadataJson(metadataJson);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid egg metadata.');
  const result = JSON.stringify({ ...value, readyToHatch: true }) + '\n';
  if (new TextEncoder().encode(result).byteLength > MAX_REVEAL_METADATA_BYTES) throw new Error('Owner hatching metadata is too large.');
  return result;
}

function predecessors(...values: string[]): string[] {
  const distinct = [...new Set(values)];
  if (distinct.length > 4) throw new Error('Too many owner hatching metadata predecessors.');
  return distinct;
}

export class EthereumOwnerHatchingStore {
  initialized = false;
  private readonly transaction: <T>(action: () => T) => T;

  constructor(private readonly sql: RevealSql, transaction: <T>(action: () => T) => T,
    private readonly hooks: OwnerHatchingHooks, private readonly randomInteger = revealRandomInteger,
    readonly reader = new EthereumOwnerHatchingReader(sql)) {
    let depth = 0;
    this.transaction = <T>(action: () => T): T => {
      if (depth) return action();
      return transaction(() => {
        depth++;
        try { return action(); } finally { depth--; }
      });
    };
  }

  initialize(): void {
    if (this.initialized) return;
    initializeOwnerHatchingSchemaV1(this.sql, this.transaction);
    this.reader.noteSchemaInitialized();
    this.initialized = true;
  }

  private overrideSlot(origin: RevealOriginUnit, asset: RevealOriginUnit, tokenId: string, now: number): void {
    this.sql.exec(`INSERT INTO owner_hatching_slot_history(token_id,origin_category,origin_asset_id,category,asset_id,created_at_ms)
      VALUES(?,?,?,?,?,?)`, tokenId, origin.category, origin.assetId, asset.category, asset.assetId, now);
    this.sql.exec(`INSERT INTO owner_hatching_slot_overrides(origin_category,origin_asset_id,category,asset_id,token_id)
      VALUES(?,?,?,?,?) ON CONFLICT(origin_category,origin_asset_id)
      DO UPDATE SET category=excluded.category,asset_id=excluded.asset_id,token_id=excluded.token_id`,
      origin.category, origin.assetId, asset.category, asset.assetId, tokenId);
  }

  protectOrdinaryReward(origin: RevealOriginUnit, asset: OwnerHatchingAsset, now = Date.now()): void {
    this.transaction(() => {
      const sponsor = this.sql.exec<{ token_id: string; batch_id: string }>(`SELECT token_id,batch_id FROM owner_hatching_tokens t
        WHERE t.status='ready' AND t.grail_asset_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM owner_hatching_ordinary_backing b WHERE b.sponsor=t.token_id)
        ORDER BY CAST(t.token_id AS INTEGER) LIMIT 1`).toArray()[0];
      if (!sponsor) throw new Error('Missing pending ordinary hatch.');
      const fresh = this.unusedFreshEgg(sponsor.batch_id);
      if (!fresh) throw new Error('Missing fresh egg for pending ordinary hatch.');
      // The sponsor supplies the replacement egg slot. The artwork is drawn separately at claim time.
      this.sql.exec(`INSERT INTO owner_hatching_ordinary_backing(egg_id,sponsor,category,asset_id,attributes_json)
        VALUES(?,?,?,?,?)`, fresh.egg_id, sponsor.token_id, asset.category, asset.assetId, asset.attributesJson ?? null);
      const replacement = { category: 'egg' as const, assetId: fresh.egg_id };
      this.overrideSlot(origin, replacement, sponsor.token_id, now);
      this.hooks.transitionSlot(origin, asset, replacement);
    });
  }

  private unusedFreshEgg(batchId: string) {
    return this.sql.exec<{ egg_id: number }>(`SELECT egg_id FROM owner_hatching_fresh_eggs f WHERE batch_id=? AND token_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM owner_hatching_ordinary_backing b WHERE b.egg_id=f.egg_id) ORDER BY egg_id LIMIT 1`, batchId).toArray()[0];
  }

  eligibleCandidate(tokenId: string): OwnerHatchingCanonical | null {
    if (this.reader.token(tokenId)) return null;
    const canonical = this.hooks.canonical(tokenId);
    return canonical?.category === 'egg' && !this.reader.hasProtectedEgg(canonical.assetId) &&
      this.hooks.eligibleEgg(tokenId, canonical.assetId) ? canonical : null;
  }

  prepare(input: OwnerHatchingBatchInput, now = Date.now(), options?: { frozenOrder: true }): OwnerHatchingBatchStatus {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.batchId) || !SHA256.test(input.sourceSha256) ||
      !integer(input.readyCount) || !integer(now, Number.MAX_SAFE_INTEGER) || !Array.isArray(input.candidateTokenIds) ||
      input.candidateTokenIds.length > 111_111 || input.candidateTokenIds.some(id => !/^[1-9]\d*$/.test(id) || !integer(Number(id))) ||
      new Set(input.candidateTokenIds).size !== input.candidateTokenIds.length || !Array.isArray(input.grails) ||
      input.grails.length > input.readyCount || input.grails.some(asset => !validAsset(asset)) ||
      new Set(input.grails.map(asset => `${asset.category}:${asset.assetId}`)).size !== input.grails.length ||
      !Array.isArray(input.freshEggIds) || input.freshEggIds.length !== input.readyCount - input.grails.length ||
      options?.frozenOrder && input.candidateTokenIds.length !== input.readyCount ||
      input.freshEggIds.some(id => !integer(id)) || new Set(input.freshEggIds).size !== input.freshEggIds.length) {
      throw new Error('Invalid owner hatching batch.');
    }
    const inputSha256 = hash(JSON.stringify({ sourceSha256: input.sourceSha256, readyCount: input.readyCount,
      candidateTokenIds: options?.frozenOrder && input.freshEggIds.length ? input.candidateTokenIds : [...input.candidateTokenIds].sort((a, b) => Number(a) - Number(b)),
      grails: options?.frozenOrder ? input.grails : [...input.grails].sort((a, b) => a.category.localeCompare(b.category) || a.assetId - b.assetId),
      ...(options?.frozenOrder ? { frozenOrder: true } : {}),
      freshEggIds: [...input.freshEggIds].sort((a, b) => a - b) }));
    return this.transaction(() => {
      const existing = this.sql.exec<OwnerHatchingBatchRow>('SELECT * FROM owner_hatching_batches WHERE batch_id=?', input.batchId).toArray()[0];
      if (existing) {
        if (existing.input_sha256 !== inputSha256) throw new Error('Owner hatching batch replay changed.');
        return this.reader.batchStatus(input.batchId)!;
      }
      if (input.grails.some(asset => this.reader.reservedGrail(asset) || this.reader.claimedArtwork(asset)) ||
        input.freshEggIds.some(id => this.reader.usedFreshEgg(id) || this.reader.hasProtectedEgg(id) || !this.hooks.freshEggAvailable(id))) {
        throw new Error('Owner hatching batch contains unavailable assets.');
      }
      const candidates = [...input.candidateTokenIds];
      if (options?.frozenOrder) {
        if (input.freshEggIds.length) candidates.reverse();
        else candidates.sort((a, b) => Number(b) - Number(a));
      }
      const selected: string[] = [];
      while (candidates.length && selected.length < input.readyCount) {
        const index = options?.frozenOrder ? candidates.length - 1 : this.randomInteger(candidates.length);
        const tokenId = candidates[index];
        candidates[index] = candidates[candidates.length - 1];
        candidates.pop();
        if (options?.frozenOrder || this.eligibleCandidate(tokenId)) selected.push(tokenId);
      }
      if (selected.length !== input.readyCount) throw new Error('Not enough eligible minted eggs.');
      const grails = [...input.grails];
      if (!options?.frozenOrder) {
        for (let index = grails.length - 1; index > 0; index--) {
          const other = this.randomInteger(index + 1);
          [grails[index], grails[other]] = [grails[other], grails[index]];
        }
      }
      this.sql.exec(`INSERT INTO owner_hatching_batches(batch_id,source_sha256,input_sha256,ready_count,grail_count,fresh_egg_count,created_at_ms)
        VALUES(?,?,?,?,?,?,?)`, input.batchId, input.sourceSha256, inputSha256, input.readyCount, grails.length, input.freshEggIds.length, now);
      for (const grail of grails) this.sql.exec('INSERT INTO owner_hatching_grails(category,asset_id,batch_id,attributes_json) VALUES(?,?,?,?)',
        grail.category, grail.assetId, input.batchId, grail.attributesJson ?? null);
      for (const eggId of input.freshEggIds) this.sql.exec('INSERT INTO owner_hatching_fresh_eggs(egg_id,batch_id) VALUES(?,?)', eggId, input.batchId);
      for (let index = 0; index < selected.length; index++) {
        const original = this.eligibleCandidate(selected[index]);
        if (!original) throw new Error('Not enough eligible minted eggs.');
        const grail = grails[index];
        const metadataJson = withReady(original.metadataJson);
        const metadataRevision = original.metadataRevision + 2;
        const canonical: OwnerHatchingCanonical = { ...original, metadataJson, metadataRevision,
          artwork: { ...original.artwork, metadataRevision, readyToHatch: true }, targetSha256: hash(metadataJson),
          expectedJsons: predecessors(original.metadataJson, ...original.expectedJsons), migration: true };
        this.sql.exec(`INSERT INTO owner_hatching_tokens(token_id,batch_id,egg_id,original_json,grail_category,grail_asset_id,status,
          canonical_json,metadata_revision) VALUES(?,?,?,?,?,?,'ready',?,?)`, original.tokenId, input.batchId, original.assetId,
          JSON.stringify(original), grail?.category ?? null, grail?.assetId ?? null, JSON.stringify(canonical), metadataRevision);
        this.sql.exec('INSERT INTO owner_hatching_publication(token_id,metadata_revision) VALUES(?,?)', original.tokenId, metadataRevision);
      }
      return this.reader.batchStatus(input.batchId)!;
    });
  }

  hatch(tokenId: string, now = Date.now()): OwnerHatchingResult {
    return this.transaction(() => {
      const token = this.reader.token(tokenId);
      if (!token) return { kind: 'not-ready' };
      const previous = parseMetadataJson(token.canonical_json) as OwnerHatchingCanonical;
      if (token.status === 'hatched') return { kind: 'hatched', artwork: previous.artwork };
      if (!this.hooks.eligibleEgg(tokenId, token.egg_id)) return { kind: 'not-ready' };
      const original = parseMetadataJson(token.original_json) as OwnerHatchingCanonical;
      const origin = this.hooks.originForToken(tokenId);
      let replacement: { origin: RevealOriginUnit; eggId: number } | undefined;
      let asset: OwnerHatchingAsset;
      if (token.grail_category !== null && token.grail_asset_id !== null) {
        const grail = this.sql.exec<{ attributes_json: string | null }>(
          'SELECT attributes_json FROM owner_hatching_grails WHERE category=? AND asset_id=?', token.grail_category, token.grail_asset_id).toArray()[0];
        asset = { category: token.grail_category, assetId: token.grail_asset_id };
        const attributes = grail.attributes_json ?? this.hooks.reservedAttributes?.(token.batch_id, asset);
        if (attributes !== undefined) asset.attributesJson = attributes;
      } else {
        const sponsored = this.sql.exec<{ egg_id: number }>('SELECT egg_id FROM owner_hatching_ordinary_backing WHERE sponsor=?', tokenId).toArray()[0];
        const fresh = sponsored ?? this.unusedFreshEgg(token.batch_id);
        if (!fresh) return { kind: 'unavailable' };
        if (sponsored) {
          const count = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM owner_hatching_ordinary_backing WHERE claimed_by IS NULL').toArray()[0].n;
          if (!count) throw new Error('Pending ordinary hatch has no backing artwork.');
          const backing = this.sql.exec<{ egg_id: number; category: OwnerHatchingAsset['category']; asset_id: number; attributes_json: string | null }>(
            `SELECT egg_id,category,asset_id,attributes_json FROM owner_hatching_ordinary_backing
              WHERE claimed_by IS NULL ORDER BY egg_id LIMIT 1 OFFSET ?`, this.randomInteger(count)).toArray()[0];
          asset = { category: backing.category, assetId: backing.asset_id, ...(backing.attributes_json ? { attributesJson: backing.attributes_json } : {}) };
          this.sql.exec('UPDATE owner_hatching_ordinary_backing SET claimed_by=? WHERE egg_id=? AND claimed_by IS NULL', tokenId, backing.egg_id);
        } else {
          const chosen = this.hooks.takeOrdinary();
          if (!chosen) return { kind: 'unavailable' };
          asset = chosen.effective;
          this.overrideSlot(chosen.origin, { category: 'egg', assetId: fresh.egg_id }, tokenId, now);
          this.hooks.transitionSlot(chosen.origin, chosen.effective, { category: 'egg', assetId: fresh.egg_id });
          replacement = { origin: chosen.origin, eggId: fresh.egg_id };
        }
        if (!validAsset(asset) || this.reader.reservedGrail(asset) || this.reader.claimedArtwork(asset)) throw new Error('Ordinary hatch selected unavailable artwork.');
        this.sql.exec('UPDATE owner_hatching_fresh_eggs SET token_id=? WHERE egg_id=? AND token_id IS NULL', tokenId, fresh.egg_id);
      }
      if (!validAsset(asset)) throw new Error('Invalid hatch artwork.');
      const built = this.hooks.build(tokenId, asset, original);
      if (built.artwork.tokenId !== tokenId || built.artwork.category !== asset.category ||
        built.artwork.crateTokenId !== original.artwork.crateTokenId ||
        new TextEncoder().encode(built.metadataJson).byteLength > MAX_REVEAL_METADATA_BYTES) throw new Error('Invalid hatch result.');
      const metadata = parseMetadataJson(built.metadataJson);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || 'readyToHatch' in metadata) throw new Error('Invalid hatched metadata.');
      const metadataRevision = previous.metadataRevision + 2;
      const artwork = { ...built.artwork, metadataRevision };
      const canonical: OwnerHatchingCanonical = { ...original, category: asset.category, assetId: asset.assetId,
        metadataRevision, artwork, metadataJson: built.metadataJson, targetSha256: hash(built.metadataJson),
        expectedJsons: predecessors(previous.metadataJson, ...previous.expectedJsons), allowMissing: original.allowMissing, migration: true };
      this.overrideSlot(origin, asset, tokenId, now);
      this.hooks.transitionSlot(origin, { category: 'egg', assetId: token.egg_id }, asset);
      if (replacement) this.hooks.releaseReplacement(replacement.origin, replacement.eggId);
      this.sql.exec('INSERT INTO owner_hatching_artwork_claims(category,asset_id,token_id,claimed_at_ms) VALUES(?,?,?,?)',
        asset.category, asset.assetId, tokenId, now);
      this.sql.exec('INSERT INTO owner_hatching_retired_eggs(egg_id,token_id,retired_at_ms) VALUES(?,?,?)', token.egg_id, tokenId, now);
      this.sql.exec(`UPDATE owner_hatching_tokens SET status='hatched',canonical_json=?,metadata_revision=?,hatched_at_ms=? WHERE token_id=?`,
        JSON.stringify(canonical), metadataRevision, now, tokenId);
      this.sql.exec(`UPDATE owner_hatching_publication SET status='pending',metadata_revision=?,attempts=0,next_check_ms=0,claim_id=NULL WHERE token_id=?`,
        metadataRevision, tokenId);
      if (token.grail_asset_id === null && asset.attributesJson === undefined) {
        this.sql.exec('INSERT INTO owner_hatching_enrichment(token_id,metadata_revision) VALUES(?,?)', tokenId, metadataRevision);
      }
      return { kind: 'hatched', artwork };
    });
  }

  claimPublications(now: number, limit = 8): RevealPublicationJob[] {
    if (!integer(limit, 64)) throw new Error('Invalid owner publication batch size.');
    return this.transaction(() => {
      const rows = this.sql.exec<OwnerHatchingPublicationRow>(`SELECT * FROM owner_hatching_publication
        WHERE status='pending' AND next_check_ms<=? ORDER BY next_check_ms,CAST(token_id AS INTEGER) LIMIT ?`, now, limit).toArray();
      const claimId = crypto.randomUUID();
      return rows.map(row => {
        const canonical = this.reader.canonical(row.token_id)!;
        this.sql.exec(`UPDATE owner_hatching_publication SET next_check_ms=?,attempts=attempts+1,claim_id=? WHERE token_id=?`, now + 60_000, claimId, row.token_id);
        return { token_id: row.token_id, metadata_json: canonical.metadataJson, placeholder_json: canonical.expectedJsons[0],
          attempts: row.attempts, claim_id: claimId, metadata_revision: canonical.metadataRevision,
          expected_jsons_json: JSON.stringify(canonical.expectedJsons), allow_missing: canonical.allowMissing, migration: true };
      });
    });
  }

  completePublications(results: RevealPublicationResult[], now: number): RevealPublicationResult[] {
    return this.transaction(() => {
      const applied: RevealPublicationResult[] = [];
      for (const result of results) {
        const { job, status } = result;
        const current = this.reader.canonical(job.token_id);
        if (!current || current.metadataRevision !== job.metadata_revision || current.metadataJson !== job.metadata_json) continue;
        const next = status === 'superseded' ? now : now + Math.min(300_000, 1_000 * 2 ** Math.min(job.attempts + 1, 8));
        const updated = this.sql.exec(`UPDATE owner_hatching_publication SET status=?,next_check_ms=?,claim_id=NULL,
          attempts=CASE WHEN ?='superseded' THEN ? ELSE attempts END
          WHERE token_id=? AND status='pending' AND metadata_revision=? AND attempts=? AND claim_id IS ? RETURNING token_id`,
          status === 'published' ? 'published' : status === 'conflict' ? 'conflict' : 'pending', next, status, job.attempts,
          job.token_id, job.metadata_revision ?? 0, job.attempts + 1, job.claim_id ?? null).toArray().length;
        if (updated) applied.push(result);
      }
      return applied;
    });
  }

  releasePublicationClaims(jobs: RevealPublicationJob[], now: number): void {
    this.completePublications(jobs.map(job => ({ job, status: 'superseded' })), now);
  }

  enrichmentPage(now: number, limit = 4): OwnerHatchingEnrichment[] {
    if (!integer(limit, 8)) throw new Error('Invalid owner enrichment batch size.');
    return this.transaction(() => {
      const rows = this.sql.exec<{ token_id: string; metadata_revision: number; attempts: number; last_error: OwnerHatchingEnrichmentError | null }>(
        `SELECT e.token_id,e.metadata_revision,e.attempts,e.last_error FROM owner_hatching_enrichment e
          JOIN owner_hatching_tokens t ON t.token_id=e.token_id WHERE e.status='pending' AND t.status='hatched'
          AND e.metadata_revision=t.metadata_revision AND e.next_check_ms<=? ORDER BY e.next_check_ms,e.token_id LIMIT ?`, now, limit).toArray();
      return rows.map(row => {
        const canonical = this.reader.canonical(row.token_id)!;
        if (canonical.category === 'egg') throw new Error('Hatched artwork cannot be an egg.');
        this.sql.exec('UPDATE owner_hatching_enrichment SET next_check_ms=?,attempts=attempts+1 WHERE token_id=?', now + OWNER_HATCHING_ENRICHMENT_CLAIM_MS, row.token_id);
        return { tokenId: row.token_id, category: canonical.category, assetId: canonical.assetId,
          metadataRevision: row.metadata_revision, baseJson: canonical.metadataJson, attempts: row.attempts + 1, lastError: row.last_error };
      });
    });
  }

  acceptEnrichment(tokenId: string, expectedRevision: number, metadataJson: string, metadataSha256 = hash(metadataJson)): boolean {
    return this.transaction(() => {
      const token = this.reader.token(tokenId);
      const pending = this.sql.exec<{ metadata_revision: number }>(
        "SELECT metadata_revision FROM owner_hatching_enrichment WHERE token_id=? AND status='pending'", tokenId).toArray()[0];
      if (!token || token.status !== 'hatched' || token.metadata_revision !== expectedRevision || pending?.metadata_revision !== expectedRevision) return false;
      const previous = parseMetadataJson(token.canonical_json) as OwnerHatchingCanonical;
      if (new TextEncoder().encode(metadataJson).byteLength > MAX_REVEAL_METADATA_BYTES || hash(metadataJson) !== metadataSha256) {
        throw new Error('Invalid owner hatching enrichment checksum.');
      }
      const before = parseMetadataJson(previous.metadataJson);
      const after = parseMetadataJson(metadataJson);
      if (!before || typeof before !== 'object' || Array.isArray(before) || !after || typeof after !== 'object' || Array.isArray(after) ||
        !('attributes' in after) || !Array.isArray(after.attributes) || !after.attributes.length || 'readyToHatch' in after) {
        throw new Error('Invalid owner hatching enrichment.');
      }
      const withoutAttributes = (value: object) => JSON.stringify(Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'attributes').sort(([a], [b]) => a.localeCompare(b))));
      if (withoutAttributes(before) !== withoutAttributes(after)) throw new Error('Owner enrichment cannot change the revealed artwork.');
      const metadataRevision = expectedRevision + 1;
      const canonical: OwnerHatchingCanonical = { ...previous, metadataJson, metadataRevision, targetSha256: metadataSha256,
        artwork: { ...previous.artwork, metadataRevision },
        expectedJsons: predecessors(previous.metadataJson, ...previous.expectedJsons) };
      this.sql.exec('UPDATE owner_hatching_tokens SET canonical_json=?,metadata_revision=? WHERE token_id=?', JSON.stringify(canonical), metadataRevision, tokenId);
      this.sql.exec("UPDATE owner_hatching_enrichment SET status='complete',last_error=NULL WHERE token_id=?", tokenId);
      this.sql.exec(`UPDATE owner_hatching_publication SET status='pending',metadata_revision=?,attempts=0,next_check_ms=0,claim_id=NULL WHERE token_id=?`,
        metadataRevision, tokenId);
      return true;
    });
  }

  failEnrichment(tokenId: string, expectedRevision: number, now: number, reason: OwnerHatchingEnrichmentError): boolean {
    return this.sql.exec(`UPDATE owner_hatching_enrichment SET last_error=?,next_check_ms=?+MIN(300000,1000*(1<<MIN(attempts,8)))
      WHERE token_id=? AND status='pending' AND metadata_revision=? RETURNING token_id`, reason, now, tokenId, expectedRevision).toArray().length > 0;
  }
}
