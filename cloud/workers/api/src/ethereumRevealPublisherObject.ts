import { DurableObject } from 'cloudflare:workers';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.js';
import { normalizeEthereumAddress } from '../../../../shared/ethereum/protocol.js';
import { readEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { getRevealCatalog } from '../../../../shared/ethereum/revealCatalogRegistry.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import type { EthereumArtworkCategory } from '../../../../shared/ethereum/reveal.js';
import { REVEAL_ENRICHMENT_SLOTS } from './ethereumRevealEnrichmentStore.js';
import { attributePublisherName, fetchRevealAttributes, InvalidRevealAttributes, MAX_REVEAL_METADATA_BYTES,
  RevealAttributeSourceUnavailable } from './ethereumRevealAttributes.js';
import type { RevealPublicationJob } from './ethereumRevealStore.js';
import { requireRetiredRevealDeployment, requireRevealObjectIdentity } from './ethereumRevealMaintenanceSupport.js';
import { revealDeploymentCatalog } from './ethereumRevealCatalog.js';
import { MAX_RELIC_METADATA_BYTES, parseRelicImagesRequest, prepareRelicImagePatch, RELIC_IMAGE_TOKEN_IDS,
  type RelicImagePatch, type RelicImagesRequest, type RelicImagesResult } from '../../../../shared/ethereum/relicImages.js';
import { requireRelicImagesDeployment } from './ethereumRelicImages.js';

export type PublicationScope = Pick<EthereumRevealDeployment, 'deploymentId' | 'chainId' | 'contractAddress' | 'metadataBaseUri'>;
export type RevealPublicationOutcome = { tokenId: string; status: 'published' | 'conflict' | 'retry' | 'superseded' };
export type MetadataWrite = { tokenId: string; metadataRevision: number; metadataJson: string; expectedJsons: string[]; allowMissing: boolean };
type PublicationLane = 'normal' | 'replacement';
type PendingPublication = { identity: string; revision: number; lane: PublicationLane; result: Promise<RevealPublicationOutcome> };
export type PreparedAttributes = { status: 'prepared'; metadataJson: string; metadataSha256: string } | { status: 'invalid' | 'source-unavailable' };
type AttributePreparation = { category: EthereumArtworkCategory; assetId: number; baseJson: string; catalogVersion?: string; catalogSha256?: string };
type AttributeWrite = { tokenId: string; baseJson: string; metadataJson: string; metadataRevision: number };
const JSON_HTTP_METADATA = { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } as const;

export class EthereumRevealPublisherObject extends DurableObject<Env> {
  private readonly publications = new Map<string, PendingPublication>();
  private readonly storageOperations = new Set<Promise<unknown>>();
  private readonly sourceStop = new AbortController();
  private readonly sourceReads = new Set<Promise<unknown>>();
  private resetting = false;
  private retiring = false;
  private relicMaintenance: Promise<RelicImagesResult> | null = null;

  relicImages(value: unknown, deadlineMs = Date.now() + 25_000): Promise<RelicImagesResult> {
    const request = parseRelicImagesRequest(value);
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL_PUBLISHER, request.scope);
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() || this.retiring || this.resetting || this.relicMaintenance) {
      throw new Error('Relic image publisher is unavailable or already running maintenance.');
    }
    const work = this.maintainRelicImages(request, Math.min(deadlineMs, Date.now() + 25_000))
      .finally(() => { this.relicMaintenance = null; });
    this.relicMaintenance = work;
    this.ctx.waitUntil(work.then(() => undefined, () => undefined));
    return work;
  }

  private async maintainRelicImages(request: RelicImagesRequest, deadlineMs: number): Promise<RelicImagesResult> {
    const timeout = createTimedAbortScope(undefined, { timeoutMs: Math.max(1, deadlineMs - Date.now()),
      timeoutMessage: 'Relic image publication timed out.' });
    const signal = timeout.signal;
    const requireCurrent = async () => {
      signal.throwIfAborted();
      if (this.retiring || this.resetting || Date.now() >= deadlineMs) throw new Error('Relic image publisher is unavailable.');
      await raceWithSignal(requireRelicImagesDeployment(this.env, request.scope), signal);
      signal.throwIfAborted();
      if (this.retiring || this.resetting || Date.now() >= deadlineMs) throw new Error('Relic image publisher is unavailable.');
    };
    const read = async (tokenId: string) => {
      signal.throwIfAborted();
      const key = new URL(ethereumTokenMetadataUri(request.scope, tokenId)).pathname.slice(1);
      const object = await raceWithSignal(this.trackStorage(this.env.ETHEREUM_REVEAL_METADATA.get(key)), signal);
      if (!object || object.size > MAX_RELIC_METADATA_BYTES) throw new Error('Relic metadata is missing or oversized.');
      if (object.httpMetadata?.contentType !== JSON_HTTP_METADATA.contentType ||
        object.httpMetadata.cacheControl !== JSON_HTTP_METADATA.cacheControl || object.httpMetadata.contentEncoding !== undefined) {
        throw new Error('Relic metadata HTTP headers are not canonical.');
      }
      const bytes = await raceWithSignal(this.trackStorage(object.arrayBuffer()), signal);
      if (bytes.byteLength !== object.size || bytes.byteLength > MAX_RELIC_METADATA_BYTES) throw new Error('Relic metadata size is invalid.');
      const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      signal.throwIfAborted();
      return { key, object, json };
    };
    try {
      await requireCurrent();
      if (request.action === 'inspect') {
        const objects: RelicImagePatch[] = [];
        for (const tokenId of RELIC_IMAGE_TOKEN_IDS) {
          if (this.retiring || this.resetting) throw new Error('Relic image publisher is unavailable.');
          const { object, json } = await read(tokenId);
          objects.push(prepareRelicImagePatch(tokenId, json, object.etag, request.field));
        }
        await requireCurrent();
        return { action: 'inspect', objects };
      }
      const patch = request.patch;
      const { key, object, json } = await read(patch.tokenId);
      await requireCurrent();
      if (json === patch.afterJson) return { action: 'apply', tokenId: patch.tokenId, status: 'unchanged' };
      if (json !== patch.beforeJson || object.etag !== patch.etag) throw new Error('Relic metadata changed since preparation.');
      const written = await raceWithSignal(this.trackStorage(this.env.ETHEREUM_REVEAL_METADATA.put(key, patch.afterJson, {
        onlyIf: { etagMatches: patch.etag }, httpMetadata: JSON_HTTP_METADATA,
        customMetadata: { ...object.customMetadata, sha256: patch.afterSha256 },
      })), signal);
      if (!written) throw new Error('Relic metadata conditional write conflicted.');
      await requireCurrent();
      return { action: 'apply', tokenId: patch.tokenId, status: 'updated' };
    } catch (error) {
      if (timeout.timedOut() && !this.resetting) {
        this.resetting = true;
        this.ctx.abort('Relic image publication I/O timed out.');
      }
      throw error;
    } finally { timeout.dispose(); }
  }

  publishBatch(scope: PublicationScope, jobs: RevealPublicationJob[], deadlineMs = Date.now() + 25_000): Promise<RevealPublicationOutcome[]> {
    if (!Array.isArray(jobs) || jobs.length > 8) throw new Error('Invalid reveal publication batch.');
    return this.publishJobs(scope, jobs.map(job => ({ write: {
      tokenId: job.token_id, metadataRevision: job.metadata_revision ?? 0, metadataJson: job.metadata_json,
      expectedJsons: job.expected_jsons_json === undefined ? [job.placeholder_json] : JSON.parse(job.expected_jsons_json),
      allowMissing: job.allow_missing === undefined ? true : Boolean(job.allow_missing),
    }, lane: job.migration ? 'replacement' : 'normal' })), deadlineMs);
  }

  async prepareAttributes(scope: PublicationScope, job: AttributePreparation, deadlineMs: number): Promise<PreparedAttributes> {
    if (!this.isAttributePublisher(scope)) throw new Error('Attribute publisher object does not match the registered deployment.');
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() || this.retiring ||
      this.resetting || this.sourceReads.size >= REVEAL_ENRICHMENT_SLOTS) return { status: 'source-unavailable' };
    const timeout = createTimedAbortScope(this.sourceStop.signal, { timeoutMs: Math.min(25_000, deadlineMs - Date.now()),
      timeoutMessage: 'Reveal attribute preparation timed out.' });
    const prepare = async () => {
      const deployment = await this.requireCurrentScope(scope, timeout.signal);
      const catalog = job.catalogVersion ? getRevealCatalog(job.catalogVersion, job.catalogSha256) : revealDeploymentCatalog(deployment);
      if (!catalog) throw new RevealAttributeSourceUnavailable('catalog-unavailable');
      timeout.signal.throwIfAborted();
      return fetchRevealAttributes(job.category, job.assetId, job.baseJson, timeout.signal, fetch, catalog);
    };
    const work = prepare().finally(() => { this.sourceReads.delete(work); });
    this.sourceReads.add(work);
    this.ctx.waitUntil(work.then(() => undefined, () => undefined));
    try {
      return { status: 'prepared', ...await raceWithSignal(work, timeout.signal) };
    } catch (error) {
      const status = error instanceof InvalidRevealAttributes ? 'invalid' : 'source-unavailable';
      const reason = error instanceof RevealAttributeSourceUnavailable ? error.reason :
        error instanceof InvalidRevealAttributes ? 'invalid-local-attributes' : timeout.timedOut() ? 'source-timeout' : 'preparation-unavailable';
      console.error({ event: 'ethereum_reveal_attribute_preparation_error', deploymentId: scope.deploymentId, status, reason });
      return { status };
    } finally { timeout.dispose(); }
  }

  async publishAttributes(scope: PublicationScope, job: AttributeWrite, deadlineMs: number): Promise<RevealPublicationOutcome> {
    if (this.retiring || this.resetting) return { tokenId: job.tokenId, status: 'retry' };
    if (this.isAttributePublisher(scope)) {
      return this.env.ETHEREUM_REVEAL_PUBLISHER.getByName(`${scope.chainId}:${scope.contractAddress}`).publishAttributes(scope, job, deadlineMs);
    }
    const [outcome] = await this.publishJobs(scope, [{ write: { tokenId: job.tokenId, metadataRevision: job.metadataRevision,
      expectedJsons: [job.baseJson], allowMissing: false, metadataJson: job.metadataJson }, lane: 'normal' }], deadlineMs);
    return outcome;
  }

  private publishJobs(scope: PublicationScope, jobs: Array<{ write: MetadataWrite; lane: PublicationLane }>, deadlineMs: number): Promise<RevealPublicationOutcome[]> {
    if (!Number.isSafeInteger(deadlineMs) || !scope.deploymentId || normalizeEthereumAddress(scope.contractAddress) !== scope.contractAddress) {
      throw new Error('Invalid reveal publication batch.');
    }
    const encoder = new TextEncoder();
    for (const { write: job } of jobs) {
      ethereumTokenMetadataUri(scope, job.tokenId);
      if (BigInt(job.tokenId) > 111_111n || !Number.isSafeInteger(job.metadataRevision) || job.metadataRevision < 0 ||
        !Array.isArray(job.expectedJsons) || job.expectedJsons.length > 4 || typeof job.allowMissing !== 'boolean' ||
        [job.metadataJson, ...job.expectedJsons].some(json => typeof json !== 'string' ||
          json.length > MAX_REVEAL_METADATA_BYTES || encoder.encode(json).byteLength > MAX_REVEAL_METADATA_BYTES)) {
        throw new Error('Invalid reveal publication metadata.');
      }
    }
    return this.authorize(scope, jobs, Math.min(deadlineMs, Date.now() + 25_000));
  }

  private async authorize(scope: PublicationScope, jobs: Array<{ write: MetadataWrite; lane: PublicationLane }>, deadline: number): Promise<RevealPublicationOutcome[]> {
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL_PUBLISHER, scope);
    if (this.retiring || this.resetting || deadline <= Date.now()) return jobs.map(({ write: job }) => ({ tokenId: job.tokenId, status: 'retry' }));
    const timeout = createTimedAbortScope(undefined, { timeoutMs: Math.max(1, deadline - Date.now()),
      timeoutMessage: 'Reveal publication authorization timed out.' });
    try {
      await this.requireCurrentScope(scope, timeout.signal);
      return await Promise.all(jobs.map(async ({ write: job, lane }) =>
        await this.isCurrentPublication(scope, job, timeout.signal) ? this.start(scope, job, deadline, lane) : { tokenId: job.tokenId, status: 'superseded' as const }));
    } finally { timeout.dispose(); }
  }

  private async requireCurrentScope(scope: PublicationScope, signal: AbortSignal): Promise<EthereumRevealDeployment> {
    const deployment = await raceWithSignal(readEthereumRevealDeployment(this.env.OPS_DB, scope), signal);
    if (deployment?.retiredAtMs != null) this.retiring = true;
    if (this.retiring || !deployment || deployment.deploymentId !== scope.deploymentId || deployment.metadataBaseUri !== scope.metadataBaseUri) {
      throw new Error('Reveal publication scope is not current and registered.');
    }
    revealDeploymentCatalog(deployment);
    return deployment;
  }

  private isCurrentPublication(scope: PublicationScope, job: MetadataWrite, signal: AbortSignal): Promise<boolean> {
    return raceWithSignal(this.env.ETHEREUM_REVEAL.getByName(`${scope.chainId}:${scope.contractAddress}`).validatePublication(scope, job), signal);
  }

  private isAttributePublisher(scope: Pick<PublicationScope, 'chainId' | 'contractAddress'>): boolean {
    return this.ctx.id.equals(this.env.ETHEREUM_REVEAL_PUBLISHER.idFromName(attributePublisherName(scope)));
  }

  private start(scope: PublicationScope, job: MetadataWrite, deadlineMs: number, lane: PublicationLane): Promise<RevealPublicationOutcome> {
    if (this.retiring || this.resetting) return Promise.resolve({ tokenId: job.tokenId, status: 'retry' });
    const key = `${scope.chainId}:${scope.contractAddress}:${job.tokenId}`;
    const identity = JSON.stringify([scope.deploymentId, scope.metadataBaseUri, job.tokenId, job.metadataRevision,
      job.metadataJson, job.expectedJsons, job.allowMissing]);
    const existing = this.publications.get(key);
    if (existing) return existing.identity === identity ? existing.result : Promise.resolve({ tokenId: job.tokenId,
      status: existing.revision === job.metadataRevision ? 'conflict' : existing.revision > job.metadataRevision ? 'superseded' : 'retry' });
    const active = [...this.publications.values()].filter(entry => entry.lane === lane).length;
    if (active >= (lane === 'replacement' ? 2 : 8) || deadlineMs <= Date.now()) return Promise.resolve({ tokenId: job.tokenId, status: 'retry' });
    const result = this.publish(scope, job, deadlineMs).finally(() => { this.publications.delete(key); });
    this.publications.set(key, { identity, revision: job.metadataRevision, lane, result });
    this.ctx.waitUntil(result);
    return result;
  }

  private trackStorage<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => { this.storageOperations.delete(tracked); });
    this.storageOperations.add(tracked);
    this.ctx.waitUntil(tracked.then(() => undefined, () => undefined));
    return tracked;
  }

  private async publish(scope: PublicationScope, job: MetadataWrite, deadlineMs: number): Promise<RevealPublicationOutcome> {
    const key = new URL(ethereumTokenMetadataUri(scope, job.tokenId)).pathname.slice(1);
    const timeout = createTimedAbortScope(undefined, { timeoutMs: Math.max(1, deadlineMs - Date.now()),
      timeoutMessage: 'Reveal publication timed out.' });
    const signal = timeout.signal;
    const result = (status: RevealPublicationOutcome['status']): RevealPublicationOutcome => ({ tokenId: job.tokenId, status });
    try {
      const previous = await raceWithSignal(this.trackStorage(this.env.ETHEREUM_REVEAL_METADATA.get(key)), signal);
      signal.throwIfAborted();
      if (this.retiring || this.resetting) return result('retry');
      if (previous) {
        if (previous.size > MAX_REVEAL_METADATA_BYTES) return result('conflict');
        const bytes = await raceWithSignal(this.trackStorage(previous.arrayBuffer()), signal);
        let body: string;
        try { body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { return result('conflict'); }
        signal.throwIfAborted();
        if (body === job.metadataJson) {
          const headers = previous.httpMetadata;
          if (headers?.contentType === JSON_HTTP_METADATA.contentType && headers.cacheControl === JSON_HTTP_METADATA.cacheControl &&
            !headers.contentEncoding) return result(await this.isCurrentPublication(scope, job, signal) ? 'published' : 'superseded');
        } else if (!job.expectedJsons.includes(body)) return result('conflict');
      } else if (!job.allowMissing) return result('conflict');
      if (this.retiring || this.resetting || Date.now() >= deadlineMs) return result('retry');
      await this.requireCurrentScope(scope, signal);
      if (!await this.isCurrentPublication(scope, job, signal)) return result('superseded');
      if (this.retiring || this.resetting || Date.now() >= deadlineMs) return result('retry');
      signal.throwIfAborted();
      const written = await raceWithSignal(this.trackStorage(this.env.ETHEREUM_REVEAL_METADATA.put(key, job.metadataJson, {
        onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: JSON_HTTP_METADATA,
        customMetadata: { revealDeployment: scope.deploymentId, revealToken: job.tokenId, revealMetadataRevision: String(job.metadataRevision) },
      })), signal);
      return result(written ? 'published' : 'retry');
    } catch {
      if (timeout.timedOut() && !this.resetting) {
        this.resetting = true;
        this.ctx.abort('Reveal publication I/O timed out.');
      }
      return result('retry');
    }
    finally { timeout.dispose(); }
  }

  async drainRetired(value: unknown): Promise<{ drained: true }> {
    const deployment = await requireRetiredRevealDeployment(this.env, value);
    if (!this.isAttributePublisher(deployment)) requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL_PUBLISHER, deployment);
    this.retiring = true;
    this.sourceStop.abort();
    const timeout = createTimedAbortScope(undefined, { timeoutMs: 45_000, timeoutMessage: 'Retired reveal publisher drain timed out.' });
    try {
      do {
        await raceWithSignal(Promise.allSettled([
          ...[...this.publications.values()].map(entry => entry.result), ...this.storageOperations, ...this.sourceReads,
          ...(this.relicMaintenance ? [this.relicMaintenance] : []),
        ]), timeout.signal);
      } while (this.publications.size || this.storageOperations.size || this.sourceReads.size || this.relicMaintenance);
      await raceWithSignal(requireRetiredRevealDeployment(this.env, value), timeout.signal);
      if (this.resetting) throw new Error('Retired reveal publisher must restart before its drain can be confirmed.');
      return { drained: true };
    } finally { timeout.dispose(); }
  }
}
