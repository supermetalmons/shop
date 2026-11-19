import { createHash } from 'node:crypto';
import { MAINNET_111K_ARTISTS_SHA256, getMainnet111kArtists } from '../../../../shared/ethereum/mainnet111kArtists.js';
import { getOwnerHatchingGrail } from '../../../../shared/ethereum/ownerHatchingCatalog.js';
import { lookupRevealCollectionBlock } from '../../../../shared/ethereum/revealCollectionBlocks.js';
import { readEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { requireArtistMetadataScope, type ArtistMetadataEvidence, type ArtistMetadataPage,
  type ArtistMetadataRequest } from '../../../../shared/ethereum/artistMetadataMaintenance.js';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.js';
import { parseMetadataJson } from './ethereumMetadataJson.js';
import { MAX_REVEAL_METADATA_BYTES } from './ethereumRevealAttributes.js';
import type { EthereumRevealCatalogReader } from './ethereumRevealCatalogReader.js';
import { revealCollectionBlocks } from './ethereumRevealCollectionBlocks.js';
import type { RevealCanonicalMetadata } from './ethereumRevealCatalogTypes.js';
import { acknowledgeRevealArtistAnnotation, initializeRevealArtistAnnotations, readRevealArtistAnnotation,
  stageRevealArtistAnnotation } from './ethereumRevealArtistAnnotations.js';
import { putRevealMetadataConditionally, REVEAL_JSON_HTTP_METADATA } from './ethereumRevealMetadataWrite.js';
import type { RevealSql } from './ethereumRevealStore.js';

const hash = (json: string | ArrayBuffer) => createHash('sha256').update(typeof json === 'string' ? json : new Uint8Array(json)).digest('hex');
const WRITE_CONCURRENCY = 6;
const REGISTRY_CHECK_INTERVAL = 30;
const REGISTRY_MAX_AGE_MS = 3_000;
type Candidate = { token_id: string; published: number };
type MetadataFields = { attributes: Record<string, unknown>[]; [key: string]: unknown };
type CandidateResult = { status: 'egg' | 'credited' | 'published' | 'deferred' | 'conflict'; evidence?: ArtistMetadataEvidence };
type Host = {
  sql: RevealSql; transaction<T>(fn: () => T): T; reader: EthereumRevealCatalogReader;
  bucket: Pick<R2Bucket, 'get' | 'put'>;
  current(): Promise<EthereumRevealDeployment>;
};

export async function currentArtistMetadataDeployment(db: D1Database, request: ArtistMetadataRequest): Promise<EthereumRevealDeployment> {
  if (request.scope.mappingSha256 !== MAINNET_111K_ARTISTS_SHA256) throw new Error('Artist metadata mapping checksum changed.');
  const deployment = await readEthereumRevealDeployment(db, request.scope);
  requireArtistMetadataScope(deployment, request.scope);
  return deployment;
}

function parseMetadata(json: string): MetadataFields {
  const value = parseMetadataJson(json);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('attributes' in value) || !Array.isArray(value.attributes) ||
    value.attributes.some(trait => !trait || typeof trait !== 'object' || Array.isArray(trait))) throw new Error('Invalid canonical artist metadata.');
  return value as MetadataFields;
}

function creditTraits(attributes: MetadataFields['attributes'], collectionBlock: string | null, artists: readonly string[]): boolean {
  const actualArtists = attributes.filter(trait => trait.trait_type === 'artist');
  if (collectionBlock === null) return !actualArtists.length;
  return attributes[0]?.trait_type === 'collection block' && attributes[0].value === collectionBlock &&
    attributes.filter(trait => trait.trait_type === 'collection block').length === 1 &&
    actualArtists.length === artists.length && artists.every((artist, index) =>
      actualArtists[index] === attributes[index + 1] && actualArtists[index].value === artist);
}

export class EthereumArtistMetadataOperation {
  constructor(private readonly host: Host) {}

