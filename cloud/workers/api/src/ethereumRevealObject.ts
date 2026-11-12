import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { REVEAL_ENRICHMENT_VERSION, type EthereumRevealResult, type EthereumRevealTokensResponse, type EthereumRevealTransactionResponse } from '../../../../shared/ethereum/reveal.js';
import { readEthereumRevealDeployment,
  type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { EthereumApiError } from './ethereumError.js';
import { EthereumRevealThrottleError, recoverRevealTokens, recoverRevealCrates, verifyRevealDeployment, type RevealPresenceBudget } from './ethereumRevealChain.js';
import { validateRevealCatalog, isSupportedRevealDeployment } from './ethereumRevealCatalog.js';
import { EthereumRevealStore, type RevealReceiptClaim, type RevealScanClaim, type RevealPublicationJob,
  type RevealPublicationResult } from './ethereumRevealStore.js';
import { retryRevealProviderBudget, type RevealPermitRequest, type RevealProviderPermit, type RevealWorkAuthorization,
  type RevealVerificationResult, type RevealVerificationScope, type RevealVerificationWork } from './ethereumRevealVerification.js';
import { ethereumProviderBudget, waitForProvider } from './ethereumProvider.js';
import { PROVIDER_BUDGETS, type ProviderBudgetClient, type ProviderName } from './ethereumProviderBudget.js';
import type { PreparedAttributes, RevealPublicationOutcome } from './ethereumRevealPublisherObject.js';
import { attributePublisherName } from './ethereumRevealAttributes.js';
import { acknowledgedEnrichmentHash, matchesEnrichmentChecksum, REVEAL_ENRICHMENT_SLOTS, type RevealEnrichmentClaim, type RevealEnrichmentOutcome } from './ethereumRevealEnrichmentStore.js';
import type { EthereumRevealAttributeBackfillPage, EthereumRevealInspection, EthereumRevealPurgeResult, EthereumRevealReplacementInspection } from '../../../../shared/ethereum/revealMaintenance.js';
import { backfillRevealAttributePage } from './ethereumRevealAttributeBackfill.js';
import { parseRevealAttributeBackfillRequest, parseRevealMaintenanceRequest, parseRevealReplacementRequest, requireAttributeBackfillDeployment, requireRetiredRevealDeployment, requireRevealObjectIdentity, requireRevealReplacement,
  revealMaintenanceIdentity } from './ethereumRevealMaintenanceSupport.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import { EthereumRevealCatalogUpdate, parseCatalogUpdateRequest } from './ethereumRevealCatalogUpdate.js';
import { EthereumRevealCatalogUpdateStore } from './ethereumRevealCatalogUpdateStore.js';
import type { PublicationScope, MetadataWrite } from './ethereumRevealPublisherObject.js';
import type { EthereumRevealCatalogUpdateResult } from '../../../../shared/ethereum/revealMaintenance.js';
import { ETHEREUM_CATALOG_SNAPSHOT_PAGE_SIZE, type EthereumRevealCatalogSnapshot } from './ethereumCatalogRevision.js';
import { EthereumRevealEmptyPool, parseEmptyPoolRequest } from './ethereumRevealEmptyPool.js';
import { EthereumRevealEmptyPoolFence } from './ethereumRevealEmptyPoolFence.js';
import type { EthereumRevealEmptyPoolResult } from '../../../../shared/ethereum/revealMaintenance.js';

function unavailable(): EthereumApiError { return new EthereumApiError('unavailable', 'Artwork reveal is temporarily unavailable.'); }

export class EthereumRevealObject extends DurableObject<Env> {
  private configuredStore: EthereumRevealStore | null = null;
  private retiring = false;
  private catalogUpdater: EthereumRevealCatalogUpdate | null = null;
  private emptyPoolUpdater: EthereumRevealEmptyPool | null = null;
  private emptyPoolFence: EthereumRevealEmptyPoolFence | null = null;
  private transactionDepth = 0;
  private purgeRun: Promise<EthereumRevealPurgeResult> | null = null;
  private quiesceRun: Promise<{ quiesced: true }> | null = null;
  private readonly receipts = new Map<string, { active: boolean; promise: Promise<void> }>();
  private readonly scans = new Map<string, { claim: RevealScanClaim; promise: Promise<void> }>();
  private readonly overflow = new Map<string, Promise<boolean>>();
  private readonly receiptWaiters = new Map<string, Set<() => void>>();
  private migrationRun: Promise<void> | null = null;
  private publicationRun: Promise<void> | null = null;
  private readonly enrichmentLanes = new Set<Promise<void>>();
  private readonly enrichmentStop = new AbortController();
  private lastPublicationStartMs = 0;
  private alarmUpdate: Promise<void> | null = null;
  private alarmPending: Promise<void> | null = null;
  private lastHealthReportMs = 0;
  private providerBudgetClient: ProviderBudgetClient | null = null;
  private readonly providerPermits = new Map<string, { expiresAtMs: number; cancellation: AbortController;
    promise: Promise<RevealProviderPermit | undefined> }>();
  private readonly cancelledProviderPermits = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private get store(): EthereumRevealStore {
    if (!this.configuredStore) throw unavailable();
    return this.configuredStore;
  }

  private providerBudget(chainId: number): ProviderBudgetClient {
    return this.providerBudgetClient ??= ethereumProviderBudget(this.env, chainId);
  }

  private transaction<T>(action: () => T): T {
    if (this.transactionDepth) return action();
    return this.ctx.storage.transactionSync(() => {
      this.transactionDepth++;
      try { return action(); } finally { this.transactionDepth--; }
    });
  }

  private get rebuildFence(): EthereumRevealEmptyPoolFence {
    return this.emptyPoolFence ??= new EthereumRevealEmptyPoolFence(this.ctx.storage.sql, action => this.transaction(action));
  }

  async rebuildEmptyPool(deployment: EthereumRevealDeployment, value: unknown): Promise<EthereumRevealEmptyPoolResult> {
    const request = parseEmptyPoolRequest(value);
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL, deployment);
    if (request.deploymentId !== deployment.deploymentId || deployment.chainId !== 1 || this.retiring) throw unavailable();
    this.emptyPoolUpdater ??= new EthereumRevealEmptyPool({ env: this.env, storage: this.ctx.storage, fence: this.rebuildFence,
      initializeStore: () => {
        this.configuredStore ??= new EthereumRevealStore(this.ctx.storage.sql, action => this.transaction(action));
        return this.configuredStore.catalogUpdate;
      },
      readStore: () => new EthereumRevealCatalogUpdateStore(this.ctx.storage.sql, action => this.transaction(action)),
      quiescent: () => this.receipts.size === 0 && this.scans.size === 0 && this.overflow.size === 0 &&
        this.enrichmentLanes.size === 0 && !this.migrationRun && !this.publicationRun && !this.alarmUpdate && !this.alarmPending,
      wake: async current => { this.configure(current); await this.startBackground(current); await this.arm(); },
    });
    return this.emptyPoolUpdater.run(request, deployment);
  }

  private get updateController(): EthereumRevealCatalogUpdate {
    this.catalogUpdater ??= new EthereumRevealCatalogUpdate({ env: this.env, storage: this.ctx.storage,
      initializeStore: () => this.configuredStore ??= new EthereumRevealStore(this.ctx.storage.sql, action => this.transaction(action)),
      wake: async deployment => { this.configure(deployment); await this.startBackground(deployment); await this.pruneCatalogIndexes(); await this.arm(); },
    });
    return this.catalogUpdater;
  }

  async catalogUpdate(deployment: EthereumRevealDeployment, value: unknown): Promise<EthereumRevealCatalogUpdateResult> {
    const request = parseCatalogUpdateRequest(value);
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL, deployment);
    if (request.deploymentId !== deployment.deploymentId || this.retiring || this.rebuildFence.status()) throw unavailable();
    if (!['inspect', 'verify'].includes(request.action)) this.requireMaintenanceInventory(deployment);
    return this.updateController.run(request, deployment);
  }

  async validatePublication(scope: PublicationScope, job: MetadataWrite): Promise<boolean> {
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL, scope);
    if (this.retiring || this.rebuildFence.status()) return false;
    const deployment = await readEthereumRevealDeployment(this.env.OPS_DB, scope);
    if (!deployment || deployment.retiredAtMs != null || deployment.deploymentId !== scope.deploymentId ||
      deployment.metadataBaseUri !== scope.metadataBaseUri) return false;
    this.configure(deployment);
    return this.store.catalogUpdate.validateMetadataWrite(job);
  }

  async catalogSnapshot(deployment: EthereumRevealDeployment, tokenIds: string[] = []): Promise<EthereumRevealCatalogSnapshot> {
    if (!Array.isArray(tokenIds) || tokenIds.length > ETHEREUM_CATALOG_SNAPSHOT_PAGE_SIZE || tokenIds.some(tokenId => !/^[1-9]\d*$/.test(tokenId) || BigInt(tokenId) > 111111n)) {
      throw new Error('Invalid catalog snapshot token IDs.');
    }
    deployment = await this.authorize(deployment);
    return { deploymentId: deployment.deploymentId, catalogRevision: this.store.catalogUpdate.effectiveCatalog()?.catalogRevision ?? 0,
      artworks: this.store.catalogUpdate.canonicalMetadata(tokenIds).map(value => ({ tokenId: value.tokenId,
        metadataJson: value.metadataJson, metadataRevision: value.metadataRevision })) };
  }

  private configure(deployment: EthereumRevealDeployment): void {
    if (this.retiring || this.rebuildFence.status() || deployment.retiredAtMs != null || !isSupportedRevealDeployment(deployment) ||
      deployment.chainId === 31337 && this.env.ETHEREUM_111K_CHAIN_ID !== '31337') throw unavailable();
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL, deployment);
    validateRevealCatalog();
    this.configuredStore ??= new EthereumRevealStore(this.ctx.storage.sql, action => this.transaction(action));
    this.store.configure(deployment);
  }

  private async authorize(deployment: EthereumRevealDeployment, deadline?: number): Promise<EthereumRevealDeployment> {
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL, deployment);
    if (this.retiring || this.rebuildFence.status()) throw unavailable();
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && (!Number.isFinite(remaining) || remaining <= 0)) throw unavailable();
    const timeout = remaining === undefined ? undefined : createTimedAbortScope(undefined,
      { timeoutMs: remaining, timeoutMessage: 'Reveal authorization timed out.' });
    let canonical: EthereumRevealDeployment | null;
    try {
      const read = readEthereumRevealDeployment(this.env.OPS_DB, deployment);
      canonical = await (timeout ? raceWithSignal(read, timeout.signal) : read);
    } catch { throw unavailable(); }
    finally { timeout?.dispose(); }
    if (deadline !== undefined && Date.now() >= deadline) throw unavailable();
    if (!canonical || canonical.deploymentId !== deployment.deploymentId || canonical.retiredAtMs != null || this.retiring) {
      if (canonical?.retiredAtMs != null) this.retiring = true;
      throw unavailable();
    }
    this.configure(canonical);
    return this.store.catalogUpdate.effectiveDeployment(canonical);
  }

  private async canContinue(scope: Pick<EthereumRevealDeployment, 'chainId' | 'contractAddress'>): Promise<boolean> {
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL, scope);
    if (this.retiring || this.rebuildFence.status()) return false;
    const canonical = await readEthereumRevealDeployment(this.env.OPS_DB, scope);
    if (canonical?.retiredAtMs != null) this.retiring = true;
    return !this.retiring && !this.rebuildFence.status() && canonical !== null && isSupportedRevealDeployment(canonical);
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
    deployment = await this.authorize(deployment);
    this.configure(deployment);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deployment.templateJson));
    if (!await this.canContinue(deployment)) throw unavailable();
    const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (hash !== deployment.templateSha256) throw new Error('Reveal template checksum mismatch.');
    for (let index = 0; index < 5 && !this.store.ready(); index++) this.store.initializeChunk();
    if (this.store.ready() && deployment.state === 'provisioning') {
      await verifyRevealDeployment(this.env, deployment, AbortSignal.timeout(15_000));
      if (!await this.canContinue(deployment)) throw unavailable();
      const now = Date.now();
      await this.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET state='ready',provisioned_at_ms=?,
        revision=revision+1,updated_at_ms=?,last_error=NULL WHERE deployment_id=? AND state='provisioning'
        AND template_sha256=? AND retired_at_ms IS NULL`).bind(now, now, deployment.deploymentId, deployment.templateSha256).run();
    }
    if (!this.store.ready()) await this.ctx.storage.setAlarm(Date.now() + 250);
    const summary = this.store.summary();
    return { ready: summary.ready, seeded: summary.seeded };
  }

  async revealTransaction(deployment: EthereumRevealDeployment, hash: string, admit = false, deadlineMs?: number): Promise<EthereumRevealResult<EthereumRevealTransactionResponse>> {
    const deadline = Math.min(Date.now() + 2_000, deadlineMs ?? Infinity);
    deployment = await this.authorize(deployment, deadline);
    this.requireReady(deployment);
    const snapshot = this.store.transactionResponse(deployment, hash);
    if (snapshot.status !== 'pending') return { kind: 'ready', value: snapshot };
    const admission = this.admitTransactionWork(deployment, hash, admit);
    if (admission === 'admission') return { kind: 'admission' };
    if (admission === 'capacity') {
      if (!await this.verifyAtCapacity(deployment, hash, deadline)) return { kind: 'capacity' };
    }
    await this.startForeground(deployment, deadline, hash);
    const work = this.receipts.get(hash)?.promise;
    if (work) await this.withinBudget(work, deadline);
    else if (this.store.dispatchState(Date.now()).inFlight) await this.waitForReceipt(hash, deadline);
    if (this.retiring) throw unavailable();
    const response = this.store.transactionResponse(deployment, hash);
    if (response.status === 'pending' && !this.store.knownTransaction(hash)) {
      const readmission = this.admitTransactionWork(deployment, hash, admit);
      if (readmission !== 'accepted') return { kind: readmission };
      await this.waitForAlarm(this.arm(), deadline);
    }
    return { kind: 'ready', value: response };
  }

  async revealTokens(deployment: EthereumRevealDeployment, tokenIds: string[], admit = false, deadlineMs?: number): Promise<EthereumRevealResult<EthereumRevealTokensResponse>> {
    const deadline = Math.min(Date.now() + 2_000, deadlineMs ?? Infinity);
    deployment = await this.authorize(deployment, deadline);
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
    await this.startForeground(deployment, deadline, undefined, tokenIds);
    if (!snapshot.artworks.length || waitingTokens.size) {
      const needed = waitingTokens.size ? waitingTokens : new Set(tokenIds);
      while (Date.now() < deadline) {
        if (this.retiring) throw unavailable();
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
    if (this.retiring) throw unavailable();
    return { kind: 'ready', value: this.store.tokensResponse(deployment, tokenIds) };
  }

  private async waitForAlarm(work: Promise<void>, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw unavailable();
    const timeout = createTimedAbortScope(undefined, { timeoutMs: remaining, timeoutMessage: 'Reveal scheduling timed out.' });
    try { await raceWithSignal(work, timeout.signal); }
    catch { throw unavailable(); }
    finally { timeout.dispose(); }
    if (this.retiring) throw unavailable();
  }

  private async startForeground(deployment: EthereumRevealDeployment, deadline: number, hash?: string, tokenIds?: string[]): Promise<void> {
    const armed = this.arm();
    const started = armed.then(() => this.startBackground(deployment, hash, tokenIds));
    this.ctx.waitUntil(started.catch(() => undefined));
    await this.waitForAlarm(armed, deadline);
    await this.withinBudget(started, deadline);
    if (this.retiring) throw unavailable();
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

  private async matchesScope(scope: RevealVerificationScope): Promise<boolean> {
    if (!this.ctx.id.equals(this.env.ETHEREUM_REVEAL.idFromName(`${scope.chainId}:${scope.contractAddress}`))) return false;
    if (this.retiring || this.rebuildFence.status()) return false;
    const deployment = await readEthereumRevealDeployment(this.env.OPS_DB, scope);
    if (this.retiring || !deployment || deployment.retiredAtMs != null || !isSupportedRevealDeployment(deployment) ||
      deployment.deploymentBlock !== scope.deploymentBlock) return false;
    this.configure(deployment);
    const identity = this.store.identity();
    return identity?.chainId === scope.chainId && identity.contractAddress === scope.contractAddress;
  }

  async validateReceiptWork(scope: RevealVerificationScope, work: RevealVerificationWork): Promise<boolean> {
    if (!await this.matchesScope(scope) || this.retiring) return false;
    return work.kind === 'receipt' ? this.store.validReceiptClaim(work.claim, Date.now()) : this.store.validOverflow(work.claim, Date.now());
  }

  async recordReceiptPresence(scope: RevealVerificationScope, work: RevealVerificationWork): Promise<boolean> {
    if (!await this.matchesScope(scope) || this.retiring) return false;
    return work.kind === 'receipt' ? this.store.recordReceiptPresence(work.claim, Date.now()) : this.store.validOverflow(work.claim, Date.now());
  }

  private async receiptPermit(scope: RevealVerificationScope, work: RevealVerificationWork, deadlineMs: number,
    permitId: string, provider: ProviderName, minimum: number, wanted: number, wait = false): Promise<RevealProviderPermit | undefined> {
    if (scope.chainId === 31337 || this.env.ETHEREUM_PROVIDER_CONTROL_ENABLED !== 'true') return;
    if (typeof permitId !== 'string' || !/^[0-9a-f-]{36}$/.test(permitId)) throw new Error('Invalid reveal provider request.');
    const deadline = Math.min(deadlineMs, work.claim.leaseUntilMs);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) return;
    for (const [key, value] of this.providerPermits) if (value.expiresAtMs <= Date.now()) this.providerPermits.delete(key);
    for (const [key, expiresAtMs] of this.cancelledProviderPermits) if (expiresAtMs <= Date.now()) this.cancelledProviderPermits.delete(key);
    if (this.cancelledProviderPermits.has(`${work.claim.claimId}:${permitId}`)) return;
    const key = `${work.claim.claimId}:${permitId}:${provider}:${minimum}:${wanted}`;
    const existing = this.providerPermits.get(key);
    if (existing) return existing.promise;
    const lane = work.claim.active ? 'reveal' : 'background';
    const budget = this.providerBudget(scope.chainId);
    if (!wait && budget.available(provider, lane) < minimum) return;
    const entry = { expiresAtMs: deadline, cancellation: new AbortController(),
      promise: Promise.resolve<RevealProviderPermit | undefined>(undefined) };
    entry.promise = (async () => {
      const timeout = createTimedAbortScope(entry.cancellation.signal, { timeoutMs: Math.max(1, deadline - Date.now()),
        timeoutMessage: 'Reveal provider authorization timed out.' });
      try {
        const grant = wait
          ? await retryRevealProviderBudget(() => budget.grant(provider, lane, minimum, wanted, timeout.signal), timeout.signal)
          : await budget.grant(provider, lane, minimum, wanted, timeout.signal);
        entry.expiresAtMs = Math.min(deadline, grant.expiresAtMs);
        if (this.retiring || timeout.signal.aborted || entry.expiresAtMs <= Date.now() || this.rebuildFence.status() ||
          !(work.kind === 'receipt' ? this.store.validReceiptClaim(work.claim, Date.now()) : this.store.validOverflow(work.claim, Date.now()))) return;
        return { provider, lane, grant };
      } catch { return undefined; }
      finally { timeout.dispose(); }
    })();
    this.providerPermits.set(key, entry);
    return entry.promise;
  }

  async requestReceiptPermit(scope: RevealVerificationScope, work: RevealVerificationWork,
    deadlineMs: number, request: RevealPermitRequest): Promise<RevealWorkAuthorization> {
    if (!['alchemy', 'quicknode'].includes(request.provider) || !Number.isSafeInteger(request.minimum) ||
      !Number.isSafeInteger(request.wanted) || request.minimum < 1 || request.wanted < request.minimum ||
      request.wanted > PROVIDER_BUDGETS[request.provider].maxGrant) throw new Error('Invalid reveal provider request.');
    if (!await this.validateReceiptWork(scope, work)) return { valid: false };
    const permit = await this.receiptPermit(scope, work, deadlineMs, request.requestId, request.provider,
      request.minimum, request.wanted, true);
    return { valid: !!permit, ...(permit && { permit }) };
  }

  async cancelReceiptPermit(scope: RevealVerificationScope, work: RevealVerificationWork, requestId: string): Promise<void> {
    if (!this.ctx.id.equals(this.env.ETHEREUM_REVEAL.idFromName(`${scope.chainId}:${scope.contractAddress}`))) return;
    const prefix = `${work.claim.claimId}:${requestId}`;
    this.cancelledProviderPermits.set(prefix, work.claim.leaseUntilMs);
    const pending: Array<Promise<unknown>> = [];
    for (const [key, entry] of this.providerPermits) if (key.startsWith(`${prefix}:`)) {
      entry.cancellation.abort(new Error('Reveal permit request cancelled.'));
      pending.push(entry.promise);
    }
    await Promise.allSettled(pending);
  }

  async reportReceiptThrottle(scope: RevealVerificationScope, provider: ProviderName, retryAfterMs: number): Promise<void> {
    if (!this.ctx.id.equals(this.env.ETHEREUM_REVEAL.idFromName(`${scope.chainId}:${scope.contractAddress}`))) return;
    await this.providerBudget(scope.chainId).reportThrottle(provider, retryAfterMs);
  }

  async recordReceiptPresenceWithBudget(scope: RevealVerificationScope, work: RevealVerificationWork,
    deadlineMs: number, permitId: string, budget?: RevealPresenceBudget): Promise<RevealWorkAuthorization> {
    if (!await this.recordReceiptPresence(scope, work)) return { valid: false };
    if (!budget || budget.provider === 'local') return { valid: true };
    if (budget.provider === 'alchemy' ? ![30, 66].includes(budget.cost) : ![2, 3].includes(budget.cost)) {
      throw new Error('Invalid reveal provider authorization.');
    }
    const permit = await this.receiptPermit(scope, work, deadlineMs, permitId, budget.provider, budget.cost, budget.cost);
    return { valid: true, ...(permit && { permit }) };
  }

  private async inspect(deployment: EthereumRevealDeployment, work: RevealVerificationWork, deadlineMs: number): Promise<RevealVerificationResult> {
    if (Date.now() >= deadlineMs) return { kind: 'failed' };
    const scope = { chainId: deployment.chainId, contractAddress: deployment.contractAddress, deploymentBlock: deployment.deploymentBlock };
    const delegated: RevealVerificationWork = { kind: work.kind, claim: work.claim,
      ...(scope.chainId !== 31337 && this.env.ETHEREUM_PROVIDER_CONTROL_ENABLED === 'true' ? { providerBudgetProtocol: 1 } : {}) };
    const verifier = this.env.ETHEREUM_REVEAL_VERIFIER.getByName(`${scope.chainId}:${scope.contractAddress}:${work.claim.hash}`);
    const timeout = createTimedAbortScope(undefined, { timeoutMs: Math.max(1, deadlineMs - Date.now()),
      timeoutMessage: 'Reveal verification timed out.' });
    try { return await raceWithSignal<RevealVerificationResult>(verifier.inspect(scope, delegated, deadlineMs), timeout.signal); }
    catch (error) {
      const cancellation = createTimedAbortScope(undefined, { timeoutMs: 250,
        timeoutMessage: 'Reveal cancellation acknowledgment timed out.' });
      try { await raceWithSignal(verifier.cancelInspection(scope, delegated), cancellation.signal); }
      catch {
        console.error({ event: 'ethereum_reveal_cancellation_unconfirmed', deploymentId: deployment.deploymentId,
          transactionHash: work.claim.hash, kind: work.kind });
        if (!timeout.signal.aborted) await waitForProvider(Math.max(1, deadlineMs - Date.now()), timeout.signal).catch(() => undefined);
      } finally { cancellation.dispose(); }
      throw error;
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
        if (!await this.canContinue(deployment)) return false;
        if (!this.store.validOverflow(claim, Date.now())) return false;
        if (result.kind === 'throttled') this.store.recordThrottle(Date.now(), result.retryAfterMs);
        return result.kind === 'inspected' && this.store.acceptVerified(deployment, hash, result.inspection, claim.startedAtMs, Date.now());
      })().catch(() => false).finally(async () => {
        if (await this.canContinue(deployment).catch(() => false)) this.store.releaseOverflow(claim);
        this.overflow.delete(hash);
        this.receiptFinished(hash);
        await this.startBackground(deployment);
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
      if (!await this.canContinue(deployment)) return;
      if (!this.store.validReceiptClaim(claim, Date.now())) return;
      if (result.kind === 'inspected') this.store.completeReceipt(deployment, claim, result.inspection, Date.now());
      else {
        if (result.kind === 'throttled') this.store.recordThrottle(Date.now(), result.retryAfterMs);
        this.store.failReceipt(claim, Date.now());
      }
    } catch { if (await this.canContinue(deployment).catch(() => false)) this.store.failReceipt(claim, Date.now()); }
  }

  private async processScan(deployment: EthereumRevealDeployment, claim: RevealScanClaim): Promise<void> {
    const signal = AbortSignal.timeout(45_000);
    try {
      if (claim.kind === 'crate') {
        const result = await retryRevealProviderBudget(() => recoverRevealCrates(this.env, deployment, claim.crateTokenIds,
          claim.range, signal, fetch, { active: claim.active, budgetClient: this.providerBudget(deployment.chainId) }), signal);
        signal.throwIfAborted();
        if (!await this.canContinue(deployment)) return;
        this.store.completeCrateScan(claim, result, Date.now());
      } else {
        const result = await retryRevealProviderBudget(() => recoverRevealTokens(this.env, deployment, claim.tokenIds,
          claim.range, signal, fetch, { active: claim.active, budgetClient: this.providerBudget(deployment.chainId) }), signal);
        signal.throwIfAborted();
        if (!await this.canContinue(deployment)) return;
        this.store.completeTokenScan(claim, result, Date.now());
      }
    } catch (error) {
      if (!await this.canContinue(deployment).catch(() => false)) return;
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
          !['published', 'conflict', 'retry', 'superseded'].includes(result.status))) throw unavailable();
    } catch {
      results = jobs.map(job => ({ tokenId: job.token_id, status: 'retry' }));
    } finally { timeout.dispose(); }
    const statuses = new Map(results.map(result => [result.tokenId, result.status]));
    return jobs.flatMap(job => {
      const status = statuses.get(job.token_id)!;
      return status === 'superseded' ? [] : [{ job, status }];
    });
  }

  private async completePublications(deployment: EthereumRevealDeployment, results: RevealPublicationResult[]): Promise<void> {
    if (!await this.canContinue(deployment)) return;
    const applied = this.store.completePublications(results, Date.now());
    if (applied.some(result => result.status === 'conflict')) {
      await this.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET last_error='metadata-conflict',updated_at_ms=? WHERE deployment_id=? AND retired_at_ms IS NULL`)
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

  private async startBackground(deployment: EthereumRevealDeployment, preferredHash?: string, tokenIds?: string[]): Promise<void> {
    if (!await this.canContinue(deployment)) return;
    if (!this.store.migrationReady()) {
      if (!this.migrationRun) {
        this.migrationRun = Promise.resolve().then(async () => {
          if (!await this.canContinue(deployment)) return;
          this.store.migrateChunk(Date.now(), 128);
          await this.arm();
        }).finally(async () => {
          this.migrationRun = null;
          if (await this.canContinue(deployment).catch(() => false) && this.store.migrationReady()) this.pump(deployment, preferredHash, tokenIds);
        });
        this.ctx.waitUntil(this.migrationRun);
      }
    } else this.pump(deployment, preferredHash, tokenIds);
    this.ctx.waitUntil(this.runPublications(deployment));
  }

  private pump(deployment: EthereumRevealDeployment, preferredHash?: string, tokenIds?: string[]): void {
    if (this.retiring || !this.store.migrationReady()) return;
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
        await this.startBackground(deployment);
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
        await this.startBackground(deployment);
        await this.arm();
      });
      this.scans.set(key, { claim, promise });
      this.ctx.waitUntil(promise);
    }
  }

  private runPublications(deployment: EthereumRevealDeployment): Promise<void> {
    if (this.retiring) return Promise.resolve();
    if (this.publicationRun) return this.publicationRun;
    const work = async () => {
      if (!await this.canContinue(deployment)) return;
      const deadline = Date.now() + 5_000;
      let processed = 0;
      while (!this.retiring && processed < 512 && Date.now() < deadline) {
        const claimedAtMs = Date.now();
        const jobs = this.store.claimPublications(claimedAtMs, Math.min(64, 512 - processed));
        if (!jobs.length) break;
        processed += jobs.length;
        const results: RevealPublicationResult[] = [];
        let dispatched = 0;
        try {
          while (!this.retiring && dispatched < jobs.length && Date.now() < deadline && Date.now() < claimedAtMs + 25_000) {
            const now = Date.now();
            const pause = this.store.dispatchState(now).active > 0 ? this.lastPublicationStartMs + 100 - now : 0;
            if (pause > 0) await new Promise<void>(resolve => { setTimeout(resolve, Math.min(pause, deadline - now)); });
            if (this.retiring || Date.now() >= deadline || Date.now() >= claimedAtMs + 25_000) break;
            const batch = jobs.slice(dispatched, dispatched + 8);
            this.lastPublicationStartMs = Date.now();
            results.push(...await this.publishBatch(deployment, batch, claimedAtMs + 25_000));
            dispatched += batch.length;
          }
          await this.completePublications(deployment, results);
        } finally { if (await this.canContinue(deployment).catch(() => false)) this.store.releasePublicationClaims(jobs.slice(dispatched), Date.now()); }
      }
    };
    this.publicationRun = work().finally(async () => {
      this.publicationRun = null;
      await this.arm();
    });
    return this.publicationRun;
  }

  private async enrich(deployment: EthereumRevealDeployment, job: RevealEnrichmentClaim, deadlineMs: number): Promise<RevealEnrichmentOutcome> {
    const timeout = createTimedAbortScope(this.enrichmentStop.signal, { timeoutMs: Math.max(0, deadlineMs - Date.now()),
      timeoutMessage: 'Reveal attribute enrichment timed out.' });
    let failure: RevealEnrichmentOutcome = 'source-unavailable';
    try {
      const scope = { deploymentId: deployment.deploymentId, chainId: deployment.chainId,
        contractAddress: deployment.contractAddress, metadataBaseUri: deployment.metadataBaseUri };
      const writer = this.env.ETHEREUM_REVEAL_PUBLISHER.getByName(attributePublisherName(scope));
      let metadataJson = job.target_json;
      if (metadataJson === null) {
        if (job.target_sha256 !== null || job.acknowledged_sha256 !== null ||
          job.last_error === 'conflict-recheck' || job.last_error === 'publication-unavailable') return 'conflict';
        const target = await raceWithSignal<PreparedAttributes>(writer.prepareAttributes(scope, {
          category: job.category, assetId: job.asset_id, baseJson: job.metadata_json,
          catalogVersion: this.store.catalogUpdate.effectiveCatalog()?.catalogVersion,
          catalogSha256: this.store.catalogUpdate.effectiveCatalog()?.manifestSha256,
        }, deadlineMs), timeout.signal);
        if (target.status !== 'prepared') return target.status;
        await this.authorize(deployment, deadlineMs);
        timeout.signal.throwIfAborted();
        if (!this.store.enrichment.stage(job, target.metadataJson, target.metadataSha256)) return 'source-unavailable';
        metadataJson = target.metadataJson;
      } else if (!matchesEnrichmentChecksum(metadataJson, job.target_sha256, job.acknowledged_sha256)) return 'conflict';
      failure = 'publication-unavailable';
      timeout.signal.throwIfAborted();
      const result = await raceWithSignal(writer.publishAttributes(scope, {
        tokenId: job.token_id, baseJson: job.metadata_json, metadataJson, metadataRevision: job.metadata_revision,
      }, deadlineMs), timeout.signal);
      if (result.tokenId === job.token_id && (result.status === 'published' || result.status === 'conflict')) return result.status;
      return failure;
    } catch {
      return failure;
    } finally { timeout.dispose(); }
  }

  private runEnrichment(deployment: EthereumRevealDeployment): Promise<void> {
    if (this.retiring || this.enrichmentLanes.size >= REVEAL_ENRICHMENT_SLOTS) return Promise.resolve();
    const startedAt = Date.now();
    const first = this.store.enrichment.claim(startedAt, REVEAL_ENRICHMENT_SLOTS - this.enrichmentLanes.size);
    if (!first.length) return Promise.resolve();
    const armed = this.arm();
    let claimed = first.length;
    const runLane = async (initial: RevealEnrichmentClaim) => {
      await armed;
      let job: RevealEnrichmentClaim | undefined = initial;
      while (job && !this.retiring && Date.now() < startedAt + 25_000) {
        const outcome = await this.enrich(deployment, job, startedAt + 25_000);
        if (this.retiring || !await this.authorize(deployment, Date.now() + 5_000).catch(() => null)) return;
        const updated = this.store.enrichment.complete(job, outcome, Date.now());
        if (updated && outcome !== 'published' && (outcome === 'conflict' || outcome === 'invalid' || (job.attempts & (job.attempts - 1)) === 0)) {
          console.error({ event: 'ethereum_reveal_enrichment_error', deploymentId: deployment.deploymentId,
            tokenId: job.token_id, attempt: job.attempts, reason: outcome });
        }
        if (claimed >= 64 || Date.now() >= startedAt + 5_000) return;
        [job] = this.store.enrichment.claim(Date.now(), 1);
        if (job) claimed++;
      }
    };
    const lanes = first.map(job => {
      const lane = runLane(job).finally(async () => {
        this.enrichmentLanes.delete(lane);
        await this.arm();
      });
      this.enrichmentLanes.add(lane);
      return lane;
    });
    return Promise.allSettled(lanes).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    });
  }

  private arm(): Promise<void> {
    if (this.retiring || this.rebuildFence.status()) return Promise.resolve();
    if (this.alarmPending) return this.alarmPending;
    const update = (this.alarmUpdate ?? Promise.resolve()).catch(() => undefined).then(async () => {
      this.alarmPending = null;
      try {
        if (this.retiring) return;
        const identity = this.configuredStore?.identity();
        if (!identity || !await this.canContinue(identity)) return;
        const current = await this.ctx.storage.getAlarm();
        if (this.retiring) return;
        const next = this.store.nextWake(Date.now(), this.enrichmentLanes.size >= REVEAL_ENRICHMENT_SLOTS);
        if (next !== null && (current === null || current > next)) await this.ctx.storage.setAlarm(next);
      } finally { if (this.alarmUpdate === update) this.alarmUpdate = null; }
    });
    this.alarmPending = update;
    this.alarmUpdate = update;
    this.ctx.waitUntil(update.catch(() => undefined));
    return update;
  }

  async watchdog(deployment: EthereumRevealDeployment): Promise<void> {
    if (this.rebuildFence.status()) return;
    deployment = await this.authorize(deployment);
    this.configure(deployment);
    if (deployment.state === 'provisioning') { await this.initialize(deployment); return; }
    if (!this.store.ready()) throw unavailable();
    await this.startBackground(deployment);
    this.ctx.waitUntil(this.runEnrichment(deployment));
    await this.runPublications(deployment);
    if (this.retiring) return;
    await this.pruneCatalogIndexes();
    if (Date.now() - this.lastHealthReportMs >= 60_000) {
      this.lastHealthReportMs = Date.now();
      console.log({ event: 'ethereum_reveal_recovery_health', deploymentId: deployment.deploymentId, ...this.store.summary() });
    }
    const publicationError = this.store.publicationError();
    if (deployment.lastError !== publicationError && (deployment.lastError === null ||
      deployment.lastError === 'metadata-conflict' || deployment.lastError === 'publication-unavailable')) {
      await this.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET last_error=?,updated_at_ms=?
        WHERE deployment_id=? AND last_error IS ? AND retired_at_ms IS NULL`).bind(publicationError, Date.now(), deployment.deploymentId, deployment.lastError).run();
    }
  }

  private async pruneCatalogIndexes(): Promise<void> {
    if (this.retiring || this.rebuildFence.status() || !this.configuredStore) return;
    const cleanup = this.store.catalogUpdate.pruneObsolete(256);
    if (!cleanup.remaining) return;
    const next = Date.now() + 250;
    const alarm = await this.ctx.storage.getAlarm();
    if (!this.retiring && (alarm === null || alarm > next)) await this.ctx.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    try {
      if (this.rebuildFence.status()) { await this.ctx.storage.deleteAlarm(); return; }
      const settings = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' AND name='settings'").toArray();
      const saved = !this.retiring && settings.length
        ? this.ctx.storage.sql.exec<{ deployment_json: string }>('SELECT deployment_json FROM settings WHERE id=1').toArray()[0] : undefined;
      if (!saved) { await this.ctx.storage.deleteAlarm(); return; }
      const identity = JSON.parse(saved.deployment_json) as { chainId: number; contractAddress: string };
      const deployment = await readEthereumRevealDeployment(this.env.OPS_DB, identity);
      if (this.retiring || !deployment || deployment.retiredAtMs != null || !isSupportedRevealDeployment(deployment)) {
        if (deployment?.retiredAtMs != null) this.retiring = true;
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await this.watchdog(deployment);
    } catch {
      if (!this.retiring && !this.rebuildFence.status()) await this.ctx.storage.setAlarm(Date.now() + 10_000);
      throw unavailable();
    }
  }

  private requireMaintenanceInventory(deployment: EthereumRevealDeployment): void {
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL, deployment);
    if (this.retiring || this.rebuildFence.status() || !this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='settings'").toArray().length) {
      throw new Error('Replacement reveal inventory is not provisioned.');
    }
    const saved = this.ctx.storage.sql.exec<{ deployment_json: string; ready: number }>('SELECT deployment_json,ready FROM settings WHERE id=1').toArray()[0];
    if (!saved || saved.ready !== 1) throw new Error('Replacement reveal inventory is not ready.');
    const identity = JSON.parse(saved.deployment_json) as Record<string, unknown>;
    if (!Object.entries(identity).every(([key, entry]) => deployment[key as keyof EthereumRevealDeployment] === entry) ||
      identity.deploymentId !== deployment.deploymentId || identity.contractAddress !== deployment.contractAddress ||
      identity.chainId !== deployment.chainId || identity.metadataBaseUri !== deployment.metadataBaseUri) {
      throw new Error('Replacement reveal inventory identity does not match its registration.');
    }
  }

  async backfillAttributes(value: unknown): Promise<EthereumRevealAttributeBackfillPage> {
    const request = parseRevealAttributeBackfillRequest(value);
    const deployment = await requireAttributeBackfillDeployment(this.env, request);
    this.requireMaintenanceInventory(deployment);
    if (!request.write) return backfillRevealAttributePage(this.ctx.storage.sql, request);
    this.configure(deployment);
    const page = this.ctx.storage.transactionSync(() => backfillRevealAttributePage(this.ctx.storage.sql, request));
    await this.arm();
    return page;
  }

  async inspectReplacement(value: unknown): Promise<EthereumRevealReplacementInspection> {
    const request = parseRevealReplacementRequest(value);
    const deployment = await requireRevealReplacement(this.env, request);
    this.requireMaintenanceInventory(deployment);
    const hasEnrichment = this.hasEnrichmentLedger();
    this.requireHealthyPublication(hasEnrichment);
    const frozenThroughMs = request.frozenThroughMs ?? Math.max(0, Date.now() - 1);
    const digest = createHash('sha256');
    const frozenSamples: EthereumRevealReplacementInspection['frozenSamples'] = [];
    const catalogs = new EthereumRevealCatalogUpdateStore(this.ctx.storage.sql, action => this.ctx.storage.transactionSync(action));
    const amended = (catalogs.effectiveCatalog()?.catalogRevision ?? 0) > 0;
    let frozenArtworks = 0;
    for (const row of this.ctx.storage.sql.exec<{ token_id: string; category: string; metadata_json: string }>(`SELECT token_id,category,metadata_json
      FROM assignments WHERE token_id IS NOT NULL AND frozen_at_ms<=? ORDER BY length(token_id),token_id`, frozenThroughMs)) {
      frozenArtworks++;
      digest.update(JSON.stringify([row.token_id, row.metadata_json]) + '\n');
      if (frozenSamples.length < 8) {
        const sample: typeof frozenSamples[number] = { tokenId: row.token_id,
          metadataSha256: createHash('sha256').update(row.metadata_json).digest('hex') };
        const canonical = amended && row.category === 'egg' ? catalogs.canonicalMetadata([row.token_id])[0] : undefined;
        const mapped = canonical && canonical.category !== 'egg';
        if (mapped) sample.metadataSha256 = canonical.targetSha256;
        const target = !mapped && hasEnrichment && this.ctx.storage.sql.exec<{ version: string; target_sha256: string; target_json: string; status: string }>(
          'SELECT version,target_sha256,target_json,status FROM reveal_enrichment WHERE token_id=? AND target_sha256 IS NOT NULL', row.token_id).toArray()[0];
        if (target) {
          const acknowledged = acknowledgedEnrichmentHash(this.ctx.storage.sql, row.token_id, target.version);
          if (target.version !== REVEAL_ENRICHMENT_VERSION || !matchesEnrichmentChecksum(target.target_json, target.target_sha256, acknowledged)) {
            throw new Error('Replacement enrichment revision is invalid.');
          }
          sample.enrichment = { version: target.version, sha256: target.target_sha256, published: target.status === 'published' || acknowledged !== undefined };
        }
        frozenSamples.push(sample);
      }
    }
    await requireRevealReplacement(this.env, request);
    this.requireHealthyPublication(this.hasEnrichmentLedger());
    return { ...revealMaintenanceIdentity(deployment), ready: true, frozenThroughMs, frozenArtworks,
      frozenMetadataSha256: digest.digest('hex'), frozenSamples };
  }

  private hasEnrichmentLedger(): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_enrichment'").toArray().length > 0;
  }

  private requireHealthyPublication(hasEnrichment: boolean): void {
    if (this.ctx.storage.sql.exec(`SELECT 1 FROM publication
      WHERE status='conflict' OR (status='pending' AND last_error IS NOT NULL) LIMIT 1`).toArray().length) {
      throw new Error('Replacement reveal publication is unhealthy.');
    }
    if (hasEnrichment && this.ctx.storage.sql.exec(`SELECT 1 FROM reveal_enrichment WHERE version=?
        AND (status='conflict' OR last_error='conflict-recheck') LIMIT 1`,
      REVEAL_ENRICHMENT_VERSION).toArray().length) {
      throw new Error('Replacement attribute publication has a metadata conflict.');
    }
  }

  async inspectRetired(value: unknown): Promise<EthereumRevealInspection> {
    const deployment = await requireRetiredRevealDeployment(this.env, value);
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL, deployment);
    const tables = this.ctx.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE substr(name,1,7) <> 'sqlite_' AND substr(name,1,5) <> '__cf_' AND name <> '__miniflare_do_name'`).toArray()[0].count;
    const keys = await this.ctx.storage.list({ limit: 1 });
    const alarm = await this.ctx.storage.getAlarm();
    return { ...revealMaintenanceIdentity(deployment), storageEmpty: tables === 0 && keys.size === 0, alarmCleared: alarm === null };
  }

  async quiesceRetired(value: unknown): Promise<{ quiesced: true }> {
    const request = parseRevealMaintenanceRequest(value);
    const deployment = await requireRetiredRevealDeployment(this.env, request);
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL, deployment);
    if (this.quiesceRun) return this.quiesceRun;
    this.retiring = true;
    this.enrichmentStop.abort();
    const operation = async (): Promise<{ quiesced: true }> => {
      const timeout = createTimedAbortScope(undefined, { timeoutMs: 50_000, timeoutMessage: 'Retired reveal drain timed out.' });
      try {
        const writers = [`${deployment.chainId}:${deployment.contractAddress}`, attributePublisherName(deployment)];
        await raceWithSignal(Promise.all(writers.map(name => this.env.ETHEREUM_REVEAL_PUBLISHER
          .getByName(name).drainRetired(request))), timeout.signal);
        const tasks: Promise<unknown>[] = [...this.receipts.values(), ...this.scans.values()].map(entry => entry.promise);
        tasks.push(...this.overflow.values());
        if (this.alarmUpdate) tasks.push(this.alarmUpdate);
        if (this.migrationRun) tasks.push(this.migrationRun);
        if (this.publicationRun) tasks.push(this.publicationRun);
        tasks.push(...this.enrichmentLanes);
        await raceWithSignal(Promise.allSettled(tasks), timeout.signal);
        await raceWithSignal(requireRetiredRevealDeployment(this.env, request), timeout.signal);
        await this.ctx.storage.deleteAlarm();
        return { quiesced: true };
      } finally { timeout.dispose(); }
    };
    this.quiesceRun = operation().finally(() => { this.quiesceRun = null; });
    this.ctx.waitUntil(this.quiesceRun.then(() => undefined, () => undefined));
    return this.quiesceRun;
  }

  async purgeRetired(value: unknown): Promise<EthereumRevealPurgeResult> {
    const request = parseRevealMaintenanceRequest(value);
    const deployment = await requireRetiredRevealDeployment(this.env, request, { requireDrain: true });
    requireRevealObjectIdentity(this.ctx.id, this.env.ETHEREUM_REVEAL, deployment);
    if (this.purgeRun) return this.purgeRun;
    this.retiring = true;
    const operation = async (): Promise<EthereumRevealPurgeResult> => {
      const timeout = createTimedAbortScope(undefined, { timeoutMs: 50_000, timeoutMessage: 'Retired reveal drain timed out.' });
      try {
        await raceWithSignal(this.quiesceRetired(request), timeout.signal);
        await raceWithSignal(requireRetiredRevealDeployment(this.env, request, { requireDrain: true }), timeout.signal);
        timeout.signal.throwIfAborted();
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.deleteAll();
          this.configuredStore = null;
        });
        const inspection = await this.inspectRetired(request);
        if (!inspection.storageEmpty || !inspection.alarmCleared) throw new Error('Retired reveal purge could not be verified.');
        return { ...inspection, purged: true, storageEmpty: true, alarmCleared: true };
      } finally { timeout.dispose(); }
    };
    this.purgeRun = operation().finally(() => { this.purgeRun = null; });
    this.ctx.waitUntil(this.purgeRun.then(() => undefined, () => undefined));
    return this.purgeRun;
  }
}
