import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { EthereumArtworkCategory, EthereumRevealedArtwork } from '../../../../shared/ethereum/reveal.js';
import { MAX_REVEAL_METADATA_BYTES } from './ethereumRevealAttributes.js';
import { parseMetadataJson } from './ethereumMetadataJson.js';
import { revealRandomInteger } from './ethereumRevealCatalog.js';
import type { RevealCanonicalMetadata, RevealOriginUnit } from './ethereumRevealCatalogUpdateStore.js';
import type { RevealPublicationJob, RevealPublicationResult, RevealSql } from './ethereumRevealStore.js';

export type OwnerHatchingCanonical = RevealCanonicalMetadata;
export type OwnerHatchingAsset = {
  category: Exclude<EthereumArtworkCategory, 'egg'>;
  assetId: number;
  attributesJson?: string;
};
export type OwnerHatchingHooks = {
  canonical(tokenId: string): OwnerHatchingCanonical | null;
  build(tokenId: string, asset: OwnerHatchingAsset, original: OwnerHatchingCanonical): {
    artwork: EthereumRevealedArtwork; metadataJson: string;
  };
  takeOrdinary(): { origin: RevealOriginUnit; effective: OwnerHatchingAsset } | null;
  originForToken(tokenId: string): RevealOriginUnit;
  transitionSlot(origin: RevealOriginUnit, before: RevealOriginUnit, after: RevealOriginUnit): void;
  releaseReplacement(origin: RevealOriginUnit, freshEggId: number): void;
  freshEggAvailable(eggId: number): boolean;
  eligibleEgg(tokenId: string, eggId: number): boolean;
};
export type OwnerHatchingBatchInput = {
  batchId: string;
  sourceSha256: string;
  candidateTokenIds: string[];
  readyCount: number;
  grails: OwnerHatchingAsset[];
  freshEggIds: number[];
};
export type OwnerHatchingBatchStatus = {
  batchId: string; sourceSha256: string; phase: 'publishing' | 'complete'; prepared: true;
  readyCount: number; grailCount: number; freshEggCount: number; ready: number; hatched: number;
  published: number; pendingPublication: number; conflicts: number; pendingEnrichment: number; failedEnrichment: number;
};
export type OwnerHatchingResult =
  | { kind: 'hatched'; artwork: EthereumRevealedArtwork }
  | { kind: 'unavailable' | 'not-ready' };
export type OwnerHatchingEnrichmentError = 'invalid' | 'source-unavailable' | 'enrichment-failed';
export type OwnerHatchingEnrichment = {
  tokenId: string; category: OwnerHatchingAsset['category']; assetId: number; metadataRevision: number;
  baseJson: string; attempts: number; lastError: OwnerHatchingEnrichmentError | null;
};
export type OwnerHatchingEnrichmentSummary = {
  pending: number; failed: number; completed: number; errors: Partial<Record<OwnerHatchingEnrichmentError, number>>;
};

type BatchRow = {
  batch_id: string; source_sha256: string; input_sha256: string; ready_count: number; grail_count: number;
  fresh_egg_count: number; created_at_ms: number;
};
type TokenRow = {
  token_id: string; batch_id: string; egg_id: number; original_json: string;
  grail_category: OwnerHatchingAsset['category'] | null; grail_asset_id: number | null;
  status: 'ready' | 'hatched'; canonical_json: string; metadata_revision: number; hatched_at_ms: number | null;
};
type PublicationRow = {
  token_id: string; metadata_revision: number; status: 'pending' | 'published' | 'conflict';
  attempts: number; next_check_ms: number; claim_id: string | null;
};