  private checkLedger(deployment: EthereumRevealDeployment): void {
    const settings = this.host.reader.settings();
    const pinned = this.host.reader.effectiveCatalog();
    if (!settings || !this.host.sql.exec('SELECT 1 FROM settings WHERE id=1 AND ready=1').toArray().length ||
      settings.candidate_catalog_generation || !pinned || pinned.catalogRevision !== deployment.catalogRevision ||
      pinned.catalogVersion !== deployment.effectiveCatalogVersion || pinned.manifestSha256 !== deployment.effectiveCatalogSha256) {
      throw new Error('Artist metadata reveal ledger is not ready at the pinned catalog.');
    }
    const registered = JSON.parse(settings.deployment_json) as EthereumRevealDeployment;
    if (registered.deploymentId !== deployment.deploymentId || registered.chainId !== deployment.chainId ||
      registered.contractAddress !== deployment.contractAddress || registered.deploymentBlock !== deployment.deploymentBlock ||
      registered.metadataBaseUri !== deployment.metadataBaseUri || registered.catalogVersion !== deployment.catalogVersion) {
      throw new Error('Artist metadata reveal ledger identity changed.');
    }
  }

  private started(request: ArtistMetadataRequest): boolean {
    if (!this.host.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_artist_maintenance'").toArray().length) return false;
    const row = this.host.sql.exec<{ scope_json: string }>('SELECT scope_json FROM reveal_artist_maintenance WHERE operation_id=?',
      request.scope.operationId).toArray()[0];
    if (!row) return false;
    if (row.scope_json !== this.scopeJson(request)) throw new Error('Artist maintenance must resume with the pinned scope and cutoff.');
    return true;
  }

  private scopeJson(request: ArtistMetadataRequest): string {
    return JSON.stringify(Object.fromEntries(Object.entries(request.scope).sort(([a], [b]) => a.localeCompare(b))));
  }

  private candidates(request: ArtistMetadataRequest, cutoff: number): Candidate[] {
    const hasOwners = this.host.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='owner_hatching_tokens'").toArray().length > 0;
    const owners = hasOwners ? 'LEFT JOIN owner_hatching_tokens o ON o.token_id=page.token_id LEFT JOIN owner_hatching_publication op ON op.token_id=page.token_id' : '';
    const publication = hasOwners
      ? "CASE WHEN o.token_id IS NULL THEN p.status='published' ELSE op.metadata_revision=o.metadata_revision AND op.status='published' END"
      : "p.status='published'";
    const selector = request.retryTokenIds
      ? 'JOIN json_each(?) i ON i.value=a.token_id WHERE a.frozen_at_ms<=?'
      : 'WHERE a.frozen_at_ms<=? AND a.token_id>? ORDER BY a.token_id LIMIT ?';
    return this.host.sql.exec<Candidate>(`WITH page AS MATERIALIZED (SELECT a.token_id FROM assignments a ${selector})
      SELECT page.token_id,COALESCE(${publication},0) AS published
      FROM page LEFT JOIN publication p ON p.token_id=page.token_id ${owners} ORDER BY page.token_id`,
    ...(request.retryTokenIds ? [JSON.stringify(request.retryTokenIds), cutoff] : [cutoff, request.after ?? '', request.limit!])).toArray();
  }

  private async readObject(key: string) {
    const object = await this.host.bucket.get(key);
    if (!object || object.size > MAX_REVEAL_METADATA_BYTES ||
      object.httpMetadata?.contentType !== REVEAL_JSON_HTTP_METADATA.contentType ||
      object.httpMetadata.cacheControl !== REVEAL_JSON_HTTP_METADATA.cacheControl ||
      object.httpMetadata.contentEncoding) {
      if (object) await object.body.cancel();
      return;
    }
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== object.size) return;
    return { sha256: hash(bytes), etag: object.etag, customMetadata: object.customMetadata };
  }

  private evidence(current: RevealCanonicalMetadata, metadata: MetadataFields, collectionBlock: string | null,
    artists: readonly string[]): ArtistMetadataEvidence {
    const original = this.host.sql.exec<{ metadata_json: string }>('SELECT metadata_json FROM assignments WHERE token_id=?', current.tokenId).toArray()[0];
    if (!original) throw new Error('Artist metadata audit is missing a frozen assignment.');
    const { attributes, ...nonAttributes } = metadata;
    const nonArtist = { ...metadata, attributes: attributes.filter(trait => trait.trait_type !== 'artist') };
    return { tokenId: current.tokenId, category: current.category, assetId: current.assetId, assignmentRevision: current.assignmentRevision,
      metadataRevision: current.metadataRevision, metadataSha256: current.targetSha256, frozenMetadataSha256: hash(original.metadata_json),
      nonAttributeSha256: hash(JSON.stringify(nonAttributes)), nonArtistSha256: hash(JSON.stringify(nonArtist)),
      collectionBlock, artists: [...artists] };
  }

