import { DurableObject } from 'cloudflare:workers';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.js';
import { normalizeEthereumAddress } from '../../../../shared/ethereum/protocol.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import type { RevealPublicationJob } from './ethereumRevealStore.js';

type PublicationScope = Pick<EthereumRevealDeployment, 'deploymentId' | 'chainId' | 'contractAddress' | 'metadataBaseUri'>;
export type RevealPublicationOutcome = { tokenId: string; status: 'published' | 'conflict' | 'retry' };
type PendingPublication = { identity: string; result: Promise<RevealPublicationOutcome> };
const MAX_METADATA_BYTES = 128 * 1024;

export class EthereumRevealPublisherObject extends DurableObject<Env> {
  private readonly publications = new Map<string, PendingPublication>();
  private resetting = false;

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
    return Promise.all(jobs.map(job => this.start(scope, job, deadline)));
  }

  private start(scope: PublicationScope, job: RevealPublicationJob, deadlineMs: number): Promise<RevealPublicationOutcome> {
    if (this.resetting) return Promise.resolve({ tokenId: job.token_id, status: 'retry' });
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

  private async publish(scope: PublicationScope, job: RevealPublicationJob, deadlineMs: number): Promise<RevealPublicationOutcome> {
    const key = new URL(ethereumTokenMetadataUri(scope, job.token_id)).pathname.slice(1);
    const timeout = createTimedAbortScope(undefined, { timeoutMs: Math.max(1, deadlineMs - Date.now()),
      timeoutMessage: 'Reveal publication timed out.' });
    const signal = timeout.signal;
    const result = (status: RevealPublicationOutcome['status']): RevealPublicationOutcome => ({ tokenId: job.token_id, status });
    try {
      const previous = await raceWithSignal(this.env.ETHEREUM_REVEAL_METADATA.get(key), signal);
      signal.throwIfAborted();
      if (this.resetting) return result('retry');
      if (previous) {
        if (previous.size > MAX_METADATA_BYTES) return result('conflict');
        const body = await raceWithSignal(previous.text(), signal);
        signal.throwIfAborted();
        if (body === job.metadata_json) return result('published');
        if (body !== job.placeholder_json) return result('conflict');
      }
      if (this.resetting || Date.now() >= deadlineMs) return result('retry');
      signal.throwIfAborted();
      const written = await raceWithSignal(this.env.ETHEREUM_REVEAL_METADATA.put(key, job.metadata_json, {
        onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
        customMetadata: { revealDeployment: scope.deploymentId, revealToken: job.token_id },
      }), signal);
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
}