const SHA256 = /^[a-f0-9]{64}$/;
const CATEGORIES = new Set(['painting', 'video', '3d', 'animated']);
const ENRICHMENT_CLAIM_MS = 60_000;
const hash = (value: string) => bytesToHex(sha256(value));
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS owner_hatching_batches (
    batch_id TEXT PRIMARY KEY,source_sha256 TEXT NOT NULL,input_sha256 TEXT NOT NULL,
    ready_count INTEGER NOT NULL CHECK(ready_count>0),grail_count INTEGER NOT NULL CHECK(grail_count>=0 AND grail_count<=ready_count),
    fresh_egg_count INTEGER NOT NULL CHECK(fresh_egg_count=ready_count-grail_count),created_at_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_grails (
    category TEXT NOT NULL,asset_id INTEGER NOT NULL,batch_id TEXT NOT NULL REFERENCES owner_hatching_batches(batch_id),
    attributes_json TEXT,PRIMARY KEY(category,asset_id))`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_tokens (
    token_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES owner_hatching_batches(batch_id),egg_id INTEGER NOT NULL UNIQUE,
    original_json TEXT NOT NULL,grail_category TEXT,grail_asset_id INTEGER,status TEXT NOT NULL CHECK(status IN ('ready','hatched')),
    canonical_json TEXT NOT NULL,metadata_revision INTEGER NOT NULL,hatched_at_ms INTEGER,
    CHECK((grail_category IS NULL)=(grail_asset_id IS NULL)),
    CHECK((status='hatched')=(hatched_at_ms IS NOT NULL)),
    FOREIGN KEY(grail_category,grail_asset_id) REFERENCES owner_hatching_grails(category,asset_id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS owner_hatching_grail_token ON owner_hatching_tokens(grail_category,grail_asset_id)
    WHERE grail_asset_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS owner_hatching_ready ON owner_hatching_tokens(status,CAST(token_id AS INTEGER))`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_fresh_eggs (
    egg_id INTEGER PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES owner_hatching_batches(batch_id),
    token_id TEXT UNIQUE REFERENCES owner_hatching_tokens(token_id))`,
  `CREATE INDEX IF NOT EXISTS owner_hatching_fresh_batch ON owner_hatching_fresh_eggs(batch_id,egg_id) WHERE token_id IS NULL`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_retired_eggs (
    egg_id INTEGER PRIMARY KEY,token_id TEXT NOT NULL UNIQUE REFERENCES owner_hatching_tokens(token_id),retired_at_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_artwork_claims (
    category TEXT NOT NULL,asset_id INTEGER NOT NULL,token_id TEXT NOT NULL UNIQUE REFERENCES owner_hatching_tokens(token_id),
    claimed_at_ms INTEGER NOT NULL,PRIMARY KEY(category,asset_id))`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_slot_overrides (
    origin_category TEXT NOT NULL,origin_asset_id INTEGER NOT NULL,category TEXT NOT NULL,asset_id INTEGER NOT NULL,
    token_id TEXT NOT NULL REFERENCES owner_hatching_tokens(token_id),
    PRIMARY KEY(origin_category,origin_asset_id),UNIQUE(category,asset_id))`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_slot_history (
    token_id TEXT NOT NULL REFERENCES owner_hatching_tokens(token_id),origin_category TEXT NOT NULL,origin_asset_id INTEGER NOT NULL,
    category TEXT NOT NULL,asset_id INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(token_id,origin_category,origin_asset_id))`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_enrichment (
    token_id TEXT PRIMARY KEY REFERENCES owner_hatching_tokens(token_id),metadata_revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete')),
    attempts INTEGER NOT NULL DEFAULT 0,next_check_ms INTEGER NOT NULL DEFAULT 0,last_error TEXT)`,
  `CREATE INDEX IF NOT EXISTS owner_hatching_enrichment_due ON owner_hatching_enrichment(status,next_check_ms)`,
  `CREATE TABLE IF NOT EXISTS owner_hatching_publication (
    token_id TEXT PRIMARY KEY REFERENCES owner_hatching_tokens(token_id),metadata_revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','conflict')),
    attempts INTEGER NOT NULL DEFAULT 0,next_check_ms INTEGER NOT NULL DEFAULT 0,claim_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS owner_hatching_publication_due ON owner_hatching_publication(status,next_check_ms)`,
  `CREATE TRIGGER IF NOT EXISTS owner_hatching_batch_immutable BEFORE UPDATE ON owner_hatching_batches
    BEGIN SELECT RAISE(ABORT,'Owner hatching batch is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS owner_hatching_token_identity BEFORE UPDATE ON owner_hatching_tokens
    WHEN NEW.token_id IS NOT OLD.token_id OR NEW.batch_id IS NOT OLD.batch_id OR NEW.egg_id IS NOT OLD.egg_id
      OR NEW.original_json IS NOT OLD.original_json OR NEW.grail_category IS NOT OLD.grail_category OR NEW.grail_asset_id IS NOT OLD.grail_asset_id
      OR NEW.status!='hatched' OR NEW.metadata_revision<=OLD.metadata_revision
      OR (OLD.status='hatched' AND (NEW.hatched_at_ms IS NOT OLD.hatched_at_ms
        OR json_extract(NEW.canonical_json,'$.category') IS NOT json_extract(OLD.canonical_json,'$.category')
        OR json_extract(NEW.canonical_json,'$.assetId') IS NOT json_extract(OLD.canonical_json,'$.assetId')))
    BEGIN SELECT RAISE(ABORT,'Owner hatching result is immutable'); END`,
  ...['owner_hatching_batches', 'owner_hatching_grails', 'owner_hatching_tokens', 'owner_hatching_fresh_eggs',
    'owner_hatching_retired_eggs', 'owner_hatching_artwork_claims', 'owner_hatching_slot_history'].map(table =>
    `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Owner hatching history cannot be deleted'); END`),
  ...['owner_hatching_grails', 'owner_hatching_retired_eggs', 'owner_hatching_artwork_claims', 'owner_hatching_slot_history'].map(table =>
    `CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Owner hatching history is immutable'); END`),
  `CREATE TRIGGER IF NOT EXISTS owner_hatching_fresh_once BEFORE UPDATE ON owner_hatching_fresh_eggs
    WHEN NEW.egg_id IS NOT OLD.egg_id OR NEW.batch_id IS NOT OLD.batch_id OR OLD.token_id IS NOT NULL OR NEW.token_id IS NULL
    BEGIN SELECT RAISE(ABORT,'Fresh egg can only be used once'); END`,
];

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
  private schemaAvailable: boolean;
  private readonly transaction: <T>(action: () => T) => T;

  constructor(private readonly sql: RevealSql, transaction: <T>(action: () => T) => T,
    private readonly hooks: OwnerHatchingHooks, private readonly randomInteger = revealRandomInteger) {
    this.schemaAvailable = this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='owner_hatching_tokens'").toArray().length > 0;
    let depth = 0;
    this.transaction = <T>(action: () => T): T => {
      if (depth) return action();
      return transaction(() => {
        depth++;
        try { return action(); } finally { depth--; }
      });
    };
  }

  get available(): boolean {
    if (!this.schemaAvailable) this.schemaAvailable = this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='owner_hatching_tokens'").toArray().length > 0;
    return this.schemaAvailable;
  }

  initialize(): void {
    if (this.initialized) return;
    this.transaction(() => {
      for (const statement of SCHEMA) this.sql.exec(statement);
      if (!this.sql.exec<{ name: string }>('PRAGMA table_info(owner_hatching_enrichment)').toArray().some(row => row.name === 'last_error')) {
        this.sql.exec('ALTER TABLE owner_hatching_enrichment ADD COLUMN last_error TEXT');
      }
    });
    this.schemaAvailable = true;
    this.initialized = true;
  }

  private token(tokenId: string): TokenRow | undefined {
    if (!this.available) return;
    return this.sql.exec<TokenRow>('SELECT * FROM owner_hatching_tokens WHERE token_id=?', tokenId).toArray()[0];
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

  private overrideSlot(origin: RevealOriginUnit, asset: RevealOriginUnit, tokenId: string, now: number): void {
    this.sql.exec(`INSERT INTO owner_hatching_slot_history(token_id,origin_category,origin_asset_id,category,asset_id,created_at_ms)
      VALUES(?,?,?,?,?,?)`, tokenId, origin.category, origin.assetId, asset.category, asset.assetId, now);
    this.sql.exec(`INSERT INTO owner_hatching_slot_overrides(origin_category,origin_asset_id,category,asset_id,token_id)
      VALUES(?,?,?,?,?) ON CONFLICT(origin_category,origin_asset_id)
      DO UPDATE SET category=excluded.category,asset_id=excluded.asset_id,token_id=excluded.token_id`,
      origin.category, origin.assetId, asset.category, asset.assetId, tokenId);
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
        const rows = this.sql.exec<Pick<TokenRow, 'token_id' | 'canonical_json'>>(
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
      ? this.sql.exec<BatchRow>('SELECT * FROM owner_hatching_batches ORDER BY created_at_ms DESC,batch_id DESC LIMIT 1')
      : this.sql.exec<BatchRow>('SELECT * FROM owner_hatching_batches WHERE batch_id=?', batchId)).toArray()[0];
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

  eligibleCandidate(tokenId: string): OwnerHatchingCanonical | null {
    if (this.token(tokenId)) return null;
    const canonical = this.hooks.canonical(tokenId);
    return canonical?.category === 'egg' && !this.hasProtectedEgg(canonical.assetId) &&
      this.hooks.eligibleEgg(tokenId, canonical.assetId) ? canonical : null;
  }

  prepare(input: OwnerHatchingBatchInput, now = Date.now()): OwnerHatchingBatchStatus {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.batchId) || !SHA256.test(input.sourceSha256) ||
      !integer(input.readyCount) || !integer(now, Number.MAX_SAFE_INTEGER) || !Array.isArray(input.candidateTokenIds) ||
      input.candidateTokenIds.length > 111_111 || input.candidateTokenIds.some(id => !/^[1-9]\d*$/.test(id) || !integer(Number(id))) ||
      new Set(input.candidateTokenIds).size !== input.candidateTokenIds.length || !Array.isArray(input.grails) ||
      input.grails.length > input.readyCount || input.grails.some(asset => !validAsset(asset)) ||
      new Set(input.grails.map(asset => `${asset.category}:${asset.assetId}`)).size !== input.grails.length ||
      !Array.isArray(input.freshEggIds) || input.freshEggIds.length !== input.readyCount - input.grails.length ||
      input.freshEggIds.some(id => !integer(id)) || new Set(input.freshEggIds).size !== input.freshEggIds.length) {
      throw new Error('Invalid owner hatching batch.');
    }
    const inputSha256 = hash(JSON.stringify({ sourceSha256: input.sourceSha256, readyCount: input.readyCount,
      candidateTokenIds: [...input.candidateTokenIds].sort((a, b) => Number(a) - Number(b)),
      grails: [...input.grails].sort((a, b) => a.category.localeCompare(b.category) || a.assetId - b.assetId),
      freshEggIds: [...input.freshEggIds].sort((a, b) => a - b) }));
    return this.transaction(() => {
      const existing = this.sql.exec<BatchRow>('SELECT * FROM owner_hatching_batches WHERE batch_id=?', input.batchId).toArray()[0];
      if (existing) {
        if (existing.input_sha256 !== inputSha256) throw new Error('Owner hatching batch replay changed.');
        return this.batchStatus(input.batchId)!;
      }
      if (input.grails.some(asset => this.reservedGrail(asset) || this.claimedArtwork(asset)) ||
        input.freshEggIds.some(id => this.usedFreshEgg(id) || this.hasProtectedEgg(id) || !this.hooks.freshEggAvailable(id))) {
        throw new Error('Owner hatching batch contains unavailable assets.');
      }
      const candidates = [...input.candidateTokenIds];
      const selected: OwnerHatchingCanonical[] = [];
      while (candidates.length && selected.length < input.readyCount) {
        const index = this.randomInteger(candidates.length);
        const tokenId = candidates[index];
        candidates[index] = candidates[candidates.length - 1];
        candidates.pop();
        const canonical = this.eligibleCandidate(tokenId);
        if (!canonical) continue;
        selected.push(canonical);
      }
      if (selected.length !== input.readyCount) throw new Error('Not enough eligible minted eggs.');
      const grails = [...input.grails];
      for (let index = grails.length - 1; index > 0; index--) {
        const other = this.randomInteger(index + 1);
        [grails[index], grails[other]] = [grails[other], grails[index]];
      }
      this.sql.exec(`INSERT INTO owner_hatching_batches(batch_id,source_sha256,input_sha256,ready_count,grail_count,fresh_egg_count,created_at_ms)
        VALUES(?,?,?,?,?,?,?)`, input.batchId, input.sourceSha256, inputSha256, input.readyCount, grails.length, input.freshEggIds.length, now);
      for (const grail of grails) this.sql.exec('INSERT INTO owner_hatching_grails(category,asset_id,batch_id,attributes_json) VALUES(?,?,?,?)',
        grail.category, grail.assetId, input.batchId, grail.attributesJson ?? null);
      for (const eggId of input.freshEggIds) this.sql.exec('INSERT INTO owner_hatching_fresh_eggs(egg_id,batch_id) VALUES(?,?)', eggId, input.batchId);
      for (let index = 0; index < selected.length; index++) {
        const original = selected[index], grail = grails[index];
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
      return this.batchStatus(input.batchId)!;
    });
  }

  hatch(tokenId: string, now = Date.now()): OwnerHatchingResult {
    return this.transaction(() => {
      const token = this.token(tokenId);
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
        asset = { category: token.grail_category, assetId: token.grail_asset_id,
          ...(grail.attributes_json === null ? {} : { attributesJson: grail.attributes_json }) };
      } else {
        const fresh = this.sql.exec<{ egg_id: number }>(
          'SELECT egg_id FROM owner_hatching_fresh_eggs WHERE batch_id=? AND token_id IS NULL ORDER BY egg_id LIMIT 1', token.batch_id).toArray()[0];
        if (!fresh) return { kind: 'unavailable' };
        const chosen = this.hooks.takeOrdinary();
        if (!chosen) return { kind: 'unavailable' };
        asset = chosen.effective;
        if (!validAsset(asset) || this.reservedGrail(asset) || this.claimedArtwork(asset)) throw new Error('Ordinary hatch selected unavailable artwork.');
        this.sql.exec('UPDATE owner_hatching_fresh_eggs SET token_id=? WHERE egg_id=? AND token_id IS NULL', tokenId, fresh.egg_id);
        this.overrideSlot(chosen.origin, { category: 'egg', assetId: fresh.egg_id }, tokenId, now);
        this.hooks.transitionSlot(chosen.origin, chosen.effective, { category: 'egg', assetId: fresh.egg_id });
        replacement = { origin: chosen.origin, eggId: fresh.egg_id };
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
      if (replacement && asset.attributesJson === undefined) {
        this.sql.exec('INSERT INTO owner_hatching_enrichment(token_id,metadata_revision) VALUES(?,?)', tokenId, metadataRevision);
      }
      return { kind: 'hatched', artwork };
    });
  }

  claimPublications(now: number, limit = 8): RevealPublicationJob[] {
    if (!integer(limit, 64)) throw new Error('Invalid owner publication batch size.');
    return this.transaction(() => {
      const rows = this.sql.exec<PublicationRow>(`SELECT * FROM owner_hatching_publication
        WHERE status='pending' AND next_check_ms<=? ORDER BY next_check_ms,CAST(token_id AS INTEGER) LIMIT ?`, now, limit).toArray();
      const claimId = crypto.randomUUID();
      return rows.map(row => {
        const canonical = this.canonical(row.token_id)!;
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
        const current = this.canonical(job.token_id);
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
        const canonical = this.canonical(row.token_id)!;
        if (canonical.category === 'egg') throw new Error('Hatched artwork cannot be an egg.');
        this.sql.exec('UPDATE owner_hatching_enrichment SET next_check_ms=?,attempts=attempts+1 WHERE token_id=?', now + ENRICHMENT_CLAIM_MS, row.token_id);
        return { tokenId: row.token_id, category: canonical.category, assetId: canonical.assetId,
          metadataRevision: row.metadata_revision, baseJson: canonical.metadataJson, attempts: row.attempts + 1, lastError: row.last_error };
      });
    });
  }

  acceptEnrichment(tokenId: string, expectedRevision: number, metadataJson: string, metadataSha256 = hash(metadataJson)): boolean {
    return this.transaction(() => {
      const token = this.token(tokenId);
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

  enrichmentSummary(batchId?: string): OwnerHatchingEnrichmentSummary {
    const summary: OwnerHatchingEnrichmentSummary = { pending: 0, failed: 0, completed: 0, errors: {} };
    if (!this.available) return summary;
    const lastError = this.initialized || this.sql.exec<{ name: string }>('PRAGMA table_info(owner_hatching_enrichment)')
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
    const enrichment = row.enrichment === null ? null : Math.max(row.enrichment, enrichmentBusy ? now + ENRICHMENT_CLAIM_MS : now);
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