  private async token(deployment: EthereumRevealDeployment, row: Candidate, request: ArtistMetadataRequest, deadline: number,
    blocks: NonNullable<ReturnType<typeof revealCollectionBlocks>>, authorizeWrite: () => Promise<void>): Promise<CandidateResult> {
    if (!row.published || Date.now() >= deadline) return { status: 'deferred' };
    let current = this.host.reader.canonicalMetadata([row.token_id])[0];
    if (!current) return { status: 'conflict' };
    const egg = current.category === 'egg';
    if (egg && request.action === 'apply') return { status: 'egg' };
    const metadata = parseMetadata(current.metadataJson);
    const collectionBlock = egg ? null : getOwnerHatchingGrail(current.category, current.assetId)?.collectionBlock
      ?? lookupRevealCollectionBlock(blocks, current.category, current.assetId);
    if (!egg && collectionBlock === null) return { status: 'conflict' };
    const artists = collectionBlock === null ? [] : getMainnet111kArtists(collectionBlock);
    const credited = creditTraits(metadata.attributes, collectionBlock, artists);
    const key = new URL(ethereumTokenMetadataUri(deployment, row.token_id)).pathname.slice(1);
    const object = await this.readObject(key);
    const latest = this.host.reader.canonicalMetadata([row.token_id])[0];
    if (!latest || current.targetSha256 !== latest.targetSha256 || current.metadataRevision !== latest.metadataRevision || Date.now() >= deadline) {
      return { status: 'deferred' };
    }
    const annotation = readRevealArtistAnnotation(this.host.sql, row.token_id);
    if (request.action === 'verify') {
      if (!credited || !object || annotation && !annotation.published) return { status: 'conflict' };
      if (object.sha256 !== current.targetSha256) {
        return { status: current.expectedJsons.some(json => hash(json) === object.sha256) ? 'deferred' : 'conflict' };
      }
      return { status: egg ? 'egg' : 'credited', evidence: this.evidence(current, metadata, collectionBlock, artists) };
    }
    if (!object) return { status: 'conflict' };
    if (object.sha256 === current.targetSha256 && credited) {
      if (annotation && !annotation.published) acknowledgeRevealArtistAnnotation(this.host.sql, row.token_id, annotation.operation_id);
      return { status: annotation?.operation_id === request.scope.operationId ? 'published' : 'credited' };
    }
    if (object.sha256 !== current.targetSha256 && (!annotation || annotation.published)) {
      return { status: current.expectedJsons.some(json => hash(json) === object.sha256) ? 'deferred' : 'conflict' };
    }
    if (annotation && !credited) return { status: 'conflict' };
    if (annotation && object.sha256 === annotation.predecessor_sha256 && object.etag !== annotation.predecessor_etag) {
      return { status: 'conflict' };
    }
    await authorizeWrite();
    const authorized = this.host.reader.canonicalMetadata([row.token_id])[0];
    if (!authorized || current.targetSha256 !== authorized.targetSha256 || current.metadataRevision !== authorized.metadataRevision ||
      Date.now() >= deadline) return { status: 'deferred' };
    if (!annotation) {
      const saved = this.host.transaction(() =>
        stageRevealArtistAnnotation(this.host.sql, authorized, collectionBlock!, artists, request.scope.operationId, object.etag));
      if (!saved) return { status: 'deferred' };
      const staged = this.host.reader.canonicalMetadata([row.token_id])[0];
      if (!staged) throw new Error('Artist metadata stage did not produce canonical metadata.');
      current = staged;
    }
    if (!current.expectedJsons.some(json => hash(json) === object.sha256)) return { status: 'conflict' };
    let written: R2Object | null;
    try {
      written = await putRevealMetadataConditionally(this.host.bucket, key, current.metadataJson, current.metadataRevision,
        { deploymentId: deployment.deploymentId, tokenId: row.token_id },
        { etag: object.etag, customMetadata: { ...object.customMetadata, sha256: current.targetSha256 } });
    } catch {
      return { status: 'deferred' };
    }
    if (!written) return { status: 'deferred' };
    const after = this.host.reader.canonicalMetadata([row.token_id])[0];
    if (after?.targetSha256 !== current.targetSha256 || after.metadataRevision !== current.metadataRevision) return { status: 'deferred' };
    acknowledgeRevealArtistAnnotation(this.host.sql, row.token_id, annotation?.operation_id ?? request.scope.operationId);
    return { status: 'published' };
  }

