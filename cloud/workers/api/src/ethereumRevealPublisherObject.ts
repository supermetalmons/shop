import { DurableObject } from 'cloudflare:workers';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.js';
import { normalizeEthereumAddress } from '../../../../shared/ethereum/protocol.js';
import { ETHEREUM_REVEAL_CATALOG_VERSION, readEthereumRevealDeployment,
  type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import type { RevealPublicationJob } from './ethereumRevealStore.js';
import { requireRetiredRevealDeployment, requireRevealObjectIdentity } from './ethereumRevealMaintenanceSupport.js';

type PublicationScope = Pick<EthereumRevealDeployment, 'deploymentId' | 'chainId' | 'contractAddress' | 'metadataBaseUri'>;
export type RevealPublicationOutcome = { tokenId: string; status: 'published' | 'conflict' | 'retry' };
type PendingPublication = { identity: string; result: Promise<RevealPublicationOutcome> };
const MAX_METADATA_BYTES = 128 * 1024;

export class EthereumRevealPublisherObject extends DurableObject<Env> {
  private readonly publications = new Map<string, PendingPublication>();
  private readonly storageOperations = new Set<Promise<unknown>>();
  private resetting = false;
  private retiring = false;

  publishBatch(scope: PublicationScope, jobs: RevealPublicationJob[], deadlineMs = Date.now() + 25_000): Promise<RevealPublicationOutcome[]> {
    if (!Array.isArray(jobs) || jobs.length > 8 || !Number.isSafeInteger(deadlineMs) ||
      !scope.deploymentId || normalizeEthereumAddress(scope.contractAddress) !== scope.contractAddress) {
      throw new Error('Invalid reveal publication batch.');
    }
    const encoder = new TextEncoder();
    for (const job of jobs) {
      ethereumTokenMetadataUri(scope, job.token_id);
      if (BigInt(job.token_id) > 111_111n || typeof job.metadata_json !== 'string' || typeof job.placeholder_json !== 'string' ||
        job.metadata_json.length > MAX_METADATA_BYTES || job.placeholder_json.length > MAX_METADATA_BYTES ||
        encoder.encode(job.metadata_json).byteLength > MAX_METADATA_BYTES || encoder.encode(job.placeholder_json).byteLength > MAX_METADATA_BYTES) {
        throw new Error('Invalid reveal publication metadata.');
      }
    }
    const deadline = Math.min(deadlineMs, Date.now() + 25_000);
    return this.authorize(scope, jobs, deadline);
  }

  private async authorize(scope: PublicationScope, jobs: RevealPublicationJob[], deadline: number): Promise<RevealPublicationOutcome[]> {
    if (this.retiring || this.resetting || deadline <= Date.now()) return jobs.map(job => ({ tokenId: job.token_id, status: 'retry' }));
    const timeout = createTimedAbortScope(undefined, { timeoutMs: Math.max(1, deadline - Date.now()),
      timeoutMessage: 'Reveal publication authorization timed out.' });
    try {
      await this.requireCurrentScope(scope, timeout.signal);
      return await Promise.all(jobs.map(job => this.start(scope, job, deadline)));
    } finally { timeout.dispose(); }
  }

  private async requireCurrentScope(scope: PublicationScope, signal: AbortSignal): Promise<void> {
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL_PUBLISHER, scope);
    const deployment = await raceWithSignal(readEthereumRevealDeployment(this.env.OPS_DB, scope), signal);
    if (deployment?.retiredAtMs != null || deployment && deployment.catalogVersion !== ETHEREUM_REVEAL_CATALOG_VERSION) this.retiring = true;
    if (this.retiring || !deployment || deployment.deploymentId !== scope.deploymentId || deployment.metadataBaseUri !== scope.metadataBaseUri) {
      throw new Error('Reveal publication scope is not current and registered.');
    }
  }

  private start(scope: PublicationScope, job: RevealPublicationJob, deadlineMs: number): Promise<RevealPublicationOutcome> {
    if (this.retiring || this.resetting) return Promise.resolve({ tokenId: job.token_id, status: 'retry' });
    const key = `${scope.chainId}:${scope.contractAddress}:${job.token_id}`;
    const identity = JSON.stringify([scope.deploymentId, scope.metadataBaseUri, job.metadata_json, job.placeholder_json]);
    const existing = this.publications.get(key);
    if (existing) return existing.identity === identity ? existing.result : Promise.resolve({ tokenId: job.token_id, status: 'conflict' });
    if (this.publications.size >= 8 || deadlineMs <= Date.now()) return Promise.resolve({ tokenId: job.token_id, status: 'retry' });
    const result = this.publish(scope, job, deadlineMs).finally(() => { this.publications.delete(key); });
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

  private async publish(scope: PublicationScope, job: RevealPublicationJob, deadlineMs: number): Promise<RevealPublicationOutcome> {
    const key = new URL(ethereumTokenMetadataUri(scope, job.token_id)).pathname.slice(1);
    const timeout = createTimedAbortScope(undefined, { timeoutMs: Math.max(1, deadlineMs - Date.now()),
      timeoutMessage: 'Reveal publication timed out.' });
    const signal = timeout.signal;
    const result = (status: RevealPublicationOutcome['status']): RevealPublicationOutcome => ({ tokenId: job.token_id, status });
    try {
      const previous = await raceWithSignal(this.trackStorage(this.env.ETHEREUM_REVEAL_METADATA.get(key)), signal);
      signal.throwIfAborted();
      if (this.retiring || this.resetting) return result('retry');
      if (previous) {
        if (previous.size > MAX_METADATA_BYTES) return result('conflict');
        const body = await raceWithSignal(this.trackStorage(previous.text()), signal);
        signal.throwIfAborted();
        if (body === job.metadata_json) return result('published');
        if (body !== job.placeholder_json) return result('conflict');
      }
      if (this.retiring || this.resetting || Date.now() >= deadlineMs) return result('retry');
      await this.requireCurrentScope(scope, signal);
      if (this.retiring || this.resetting || Date.now() >= deadlineMs) return result('retry');
      signal.throwIfAborted();
      const written = await raceWithSignal(this.trackStorage(this.env.ETHEREUM_REVEAL_METADATA.put(key, job.metadata_json, {
        onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
        customMetadata: { revealDeployment: scope.deploymentId, revealToken: job.token_id },
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
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL_PUBLISHER, deployment);
    this.retiring = true;
    const timeout = createTimedAbortScope(undefined, { timeoutMs: 45_000, timeoutMessage: 'Retired reveal publisher drain timed out.' });
    try {
      do {
        await raceWithSignal(Promise.allSettled([
          ...[...this.publications.values()].map(entry => entry.result), ...this.storageOperations,
        ]), timeout.signal);
      } while (this.publications.size || this.storageOperations.size);
      await raceWithSignal(requireRetiredRevealDeployment(this.env, value), timeout.signal);
      if (this.resetting) throw new Error('Retired reveal publisher must restart before its drain can be confirmed.');
      return { drained: true };
    } finally { timeout.dispose(); }
  }
}
