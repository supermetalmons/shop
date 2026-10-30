import { DurableObject } from 'cloudflare:workers';
import type { EthereumRevealResult, EthereumRevealTokensResponse, EthereumRevealTransactionResponse } from '../../../../shared/ethereum/reveal.js';
import { ETHEREUM_REVEAL_CATALOG_VERSION, readEthereumRevealDeployment,
  type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { EthereumApiError } from './ethereumError.js';
import { EthereumRevealThrottleError, recoverRevealTokens, recoverRevealCrates, verifyRevealDeployment } from './ethereumRevealChain.js';
import { validateRevealCatalog } from './ethereumRevealCatalog.js';
import { EthereumRevealStore, type RevealReceiptClaim, type RevealScanClaim, type RevealPublicationJob,
  type RevealPublicationResult } from './ethereumRevealStore.js';
import type { RevealVerificationResult, RevealVerificationScope, RevealVerificationWork } from './ethereumRevealVerification.js';
import type { RevealPublicationOutcome } from './ethereumRevealPublisherObject.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';

function unavailable(): EthereumApiError { return new EthereumApiError('unavailable', 'Artwork reveal is temporarily unavailable.'); }

export class EthereumRevealObject extends DurableObject<Env> {
  private readonly store: EthereumRevealStore;
  private readonly receipts = new Map<string, { active: boolean; promise: Promise<void> }>();
  private readonly scans = new Map<string, { claim: RevealScanClaim; promise: Promise<void> }>();
  private readonly overflow = new Map<string, Promise<boolean>>();
  private readonly receiptWaiters = new Map<string, Set<() => void>>();
  private migrationRun: Promise<void> | null = null;
  private publicationRun: Promise<void> | null = null;
  private lastPublicationStartMs = 0;
  private alarmUpdate: Promise<void> = Promise.resolve();
  private lastHealthReportMs = 0;

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

  private admitTransactionWork(deployment: EthereumRevealDeployment, hash: string, admit: boolean): 'accepted' | 'admission' | 'capacity' {
    if (!this.store.knownTransaction(hash)) {
      if (!admit) return 'admission';
      this.requireAdmission(deployment);
    }
    return this.store.admitTransaction(hash, deployment.deploymentBlock, Date.now());
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

  async revealTransaction(deployment: EthereumRevealDeployment, hash: string, admit = false, deadlineMs?: number): Promise<EthereumRevealResult<EthereumRevealTransactionResponse>> {
    const deadline = Math.min(Date.now() + 2_000, deadlineMs ?? Infinity);
    this.requireReady(deployment);
    const snapshot = this.store.transactionResponse(deployment, hash);
    if (snapshot.status !== 'pending') return { kind: 'ready', value: snapshot };
    const admission = this.admitTransactionWork(deployment, hash, admit);
    if (admission === 'admission') return { kind: 'admission' };
    if (admission === 'capacity') {
      if (!await this.verifyAtCapacity(deployment, hash, deadline)) return { kind: 'capacity' };
    }
    await this.arm();
    this.startBackground(deployment, hash);
    const work = this.receipts.get(hash)?.promise;
    if (work) await this.withinBudget(work, deadline);
    else if (this.store.dispatchState(Date.now()).inFlight) await this.waitForReceipt(hash, deadline);
    const response = this.store.transactionResponse(deployment, hash);
    if (response.status === 'pending' && !this.store.knownTransaction(hash)) {
      const readmission = this.admitTransactionWork(deployment, hash, admit);
      if (readmission !== 'accepted') return { kind: readmission };
      await this.arm();
    }
    return { kind: 'ready', value: response };
  }

  async revealTokens(deployment: EthereumRevealDeployment, tokenIds: string[], admit = false, deadlineMs?: number): Promise<EthereumRevealResult<EthereumRevealTokensResponse>> {
    const deadline = Math.min(Date.now() + 2_000, deadlineMs ?? Infinity);
    this.requireReady(deployment);
    const snapshot = this.store.tokensResponse(deployment, tokenIds);
    if (!snapshot.unresolved.length) return { kind: 'ready', value: snapshot };
    const known = this.store.knownTokens(tokenIds, Date.now());
    if (known && snapshot.unresolved.every(value => value.status === 'unminted')) return { kind: 'ready', value: snapshot };
    if (!known && !admit) return { kind: 'admission' };
    if (!known) this.requireAdmission(deployment);
    const waitingTokens = new Set(snapshot.artworks.length ? [
      ...snapshot.unresolved.filter(value => value.status === 'unminted').map(value => value.tokenId),
      ...this.store.recoveringTokenIds(snapshot.unresolved.map(value => value.tokenId)),
    ] : []);
    this.store.admitTokens(tokenIds, deployment.deploymentBlock, Date.now());
    await this.arm();
    this.startBackground(deployment, undefined, tokenIds);
    if (!snapshot.artworks.length || waitingTokens.size) {
      const needed = waitingTokens.size ? waitingTokens : new Set(tokenIds);
      while (Date.now() < deadline) {
        const response = this.store.tokensResponse(deployment, tokenIds);
        if (waitingTokens.size
          ? response.unresolved.every(value => !waitingTokens.has(value.tokenId) || value.status === 'unminted')
          : response.artworks.length || response.unresolved.every(value => value.status === 'unminted')) break;
        const hashes = new Set(this.store.provenance([...needed]).map(value => value.transactionHash));
        const tasks: Promise<unknown>[] = [...this.scans.values()].filter(value => value.claim.kind === 'tokens' &&
          value.claim.tokenIds.some(id => needed.has(id))).map(value => value.promise);
        for (const hash of hashes) {
          const work = this.receipts.get(hash)?.promise;
          if (work) tasks.push(work);
        }
        if (!tasks.length) {
          tasks.push(...[...this.scans.values(), ...this.receipts.values()].map(value => value.promise));
          tasks.push(...this.overflow.values());
          if (this.migrationRun) tasks.push(this.migrationRun);
        }
        if (!tasks.length || !await this.withinBudget(Promise.race(tasks), deadline)) break;
      }
    }
    return { kind: 'ready', value: this.store.tokensResponse(deployment, tokenIds) };
  }

  private async withinBudget(work: Promise<unknown>, deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work.then(() => true, () => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  private async waitForReceipt(hash: string, deadline: number): Promise<void> {
    const waiters = this.receiptWaiters.get(hash) ?? new Set<() => void>();
    this.receiptWaiters.set(hash, waiters);
    let notify!: () => void;
    const completed = new Promise<void>(resolve => { notify = resolve; });
    waiters.add(notify);
    try { await this.withinBudget(completed, deadline); }
    finally {
      waiters.delete(notify);
      if (!waiters.size) this.receiptWaiters.delete(hash);
    }
  }

  private receiptFinished(hash: string): void {
    for (const notify of this.receiptWaiters.get(hash) ?? []) notify();
  }

  private matchesScope(scope: RevealVerificationScope): boolean {
    const identity = this.store.identity();
    return identity?.chainId === scope.chainId && identity.contractAddress === scope.contractAddress;
  }

  async validateReceiptWork(scope: RevealVerificationScope, work: RevealVerificationWork): Promise<boolean> {
    if (!this.matchesScope(scope)) return false;
    return work.kind === 'receipt' ? this.store.validReceiptClaim(work.claim, Date.now()) : this.store.validOverflow(work.claim, Date.now());
  }

  async recordReceiptPresence(scope: RevealVerificationScope, work: RevealVerificationWork): Promise<boolean> {
    if (!this.matchesScope(scope)) return false;
    return work.kind === 'receipt' ? this.store.recordReceiptPresence(work.claim, Date.now()) : this.store.validOverflow(work.claim, Date.now());
  }

  private async inspect(deployment: EthereumRevealDeployment, work: RevealVerificationWork, deadlineMs: number): Promise<RevealVerificationResult> {
    if (Date.now() >= deadlineMs) return { kind: 'failed' };
    const scope = { chainId: deployment.chainId, contractAddress: deployment.contractAddress, deploymentBlock: deployment.deploymentBlock };
    const timeout = createTimedAbortScope(undefined, { timeoutMs: Math.max(1, deadlineMs - Date.now()),
      timeoutMessage: 'Reveal verification timed out.' });
    try {
      return await raceWithSignal<RevealVerificationResult>(this.env.ETHEREUM_REVEAL_VERIFIER
        .getByName(`${scope.chainId}:${scope.contractAddress}:${work.claim.hash}`).inspect(scope, work, deadlineMs), timeout.signal);
    } finally { timeout.dispose(); }
  }

  private async verifyAtCapacity(deployment: EthereumRevealDeployment, hash: string, deadline: number): Promise<boolean> {
    let work = this.overflow.get(hash);
    if (!work) {
      if (!this.store.migrationReady() || Date.now() >= deadline) return false;
      const claim = this.store.claimOverflow(hash, Date.now(), deadline);
      if (!claim) return false;
      work = (async () => {
        const result = await this.inspect(deployment, { kind: 'overflow', claim }, deadline);
        if (!this.store.validOverflow(claim, Date.now())) return false;
        if (result.kind === 'throttled') this.store.recordThrottle(Date.now(), result.retryAfterMs);
        return result.kind === 'inspected' && this.store.acceptVerified(deployment, hash, result.inspection, claim.startedAtMs, Date.now());
      })().catch(() => false).finally(async () => {
        this.store.releaseOverflow(claim);
        this.overflow.delete(hash);
        this.receiptFinished(hash);
        this.startBackground(deployment);
        await this.arm();
      });
      this.overflow.set(hash, work);
      this.ctx.waitUntil(work);
    }
    if (!await this.withinBudget(work, deadline)) return false;
    return work;
  }

  private async processReceipt(deployment: EthereumRevealDeployment, claim: RevealReceiptClaim): Promise<void> {
    try {
      const result = await this.inspect(deployment, { kind: 'receipt', claim }, Math.min(claim.leaseUntilMs, Date.now() + 20_000));
      if (!this.store.validReceiptClaim(claim, Date.now())) return;
      if (result.kind === 'inspected') this.store.completeReceipt(deployment, claim, result.inspection, Date.now());
      else {
        if (result.kind === 'throttled') this.store.recordThrottle(Date.now(), result.retryAfterMs);
        this.store.failReceipt(claim, Date.now());
      }
    } catch { this.store.failReceipt(claim, Date.now()); }
  }

  private async processScan(deployment: EthereumRevealDeployment, claim: RevealScanClaim): Promise<void> {
    const signal = AbortSignal.timeout(45_000);
    try {
      if (claim.kind === 'crate') {
        const result = await recoverRevealCrates(this.env, deployment, claim.crateTokenIds, claim.range, signal);
        signal.throwIfAborted();
        this.store.completeCrateScan(claim, result, Date.now());
      } else {
        const result = await recoverRevealTokens(this.env, deployment, claim.tokenIds, claim.range, signal);
        signal.throwIfAborted();
        this.store.completeTokenScan(claim, result, Date.now());
      }
    } catch (error) {
      if (error instanceof EthereumRevealThrottleError) this.store.recordThrottle(Date.now(), error.retryAfterMs);
      this.store.failScan(claim, Date.now());
    }
  }

  private async publishBatch(deployment: EthereumRevealDeployment, jobs: RevealPublicationJob[], deadlineMs: number): Promise<RevealPublicationResult[]> {
    const timeout = createTimedAbortScope(undefined, { timeoutMs: Math.max(1, deadlineMs - Date.now()),
      timeoutMessage: 'Reveal publication timed out.' });
    let results: RevealPublicationOutcome[];
    try {
      const scope = { deploymentId: deployment.deploymentId, chainId: deployment.chainId,
        contractAddress: deployment.contractAddress, metadataBaseUri: deployment.metadataBaseUri };
      results = await raceWithSignal<RevealPublicationOutcome[]>(this.env.ETHEREUM_REVEAL_PUBLISHER
        .getByName(`${scope.chainId}:${scope.contractAddress}`).publishBatch(scope, jobs, deadlineMs), timeout.signal);
      if (results.length !== jobs.length || new Set(results.map(result => result.tokenId)).size !== jobs.length ||
        results.some(result => !jobs.some(job => job.token_id === result.tokenId) ||
          !['published', 'conflict', 'retry'].includes(result.status))) throw unavailable();
    } catch {
      results = jobs.map(job => ({ tokenId: job.token_id, status: 'retry' }));
    } finally { timeout.dispose(); }
    const statuses = new Map(results.map(result => [result.tokenId, result.status]));
    return jobs.map(job => ({ job, status: statuses.get(job.token_id)! }));
  }

  private async completePublications(deployment: EthereumRevealDeployment, results: RevealPublicationResult[]): Promise<void> {
    const applied = this.store.completePublications(results, Date.now());
    if (applied.some(result => result.status === 'conflict')) {
      await this.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET last_error='metadata-conflict',updated_at_ms=? WHERE deployment_id=?`)
        .bind(Date.now(), deployment.deploymentId).run();
    }
    for (const { job, status } of applied) {
      if (status === 'conflict') {
        console.error({ event: 'ethereum_reveal_metadata_conflict', deploymentId: deployment.deploymentId, tokenId: job.token_id });
      } else if (status === 'retry' && (job.attempts === 0 || ((job.attempts + 1) & job.attempts) === 0)) {
        console.error({ event: 'ethereum_reveal_publication_retry', deploymentId: deployment.deploymentId,
          tokenId: job.token_id, attempt: job.attempts + 1 });
      }
    }
  }

  private startBackground(deployment: EthereumRevealDeployment, preferredHash?: string, tokenIds?: string[]): void {
    if (!this.store.migrationReady()) {
      if (!this.migrationRun) {
        this.migrationRun = Promise.resolve().then(async () => {
          this.store.migrateChunk(Date.now(), 128);
          await this.arm();
        }).finally(() => {
          this.migrationRun = null;
          if (this.store.migrationReady()) this.pump(deployment, preferredHash, tokenIds);
        });
        this.ctx.waitUntil(this.migrationRun);
      }
    } else this.pump(deployment, preferredHash, tokenIds);
    this.ctx.waitUntil(this.runPublications(deployment));
  }

  private pump(deployment: EthereumRevealDeployment, preferredHash?: string, tokenIds?: string[]): void {
    if (!this.store.migrationReady()) return;
    for (let dispatched = 0; dispatched < 64; dispatched++) {
      const dispatch = this.store.dispatchState(Date.now());
      if (dispatch.inFlight >= dispatch.limit || dispatch.pauseUntilMs > Date.now()) break;
      const lane = dispatch.active < dispatch.limit - Math.max(1, Math.floor(dispatch.limit / 4)) ? 'active' : 'background';
      const excluded = [...this.receipts.keys(), ...this.overflow.keys()];
      const claim = this.store.claimReceipt(Date.now(), lane, lane === 'active' ? preferredHash : undefined, excluded)
        || this.store.claimReceipt(Date.now(), lane === 'active' ? 'background' : 'active', preferredHash, excluded);
      preferredHash = undefined;
      if (!claim) break;
      const promise = this.processReceipt(deployment, claim).finally(async () => {
        this.receipts.delete(claim.hash);
        this.receiptFinished(claim.hash);
        this.startBackground(deployment);
        await this.arm();
      });
      this.receipts.set(claim.hash, { active: claim.active, promise });
      this.ctx.waitUntil(promise);
    }
    for (let dispatched = 0; dispatched < 2 && this.scans.size < 2; dispatched++) {
      const active = [...this.scans.values()].filter(value => value.claim.active).length;
      const lane = active < 1 ? 'active' : 'background';
      const scope = tokenIds ? { tokenIds } : undefined;
      const claim = this.store.claimScan(Date.now(), lane, lane === 'active' ? scope : undefined)
        || this.store.claimScan(Date.now(), lane === 'active' ? 'background' : 'active', scope);
      tokenIds = undefined;
      if (!claim) break;
      const key = `${claim.kind}:${claim.id}`;
      if (this.scans.has(key)) { this.store.failScan(claim, Date.now()); break; }
      const promise = this.processScan(deployment, claim).finally(async () => {
        this.scans.delete(key);
        this.startBackground(deployment);
        await this.arm();
      });
      this.scans.set(key, { claim, promise });
      this.ctx.waitUntil(promise);
    }
  }

  private runPublications(deployment: EthereumRevealDeployment): Promise<void> {
    if (this.publicationRun) return this.publicationRun;
    const work = async () => {
      const deadline = Date.now() + 5_000;
      let processed = 0;
      while (processed < 512 && Date.now() < deadline) {
        const claimedAtMs = Date.now();
        const jobs = this.store.claimPublications(claimedAtMs, Math.min(64, 512 - processed));
        if (!jobs.length) break;
        processed += jobs.length;
        const results: RevealPublicationResult[] = [];
        let dispatched = 0;
        try {
          while (dispatched < jobs.length && Date.now() < deadline && Date.now() < claimedAtMs + 25_000) {
            const now = Date.now();
            const pause = this.store.dispatchState(now).active > 0 ? this.lastPublicationStartMs + 100 - now : 0;
            if (pause > 0) await new Promise<void>(resolve => { setTimeout(resolve, Math.min(pause, deadline - now)); });
            if (Date.now() >= deadline || Date.now() >= claimedAtMs + 25_000) break;
            const batch = jobs.slice(dispatched, dispatched + 8);
            this.lastPublicationStartMs = Date.now();
            results.push(...await this.publishBatch(deployment, batch, claimedAtMs + 25_000));
            dispatched += batch.length;
          }
          await this.completePublications(deployment, results);
        } finally { this.store.releasePublicationClaims(jobs.slice(dispatched), Date.now()); }
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
    this.startBackground(deployment);
    await this.runPublications(deployment);
    if (Date.now() - this.lastHealthReportMs >= 60_000) {
      this.lastHealthReportMs = Date.now();
      console.log({ event: 'ethereum_reveal_recovery_health', deploymentId: deployment.deploymentId, ...this.store.summary() });
    }
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