  async run(request: ArtistMetadataRequest): Promise<ArtistMetadataPage> {
    let registryCheckedAt = Date.now();
    const deployment = await this.host.current();
    this.checkLedger(deployment);
    let started = this.started(request);
    const frozenThroughMs = request.frozenThroughMs ?? request.scope.frozenThroughMs;
    const page: ArtistMetadataPage = { scope: request.scope, action: request.action, started, frozenThroughMs, next: null, scanned: 0,
      eggs: 0, credited: 0, published: 0, deferred: [], conflicts: [], records: [] };
    if (request.action === 'start' && !started) {
      this.host.transaction(() => {
        this.host.sql.exec(`CREATE TABLE IF NOT EXISTS reveal_artist_maintenance
          (operation_id TEXT PRIMARY KEY,scope_json TEXT NOT NULL)`);
        initializeRevealArtistAnnotations(this.host.sql);
        this.host.sql.exec('INSERT INTO reveal_artist_maintenance(operation_id,scope_json) VALUES(?,?)', request.scope.operationId, this.scopeJson(request));
      });
      page.started = started = true;
    }
    if (request.action === 'start' || request.action === 'inspect') return page;
    if (request.action === 'plan') {
      const tokenIds = this.host.sql.exec<{ token_id: string }>(
        'SELECT token_id FROM assignments WHERE frozen_at_ms<=? AND token_id>? ORDER BY token_id LIMIT ?',
        frozenThroughMs, request.after ?? '', request.limit!).toArray().map(row => row.token_id);
      return { ...page, scanned: tokenIds.length, plannedTokenIds: tokenIds,
        next: tokenIds.length === request.limit ? tokenIds.at(-1)! : null };
    }
    if (request.action === 'apply' && !started) throw new Error('Artist metadata apply requires its prepared on-chain preflight.');
    const blocks = revealCollectionBlocks(this.host.reader.effectiveCatalog());
    if (!blocks) throw new Error('Artist metadata catalog block coverage is unavailable.');
    const rows = this.candidates(request, frozenThroughMs);
    if (request.retryTokenIds && rows.length !== request.retryTokenIds.length) throw new Error('Artist retry contains a token outside the frozen cohort.');
    page.scanned = rows.length;
    page.next = !request.retryTokenIds && rows.length === request.limit ? rows.at(-1)!.token_id : null;
    let registryCheck: Promise<void> | undefined;
    const checkRegistry = (force = false) => {
      if (registryCheck) return registryCheck;
      if (!force && Date.now() - registryCheckedAt < REGISTRY_MAX_AGE_MS) return Promise.resolve();
      registryCheckedAt = Date.now();
      registryCheck = this.host.current().then(row => this.checkLedger(row)).finally(() => { registryCheck = undefined; });
      return registryCheck;
    };
    const concurrency = request.action === 'apply' ? WRITE_CONCURRENCY : 8;
    const deadline = Date.now() + 20_000;
    const results: CandidateResult[] = new Array(rows.length);
    let index = 0;
    let failure: { error: unknown } | undefined;
    const lane = async () => {
      while (index < rows.length && !failure) {
        const next = index++;
        try {
          if (request.action === 'apply' && next > 0 && next % REGISTRY_CHECK_INTERVAL === 0 && Date.now() < deadline) {
            await checkRegistry(true);
          }
          results[next] = await this.token(deployment, rows[next], request, deadline, blocks, checkRegistry);
        } catch (error) {
          failure = { error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, lane));
    if (failure) throw failure.error;
    for (const [offset, value] of results.entries()) {
      const tokenId = rows[offset].token_id;
      if (value.status === 'deferred') page.deferred.push(tokenId);
      else if (value.status === 'conflict') page.conflicts.push(tokenId);
      else if (value.status === 'egg') page.eggs++;
      else page[value.status]++;
      if (value.evidence) page.records.push(value.evidence);
    }
    await checkRegistry(true);
    return page;
  }
}
