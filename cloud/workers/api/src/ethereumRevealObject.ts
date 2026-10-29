import { DurableObject } from 'cloudflare:workers';
import type { EthereumRevealObservation, EthereumRevealTokensResponse, EthereumRevealTransactionResponse } from '../../../../shared/ethereum/reveal.js';
import { ETHEREUM_REVEAL_CATALOG_VERSION, readEthereumRevealDeployment,
  type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { EthereumApiError } from './ethereumError.js';
import { inspectRevealTransaction, recoverRevealTokens, recoverRevealCrates, verifyRevealDeployment,
  type EthereumRevealTransactionInspection } from './ethereumRevealChain.js';
import { validateRevealCatalog } from './ethereumRevealCatalog.js';
import { EthereumRevealStore, type RevealSearchRange, type RevealTransactionJob, type RevealPublicationJob } from './ethereumRevealStore.js';

function unavailable(): EthereumApiError { return new EthereumApiError('unavailable', 'Artwork reveal is temporarily unavailable.'); }

async function finishTasks(tasks: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export class EthereumRevealObject extends DurableObject<Env> {
  private readonly store: EthereumRevealStore;
  private chainRun: Promise<void> | null = null;
  private publicationRun: Promise<void> | null = null;
  private alarmUpdate: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new EthereumRevealStore(ctx.storage.sql, action => ctx.storage.transactionSync(action));
  }

  private configure(deployment: EthereumRevealDeployment): void {
    if (deployment.catalogVersion !== ETHEREUM_REVEAL_CATALOG_VERSION ||
      deployment.chainId === 31337 && this.env.ETHEREUM_111K_CHAIN_ID !== '31337') throw unavailable();
    this.store.configure(deployment);
  }

  private requireReady(deployment: EthereumRevealDeployment): void {
    this.configure(deployment);
    if (!this.store.ready() || deployment.provisionedAtMs === null) throw unavailable();
  }

  private requireAdmission(deployment: EthereumRevealDeployment): void {
    if (deployment.state !== 'active') throw new EthereumApiError('failed-precondition', 'New artwork reveals are paused for this collection.');
  }

  async initialize(deployment: EthereumRevealDeployment): Promise<{ ready: boolean; seeded: number }> {
    this.configure(deployment);
    validateRevealCatalog();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deployment.templateJson));
    const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== deployment.templateSha256) throw new Error('Reveal template checksum mismatch.');
    for (let index = 0; index < 5 && !this.store.ready(); index++) this.store.initializeChunk();
    if (this.store.ready() && deployment.state === 'provisioning') {
      await verifyRevealDeployment(this.env, deployment, AbortSignal.timeout(15_000));
      const now = Date.now();
      await this.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET state='ready',provisioned_at_ms=?,
        revision=revision+1,updated_at_ms=?,last_error=NULL WHERE deployment_id=? AND state='provisioning'
        AND template_sha256=?`).bind(now, now, deployment.deploymentId, deployment.templateSha256).run();
    }
    if (!this.store.ready()) await this.ctx.storage.setAlarm(Date.now() + 250);
    const summary = this.store.summary();
    return { ready: summary.ready, seeded: summary.seeded };
  }

  async hasTransaction(deployment: EthereumRevealDeployment, hash: string): Promise<boolean> {
    this.configure(deployment);
    const job = this.store.transactionJob(hash);
    return job?.requested_all === 1 || deployment.state === 'paused' && job?.status === 'revealed' && job.revealed_all === 1;
  }

  async hasTokens(deployment: EthereumRevealDeployment, tokenIds: string[]): Promise<boolean> {
    this.configure(deployment);
    return this.store.knownTokens(tokenIds, Date.now());
  }

  async revealTransaction(deployment: EthereumRevealDeployment, hash: string): Promise<EthereumRevealTransactionResponse> {
    this.requireReady(deployment);
    this.store.cleanupTransactions(Date.now());
    const known = this.store.transactionJob(hash);
    if (!known || !known.requested_all) {
      if (deployment.state === 'paused' && known?.status === 'revealed' && known.revealed_all) {
        return this.store.transactionResponse(deployment, hash);
      }
      this.requireAdmission(deployment);
    }
    const admitted = this.store.registerTransaction(hash, deployment.deploymentBlock);
    await this.arm();
    if (!admitted) return this.inspectUntrackedTransaction(deployment, hash);
    if (known?.status === 'revealed' && known.revealed_all) {
      this.ctx.waitUntil(this.processTransaction(deployment, hash).catch(() => undefined));
      return this.store.transactionResponse(deployment, hash);
    }
    await this.processTransaction(deployment, hash);
    const response = this.store.transactionResponse(deployment, hash);
    this.startBackground(deployment);
    return response;
  }

  private async inspectUntrackedTransaction(deployment: EthereumRevealDeployment, hash: string): Promise<EthereumRevealTransactionResponse> {
    const signal = AbortSignal.timeout(20_000);
    try {
      const result = await inspectRevealTransaction(this.env, deployment, hash, signal);
      signal.throwIfAborted();
      if (result.status === 'confirmed') {
        this.store.registerTransaction(hash, deployment.deploymentBlock, true, result.crates.map(crate => crate.crateTokenId));
        this.store.freeze(deployment, result.observation, result.crates, Date.now());
      } else if (result.status === 'pending' && result.crates?.length) {
        this.store.registerTransaction(hash, result.fromBlock ?? deployment.deploymentBlock, true, result.crates);
        this.store.pendingTransaction(hash, result.crates, result.fromBlock, Date.now());
      } else return this.untrackedTransactionResponse(deployment, result);
      const response = this.store.transactionResponse(deployment, hash);
      this.startBackground(deployment);
      return response;
    } catch { throw unavailable(); }
    finally { await this.arm(); }
  }

  private untrackedTransactionResponse(deployment: EthereumRevealDeployment,
    result: Exclude<EthereumRevealTransactionInspection, { status: 'confirmed' }>): EthereumRevealTransactionResponse {
    const status = result.status === 'pending' || result.source === 'receipt' && result.confirmations < 64 ? 'pending' : result.status;
    return { deploymentId: deployment.deploymentId, dropId: deployment.dropId, chainId: deployment.chainId,
      contractAddress: deployment.contractAddress, status, artworks: [], retryAfterMs: status === 'pending' ? 2_000 : 0,
      ...('observation' in result ? { observedBlock: { number: result.observation.blockNumber, hash: result.observation.blockHash } } : {}) };
  }

  async revealTokens(deployment: EthereumRevealDeployment, tokenIds: string[]): Promise<EthereumRevealTokensResponse> {
    this.requireReady(deployment);
    if (!this.store.knownTokens(tokenIds, Date.now())) this.requireAdmission(deployment);
    this.store.requestRecovery(tokenIds, deployment.deploymentBlock, Date.now());
    await this.arm();
    const needed = new Set(tokenIds);
    const jobs = this.store.dueRecovery(Date.now(), 8).filter(job => (JSON.parse(job.token_ids_json) as string[]).some(id => needed.has(id)));
    await finishTasks(jobs.slice(0, 2).map(job => this.processRecovery(deployment, job.id)));
    this.startBackground(deployment);
    const artworks = this.store.frozen(tokenIds);
    const revealed = new Set(artworks.map(artwork => artwork.tokenId));
    const unresolved = tokenIds.filter(id => !revealed.has(id)).map(tokenId => ({ tokenId, status: this.store.tokenStatus(tokenId) }));
    return { deploymentId: deployment.deploymentId, dropId: deployment.dropId, chainId: deployment.chainId,
      contractAddress: deployment.contractAddress, artworks, unresolved,
      retryAfterMs: unresolved.some(value => value.status === 'recovering') ? 2_000 : 0 };
  }

  private async processTransaction(deployment: EthereumRevealDeployment, hash: string): Promise<void> {
    const job = this.store.claimTransaction(hash, Date.now());
    if (!job) return;
    const signal = AbortSignal.timeout(20_000);
    try {
      const result = await inspectRevealTransaction(this.env, deployment, hash, signal);
      signal.throwIfAborted();
      const current = this.store.transactionJob(hash);
      if (current?.incarnation !== job.incarnation) return;
      if (result.status === 'confirmed') {
        const selected = new Set<string>(JSON.parse(current.crates_json));
        const crates = current.requested_all ? result.crates : result.crates.filter(crate => selected.has(crate.crateTokenId));
        const frozenCrates = new Set((JSON.parse(current.tokens_json) as Array<{ crateTokenId: string }>).map(value => value.crateTokenId));
        const unchanged = current.observation_json === JSON.stringify(result.observation) &&
          crates.every(crate => frozenCrates.has(crate.crateTokenId)) && (current.revealed_all === 1 || crates.length < result.crates.length);
        const generation = crates.length && !unchanged
          ? this.store.freeze(deployment, result.observation, crates, Date.now(), crates.length === result.crates.length)
          : current.tracking_generation;
        const confirmedCrates = result.crates.map(crate => crate.crateTokenId);
        let complete = [...selected].every(crate => confirmedCrates.includes(crate));
        if (!complete) {
          this.store.retryTransaction(hash, Date.now(), 30_000, generation);
          complete = await this.findReplacement(deployment, this.store.transactionJob(hash)!, signal, confirmedCrates);
        }
        this.store.retryTransaction(hash, Date.now(), complete && result.confirmations >= 64 ? 86_400_000 : 15_000, generation);
      } else if (result.status === 'pending') {
        if (job.crates_json !== '[]' && job.attempts > 1 && await this.findReplacement(deployment, job, signal)) return;
        this.store.pendingTransaction(hash, result.crates, result.fromBlock, Date.now(), job.tracking_generation);
      } else {
        if (job.crates_json !== '[]' && await this.findReplacement(deployment, job, signal)) return;
        this.store.finishTransaction(hash, result.status, Date.now(), result.source === 'receipt' ? result : undefined, job.tracking_generation);
      }
    } catch {
      if (this.store.transactionJob(hash)?.incarnation === job.incarnation) {
        this.store.retryTransaction(hash, Date.now(), undefined, job.tracking_generation);
      }
      throw unavailable();
    } finally { await this.arm(); }
  }

  private async findReplacement(deployment: EthereumRevealDeployment, job: RevealTransactionJob, signal: AbortSignal,
    confirmedCrates: string[] = []): Promise<boolean> {
    const finish = () => confirmedCrates.length ? this.store.replacementComplete(job.hash, job.tracking_generation)
      : this.store.retireReplacedTransaction(job.hash, job.tracking_generation);
    const chunk = this.store.replacementChunk(job.hash, job.tracking_generation, Date.now(), confirmedCrates);
    if (!chunk) return finish();
    const crates = JSON.parse(chunk.crate_ids_json) as string[];
    const selected = new Set(crates), covered = new Set<string>(), checked = new Set<string>();
    const verify = async (candidates: Array<{ transactionHash: string; crateTokenIds: string[] }>) => {
      let offset = 0;
      while (offset < candidates.length && checked.size < 15 && covered.size < crates.length) {
        const batch = [];
        while (offset < candidates.length && batch.length < 4 && checked.size < 15) {
          const candidate = candidates[offset++];
          if (checked.has(candidate.transactionHash) || candidate.crateTokenIds.every(crate => covered.has(crate))) continue;
          checked.add(candidate.transactionHash);
          batch.push(candidate);
        }
        await finishTasks(batch.map(async candidate => {
          this.store.recordReplacementCheck(job.hash, candidate.transactionHash, [], Date.now());
          const verified = await inspectRevealTransaction(this.env, deployment, candidate.transactionHash, signal);
          signal.throwIfAborted();
          if (verified.status !== 'confirmed') return;
          const replacements = verified.crates.filter(crate => selected.has(crate.crateTokenId));
          if (replacements.length) this.store.freeze(deployment, verified.observation, replacements, Date.now(), replacements.length === verified.crates.length);
          this.store.recordReplacementCheck(job.hash, candidate.transactionHash, replacements.map(crate => crate.crateTokenId), Date.now());
          for (const crate of replacements) covered.add(crate.crateTokenId);
        }));
      }
    };
    await verify(this.store.replacementCandidates(job.hash, crates));
    if (this.store.completeReplacementChunk(job.hash, chunk, covered)) {
      return finish();
    }
    if (this.store.transactionJob(job.hash)!.tracking_generation !== job.tracking_generation) return false;
    const ranges = JSON.parse(chunk.ranges_json) as RevealSearchRange[];
    const range = ranges.shift() || { fromBlock: Math.max(deployment.deploymentBlock, chunk.from_block - 64) };
    const result = await recoverRevealCrates(this.env, deployment, crates, range, signal);
    this.store.rememberReplacementCandidates(job.hash, result.provenance.filter(value => value.transactionHash !== job.hash));
    await verify(this.store.replacementCandidates(job.hash, crates));
    const remaining = [...result.remainingRanges, ...ranges];
    this.store.replacementRanges(job.hash, remaining, Math.max(chunk.from_block, result.scannedRange?.toBlock ?? chunk.from_block),
      job.tracking_generation, chunk.chunk_index);
    this.store.completeReplacementChunk(job.hash, chunk, covered);
    return finish();
  }

  private async processRecovery(deployment: EthereumRevealDeployment, id: string): Promise<void> {
    const job = this.store.claimRecovery(id, Date.now());
    if (!job) return;
    const signal = AbortSignal.timeout(20_000);
    try {
      const ids = JSON.parse(job.token_ids_json) as string[];
      const needed = new Set(ids);
      const alreadyFrozen = new Set(this.store.frozen(ids).map(value => value.tokenId));
      const cached = this.store.provenance(ids.filter(tokenId => !alreadyFrozen.has(tokenId)));
      const verify = async (observation: EthereumRevealObservation) => {
        const verified = await inspectRevealTransaction(this.env, deployment, observation.transactionHash, signal);
        signal.throwIfAborted();
        if (verified.status !== 'confirmed') { this.store.discardProvenance(observation); return; }
        const crates = verified.crates.filter(crate => crate.tokenIds.some(tokenId => needed.has(tokenId)));
        if (crates.length) this.store.freeze(deployment, verified.observation, crates, Date.now(), crates.length === verified.crates.length);
        else this.store.discardProvenance(observation);
      };
      await finishTasks(cached.slice(0, 4).map(verify));
      const existing = new Set(this.store.frozen(ids).map(value => value.tokenId));
      const unknown = ids.filter(tokenId => !existing.has(tokenId));
      if (!unknown.length) { this.store.updateRecovery(id, [], [], [], Date.now()); return; }
      if (cached.length > 4) {
        this.store.updateRecovery(id, unknown, JSON.parse(job.ranges_json) as RevealSearchRange[], [], Date.now());
        return;
      }
      const ranges = JSON.parse(job.ranges_json) as RevealSearchRange[];
      const range = ranges.shift() || { fromBlock: deployment.deploymentBlock };
      const result = await recoverRevealTokens(this.env, deployment, unknown, range, signal);
      for (const observation of result.provenance) {
        this.store.saveProvenance(observation, observation.tokenIds);
      }
      await finishTasks(result.provenance.slice(0, Math.max(0, 4 - cached.length)).map(verify));
      const frozen = new Set(this.store.frozen(ids).map(value => value.tokenId));
      const unminted = ids.filter(tokenId => !frozen.has(tokenId) && Number(tokenId) > result.mintedThrough);
      const remaining = ids.filter(tokenId => !frozen.has(tokenId) && Number(tokenId) <= result.mintedThrough);
      const nextRanges = [...result.remainingRanges, ...ranges];
      this.store.updateRecovery(id, remaining, nextRanges.length ? nextRanges : [{ fromBlock: deployment.deploymentBlock }],
        unminted, Date.now(), nextRanges.length || result.provenance.length > 4 - cached.length ? 0 : 30_000);
    } catch {
      this.store.retryRecovery(id, Date.now());
      throw unavailable();
    } finally { await this.arm(); }
  }

  private async publish(deployment: EthereumRevealDeployment, job: RevealPublicationJob): Promise<void> {
    const key = `${new URL(deployment.metadataBaseUri).pathname.slice(1)}${job.token_id}.json`;
    let conflict = false;
    try {
      const previous = await this.env.ETHEREUM_REVEAL_METADATA.get(key);
      let previousBody: string | null = null;
      if (previous) {
        if (previous.size > 128 * 1024) { conflict = true; throw new Error('Reveal metadata conflict.'); }
        previousBody = await previous.text();
        if (previousBody === job.metadata_json) { this.store.publicationComplete(job.token_id); return; }
        if (previousBody !== job.placeholder_json) { conflict = true; throw new Error('Reveal metadata conflict.'); }
      }
      const written = await this.env.ETHEREUM_REVEAL_METADATA.put(key, job.metadata_json, {
        onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
        customMetadata: { revealDeployment: deployment.deploymentId, revealToken: job.token_id },
      });
      if (!written) throw unavailable();
      this.store.publicationComplete(job.token_id);
    } catch {
      this.store.publicationFailed(job.token_id, Date.now(), job.attempts, conflict);
      if (conflict) {
        await this.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET last_error='metadata-conflict',updated_at_ms=? WHERE deployment_id=?`)
          .bind(Date.now(), deployment.deploymentId).run();
        console.error({ event: 'ethereum_reveal_metadata_conflict', deploymentId: deployment.deploymentId, tokenId: job.token_id });
      } else if (job.attempts === 0 || ((job.attempts + 1) & job.attempts) === 0) {
        console.error({ event: 'ethereum_reveal_publication_retry', deploymentId: deployment.deploymentId,
          tokenId: job.token_id, attempt: job.attempts + 1 });
      }
    }
  }

  private startBackground(deployment: EthereumRevealDeployment): void {
    this.ctx.waitUntil(this.runBackground(deployment));
  }

  private runBackground(deployment: EthereumRevealDeployment): Promise<void> {
    this.ctx.waitUntil(this.runChain(deployment));
    return this.runPublications(deployment);
  }

  private runChain(deployment: EthereumRevealDeployment): Promise<void> {
    if (this.chainRun) return this.chainRun;
    const work = async () => {
      try {
        this.store.cleanupTransactions(Date.now());
        const results = await Promise.allSettled([
          ...this.store.dueTransactions(Date.now()).map(job => this.processTransaction(deployment, job.hash)),
          ...this.store.dueRecovery(Date.now(), 2).map(job => this.processRecovery(deployment, job.id)),
        ]);
        if (results.some(result => result.status === 'rejected')) console.error({ event: 'ethereum_reveal_retry_scheduled', deploymentId: deployment.deploymentId });
      } finally { await this.arm(); }
    };
    this.chainRun = work().finally(() => { this.chainRun = null; });
    return this.chainRun;
  }

  private runPublications(deployment: EthereumRevealDeployment): Promise<void> {
    if (this.publicationRun) return this.publicationRun;
    const work = async () => {
      const deadline = Date.now() + 5_000;
      let processed = 0;
      while (processed < 512 && Date.now() < deadline) {
        const jobs = this.store.claimPublications(Date.now(), Math.min(8, 512 - processed));
        if (!jobs.length) break;
        processed += jobs.length;
        await finishTasks(jobs.map(job => this.publish(deployment, job)));
      }
    };
    this.publicationRun = work().finally(async () => {
      this.publicationRun = null;
      await this.arm();
    });
    return this.publicationRun;
  }

  private arm(): Promise<void> {
    const update = this.alarmUpdate.catch(() => undefined).then(async () => {
      const current = await this.ctx.storage.getAlarm();
      const next = this.store.nextWake(Date.now());
      if (next !== null && (current === null || current > next)) await this.ctx.storage.setAlarm(next);
    });
    this.alarmUpdate = update;
    return update;
  }

  async watchdog(deployment: EthereumRevealDeployment): Promise<void> {
    this.configure(deployment);
    if (deployment.state === 'provisioning') { await this.initialize(deployment); return; }
    if (!this.store.ready()) throw unavailable();
    await this.runBackground(deployment);
    const publicationError = this.store.publicationError();
    if (deployment.lastError !== publicationError && (deployment.lastError === null ||
      deployment.lastError === 'metadata-conflict' || deployment.lastError === 'publication-unavailable')) {
      await this.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET last_error=?,updated_at_ms=?
        WHERE deployment_id=? AND last_error IS ?`).bind(publicationError, Date.now(), deployment.deploymentId, deployment.lastError).run();
    }
  }

  async alarm(): Promise<void> {
    try {
      const identity = this.store.identity();
      if (!identity) return;
      const deployment = await readEthereumRevealDeployment(this.env.OPS_DB, identity);
      if (!deployment) throw unavailable();
      await this.watchdog(deployment);
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
      throw unavailable();
    }
  }
}
