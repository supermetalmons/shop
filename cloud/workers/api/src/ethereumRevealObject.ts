import { DurableObject } from 'cloudflare:workers';
import type { EthereumRevealResult, EthereumRevealTokensResponse, EthereumRevealTransactionResponse } from '../../../../shared/ethereum/reveal.js';
import { ETHEREUM_REVEAL_CATALOG_VERSION, readEthereumRevealDeployment,
  type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { EthereumApiError } from './ethereumError.js';
import { inspectRevealTransaction, recoverRevealTokens, recoverRevealCrates, verifyRevealDeployment } from './ethereumRevealChain.js';
import { validateRevealCatalog } from './ethereumRevealCatalog.js';
import { EthereumRevealStore, type RevealReceiptClaim, type RevealScanClaim, type RevealPublicationJob } from './ethereumRevealStore.js';

function unavailable(): EthereumApiError { return new EthereumApiError('unavailable', 'Artwork reveal is temporarily unavailable.'); }

async function finishTasks(tasks: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export class EthereumRevealObject extends DurableObject<Env> {
  private readonly store: EthereumRevealStore;
  private readonly receipts = new Map<string, { active: boolean; promise: Promise<void> }>();
  private readonly scans = new Map<string, { claim: RevealScanClaim; promise: Promise<void> }>();
  private readonly overflow = new Map<string, Promise<boolean>>();
  private migrationRun: Promise<void> | null = null;
  private publicationRun: Promise<void> | null = null;
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
    this.store.admitTokens(tokenIds, deployment.deploymentBlock, Date.now());
    await this.arm();
    this.startBackground(deployment, undefined, tokenIds);
    if (!snapshot.artworks.length) {
      const needed = new Set(tokenIds);
      while (Date.now() < deadline) {
        const response = this.store.tokensResponse(deployment, tokenIds);
        if (response.artworks.length || response.unresolved.every(value => value.status === 'unminted')) break;
        const hashes = new Set(this.store.provenance(tokenIds).map(value => value.transactionHash));
        const tasks = [...this.scans.values()].filter(value => value.claim.kind === 'tokens' &&
          value.claim.tokenIds.some(id => needed.has(id))).map(value => value.promise);
        for (const hash of hashes) {
          const work = this.receipts.get(hash)?.promise;
          if (work) tasks.push(work);
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

  private async verifyAtCapacity(deployment: EthereumRevealDeployment, hash: string, deadline: number): Promise<boolean> {
    let work = this.overflow.get(hash);
    if (!work) {
      if (!this.store.migrationReady() || this.receipts.size + this.overflow.size >= 4 || Date.now() >= deadline) return false;
      work = (async () => {
        const startedAtMs = Date.now();
        const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
        const result = await inspectRevealTransaction(this.env, deployment, hash, signal);
        signal.throwIfAborted();
        return this.store.acceptVerified(deployment, hash, result, startedAtMs, Date.now());
      })().catch(() => false).finally(() => { this.overflow.delete(hash); this.startBackground(deployment); });
      this.overflow.set(hash, work);
      this.ctx.waitUntil(work);
    }
    if (!await this.withinBudget(work, deadline)) return false;
    return work;
  }

  private async processReceipt(deployment: EthereumRevealDeployment, claim: RevealReceiptClaim): Promise<void> {
    const signal = AbortSignal.timeout(20_000);
    try {
      const result = await inspectRevealTransaction(this.env, deployment, claim.hash, signal, fetch,
        () => { this.store.recordReceiptPresence(claim, Date.now()); });
      signal.throwIfAborted();
      this.store.completeReceipt(deployment, claim, result, Date.now());
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
    } catch { this.store.failScan(claim, Date.now()); }
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
    for (let dispatched = 0; dispatched < 15 && this.receipts.size + this.overflow.size < 4; dispatched++) {
      const active = [...this.receipts.values()].filter(value => value.active).length + this.overflow.size;
      const lane = active < 3 ? 'active' : 'background';
      const excluded = [...this.receipts.keys(), ...this.overflow.keys()];
      const claim = this.store.claimReceipt(Date.now(), lane, lane === 'active' ? preferredHash : undefined, excluded)
        || this.store.claimReceipt(Date.now(), lane === 'active' ? 'background' : 'active', preferredHash, excluded);
      preferredHash = undefined;
      if (!claim) break;
      const promise = this.processReceipt(deployment, claim).finally(async () => {
        this.receipts.delete(claim.hash);
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
