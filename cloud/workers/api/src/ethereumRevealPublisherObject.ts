import { DurableObject } from 'cloudflare:workers';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.js';
import { normalizeEthereumAddress } from '../../../../shared/ethereum/protocol.js';
import { ETHEREUM_REVEAL_CATALOG_VERSION, readEthereumRevealDeployment,
  type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import type { EthereumArtworkCategory } from '../../../../shared/ethereum/reveal.js';
import { REVEAL_ENRICHMENT_SLOTS } from './ethereumRevealEnrichmentStore.js';
import { attributePublisherName, fetchRevealAttributes, InvalidRevealAttributes, MAX_REVEAL_METADATA_BYTES } from './ethereumRevealAttributes.js';
import type { RevealPublicationJob } from './ethereumRevealStore.js';
import { requireRetiredRevealDeployment, requireRevealObjectIdentity } from './ethereumRevealMaintenanceSupport.js';

type PublicationScope = Pick<EthereumRevealDeployment, 'deploymentId' | 'chainId' | 'contractAddress' | 'metadataBaseUri'>;
export type RevealPublicationOutcome = { tokenId: string; status: 'published' | 'conflict' | 'retry' };
type PendingPublication = { identity: string; result: Promise<RevealPublicationOutcome> };
export type PreparedAttributes = { status: 'prepared'; metadataJson: string; metadataSha256: string } | { status: 'invalid' | 'source-unavailable' };
type PublicationStage = 'media' | 'attributes';
type MetadataWrite = { tokenId: string; expectedJson: string; metadataJson: string };
const JSON_HTTP_METADATA = { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } as const;

export class EthereumRevealPublisherObject extends DurableObject<Env> {
  private readonly publications = new Map<string, PendingPublication>();
  private readonly storageOperations = new Set<Promise<unknown>>();
  private readonly sourceStop = new AbortController();
  private readonly sourceReads = new Set<Promise<unknown>>();
  private resetting = false;
  private retiring = false;

  publishBatch(scope: PublicationScope, jobs: RevealPublicationJob[], deadlineMs = Date.now() + 25_000): Promise<RevealPublicationOutcome[]> {
    if (!Array.isArray(jobs) || jobs.length > 8) throw new Error('Invalid reveal publication batch.');
    return this.publishJobs(scope, jobs.map(job => ({ tokenId: job.token_id, expectedJson: job.placeholder_json,
      metadataJson: job.metadata_json })), deadlineMs, 'media');
  }

  async prepareAttributes(scope: PublicationScope, job: { category: EthereumArtworkCategory; assetId: number; baseJson: string },
    deadlineMs: number): Promise<PreparedAttributes> {
    if (!this.isAttributePublisher(scope)) throw new Error('Attribute publisher object does not match the registered deployment.');
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() || this.retiring ||
      this.resetting || this.sourceReads.size >= REVEAL_ENRICHMENT_SLOTS) return { status: 'source-unavailable' };
    const timeout = createTimedAbortScope(this.sourceStop.signal, { timeoutMs: Math.min(25_000, deadlineMs - Date.now()),
      timeoutMessage: 'Reveal attribute preparation timed out.' });
    const prepare = async () => {
      await this.requireCurrentScope(scope, timeout.signal);
      timeout.signal.throwIfAborted();
      return fetchRevealAttributes(job.category, job.assetId, job.baseJson, timeout.signal);
    };
    const work = prepare().finally(() => { this.sourceReads.delete(work); });
    this.sourceReads.add(work);
    this.ctx.waitUntil(work.then(() => undefined, () => undefined));
    try {
      return { status: 'prepared', ...await raceWithSignal(work, timeout.signal) };
    } catch (error) {
      return { status: error instanceof InvalidRevealAttributes ? 'invalid' : 'source-unavailable' };
    } finally { timeout.dispose(); }
  }

  async publishAttributes(scope: PublicationScope, job: { tokenId: string; baseJson: string; metadataJson: string },
    deadlineMs: number): Promise<RevealPublicationOutcome> {
    const [outcome] = await this.publishJobs(scope, [{ tokenId: job.tokenId, expectedJson: job.baseJson,
      metadataJson: job.metadataJson }], deadlineMs, 'attributes');
    return outcome;
  }

  private publishJobs(scope: PublicationScope, jobs: MetadataWrite[], deadlineMs: number, stage: PublicationStage): Promise<RevealPublicationOutcome[]> {
    if (!Number.isSafeInteger(deadlineMs) || !scope.deploymentId || normalizeEthereumAddress(scope.contractAddress) !== scope.contractAddress) {
      throw new Error('Invalid reveal publication batch.');
    }
    const encoder = new TextEncoder();
    for (const job of jobs) {
      ethereumTokenMetadataUri(scope, job.tokenId);
      if (BigInt(job.tokenId) > 111_111n || [job.metadataJson, job.expectedJson].some(json =>
        typeof json !== 'string' || json.length > MAX_REVEAL_METADATA_BYTES || encoder.encode(json).byteLength > MAX_REVEAL_METADATA_BYTES)) {
        throw new Error('Invalid reveal publication metadata.');
      }
    }
    return this.authorize(scope, jobs, Math.min(deadlineMs, Date.now() + 25_000), stage);
  }

  private async authorize(scope: PublicationScope, jobs: MetadataWrite[], deadline: number, stage: PublicationStage): Promise<RevealPublicationOutcome[]> {
    if (stage === 'media') requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL_PUBLISHER, scope);
    else if (!this.isAttributePublisher(scope)) throw new Error('Attribute publisher object does not match the registered deployment.');
    if (this.retiring || this.resetting || deadline <= Date.now()) return jobs.map(job => ({ tokenId: job.tokenId, status: 'retry' }));
    const timeout = createTimedAbortScope(undefined, { timeoutMs: Math.max(1, deadline - Date.now()),
      timeoutMessage: 'Reveal publication authorization timed out.' });
    try {
      await this.requireCurrentScope(scope, timeout.signal);
      return await Promise.all(jobs.map(job => this.start(scope, job, deadline, stage)));
    } finally { timeout.dispose(); }
  }

  private async requireCurrentScope(scope: PublicationScope, signal: AbortSignal): Promise<void> {
    const deployment = await raceWithSignal(readEthereumRevealDeployment(this.env.OPS_DB, scope), signal);
    if (deployment?.retiredAtMs != null || deployment && deployment.catalogVersion !== ETHEREUM_REVEAL_CATALOG_VERSION) this.retiring = true;
    if (this.retiring || !deployment || deployment.deploymentId !== scope.deploymentId || deployment.metadataBaseUri !== scope.metadataBaseUri) {
      throw new Error('Reveal publication scope is not current and registered.');
    }
  }

  private isAttributePublisher(scope: Pick<PublicationScope, 'chainId' | 'contractAddress'>): boolean {
    return this.ctx.id.equals(this.env.ETHEREUM_REVEAL_PUBLISHER.idFromName(attributePublisherName(scope)));
  }

  private start(scope: PublicationScope, job: MetadataWrite, deadlineMs: number, stage: PublicationStage): Promise<RevealPublicationOutcome> {
    if (this.retiring || this.resetting) return Promise.resolve({ tokenId: job.tokenId, status: 'retry' });
    const key = `${scope.chainId}:${scope.contractAddress}:${job.tokenId}`;
    const identity = JSON.stringify([scope.deploymentId, scope.metadataBaseUri, job.metadataJson, job.expectedJson]);
    const existing = this.publications.get(key);
    if (existing) return existing.identity === identity ? existing.result : Promise.resolve({ tokenId: job.tokenId, status: 'conflict' });
    if (this.publications.size >= (stage === 'media' ? 8 : REVEAL_ENRICHMENT_SLOTS) || deadlineMs <= Date.now()) return Promise.resolve({ tokenId: job.tokenId, status: 'retry' });
    const result = this.publish(scope, job, deadlineMs, stage).finally(() => { this.publications.delete(key); });
    this.publications.set(key, { identity, result });
    this.ctx.waitUntil(result);
    return result;
  }

  private trackStorage<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => { this.storageOperations.delete(tracked); });
    this.storageOperations.add(tracked);
    this.ctx.waitUntil(tracked.then(() => undefined, () => undefined));
    return tracked;
  }

  private async publish(scope: PublicationScope, job: MetadataWrite, deadlineMs: number, stage: PublicationStage): Promise<RevealPublicationOutcome> {
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
            !headers.contentEncoding) return result('published');
        } else if (body !== job.expectedJson) return result('conflict');
      } else if (stage === 'attributes') return result('conflict');
      if (this.retiring || this.resetting || Date.now() >= deadlineMs) return result('retry');
      await this.requireCurrentScope(scope, signal);
      if (this.retiring || this.resetting || Date.now() >= deadlineMs) return result('retry');
      signal.throwIfAborted();
      const written = await raceWithSignal(this.trackStorage(this.env.ETHEREUM_REVEAL_METADATA.put(key, job.metadataJson, {
        onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: JSON_HTTP_METADATA,
        customMetadata: { revealDeployment: scope.deploymentId, revealToken: job.tokenId },
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
        ]), timeout.signal);
      } while (this.publications.size || this.storageOperations.size || this.sourceReads.size);
      await raceWithSignal(requireRetiredRevealDeployment(this.env, value), timeout.signal);
      if (this.resetting) throw new Error('Retired reveal publisher must restart before its drain can be confirmed.');
      return { drained: true };
    } finally { timeout.dispose(); }
  }
}
