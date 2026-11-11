import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { readEthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { EthereumRevealEmptyPoolRequest, EthereumRevealEmptyPoolResult } from '../../../../shared/ethereum/revealMaintenance.js';
import { validateRevealCatalogUpdateBatch } from '../../../../shared/ethereum/revealCatalogUpdate.js';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.js';
import type { RevealAssetCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.js';
import type { EthereumRevealCatalogUpdateStore, RevealCatalogUpdateStatus } from './ethereumRevealCatalogUpdateStore.js';
import { EthereumRevealEmptyPoolFence, type EthereumRevealEmptyPoolFenceScope } from './ethereumRevealEmptyPoolFence.js';
import { verifyEmptyRevealChain } from './ethereumRevealChain.js';

const OBSERVATION_MS = 300_000;
type Phase = EthereumRevealEmptyPoolResult['phase'];
type RecordState = EthereumRevealEmptyPoolFenceScope & {
  batchId: string; phase: Phase; sourceRevision: number; predecessor: RevealAssetCatalogDescriptor;
  target: RevealAssetCatalogDescriptor; observationUntilMs: number; observedVerified?: boolean; emptyCounts?: Record<string, number>;
  identity: Pick<EthereumRevealDeployment, 'chainId' | 'contractAddress' | 'metadataBaseUri' | 'deploymentBlock' | 'catalogVersion' | 'templateSha256'>;
};
type Host = {
  env: Env; storage: DurableObjectStorage; fence: EthereumRevealEmptyPoolFence;
  initializeStore(): EthereumRevealCatalogUpdateStore;
  readStore(): EthereumRevealCatalogUpdateStore;
  quiescent(): boolean;
  wake(deployment: EthereumRevealDeployment): Promise<void>;
};

export function parseEmptyPoolRequest(value: unknown): EthereumRevealEmptyPoolRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid empty-pool request.');
  const request = value as EthereumRevealEmptyPoolRequest;
  if (Object.keys(request).some(key => !['deploymentId', 'expectedRevision', 'operationId', 'action', 'batch'].includes(key)) ||
    typeof request.deploymentId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.deploymentId) ||
    typeof request.operationId !== 'string' || !/^empty-[a-f0-9]{32}$/.test(request.operationId) ||
    !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 ||
    !['inspect', 'begin', 'advance', 'verify', 'cancel'].includes(request.action) ||
    (request.action === 'begin') !== (request.batch !== undefined)) throw new Error('Invalid empty-pool request.');
  if (request.batch) validateRevealCatalogUpdateBatch(request.batch);
  return request;
}

export class EthereumRevealEmptyPool {
  private running = false;
  constructor(private readonly host: Host,
    private readonly verifyChain: typeof verifyEmptyRevealChain = verifyEmptyRevealChain) {}

  private key(id: string): string { return `empty-pool-rebuild:${id}`; }
  private save(record: RecordState): Promise<void> { return this.host.storage.put(this.key(record.operationId), record); }
  private async load(request: EthereumRevealEmptyPoolRequest): Promise<RecordState | undefined> {
    const record = await this.host.storage.get<RecordState>(this.key(request.operationId));
    if (record && (record.deploymentId !== request.deploymentId || record.expectedRevision !== request.expectedRevision)) {
      throw new Error('Empty-pool operation identity or original revision changed.');
    }
    return record;
  }
  private store(_record?: RecordState): EthereumRevealCatalogUpdateStore {
    return this.host.readStore();
  }
  private mutate<T>(record: RecordState, action: (store: EthereumRevealCatalogUpdateStore) => T): T {
    return this.host.fence.withRebuild(record, () => action(this.host.initializeStore()));
  }
  private async current(scope: EthereumRevealDeployment, record?: RecordState): Promise<EthereumRevealDeployment> {
    const current = await readEthereumRevealDeployment(this.host.env.OPS_DB, scope);
    if (!current || current.deploymentId !== scope.deploymentId || current.chainId !== 1 || current.retiredAtMs != null ||
      current.contractAddress !== scope.contractAddress || current.metadataBaseUri !== scope.metadataBaseUri ||
      record && Object.entries(record.identity).some(([key, value]) => current[key as keyof EthereumRevealDeployment] !== value)) {
      throw new Error('Empty-pool deployment identity is unavailable.');
    }
    return current;
  }
  private async owned(scope: EthereumRevealDeployment, record: RecordState): Promise<EthereumRevealDeployment> {
    const current = await this.current(scope, record);
    if (current.catalogUpdateId !== record.operationId || ![record.expectedRevision + 1, record.expectedRevision + 2].includes(current.revision)) {
      throw new Error('Empty-pool operation ownership changed.');
    }
    return current;
  }
  private result(request: EthereumRevealEmptyPoolRequest, deployment: EthereumRevealDeployment, record?: RecordState,
    status?: RevealCatalogUpdateStatus): EthereumRevealEmptyPoolResult {
    const phase = record?.phase ?? 'unstarted';
    const fence = this.host.fence.status();
    const waitUntil = phase === 'fencing' ? fence?.drainUntilMs ?? 0 : phase === 'observing' ? record?.observationUntilMs ?? 0 : 0;
    return { deploymentId: request.deploymentId, operationId: request.operationId, phase, complete: phase === 'complete',
      catalogRevision: status?.activatedAtMs != null ? status.targetRevision : deployment.catalogRevision ?? 0,
      seeded: status?.generationSeeded ?? 0, total: 111111, fenceActive: fence !== null,
      retryAfterMs: Math.max(0, Math.min(5000, waitUntil - Date.now())),
      ...(record?.observationUntilMs ? { observationUntilMs: record.observationUntilMs } : {}),
      ...(record?.emptyCounts ? { emptyCounts: record.emptyCounts } : {}) };
  }

  async run(request: EthereumRevealEmptyPoolRequest, deployment: EthereumRevealDeployment): Promise<EthereumRevealEmptyPoolResult> {
    if (request.action === 'inspect' || request.action === 'verify') {
      const record = await this.load(request);
      const current = await this.current(deployment, record);
      const status = record ? this.store(record).status(record.operationId) ?? undefined : undefined;
      if (request.action === 'verify') {
        if (!record || !['observing', 'complete'].includes(record.phase) || this.host.fence.status()) throw new Error('Empty-pool activation is incomplete.');
        this.store(record).verifyEmptyRebuild(record.operationId);
        await this.verifyChain(this.host.env, current, AbortSignal.timeout(15000));
      }
      return this.result(request, current, record, status);
    }
    if (this.running) throw new Error('Empty-pool work is already running. Retry the same operation.');
    this.running = true;
    try {
      let record = await this.load(request);
      let current = await this.current(deployment, record);
      if (request.action === 'begin') {
        const batch = request.batch!;
        if (!getRevealCatalog(batch.predecessor.descriptor.catalogVersion, batch.predecessor.descriptor.manifestSha256) ||
          !getRevealCatalog(batch.target.descriptor.catalogVersion, batch.target.descriptor.manifestSha256)) throw new Error('Deploy both catalogs before rebuilding.');
        if (record && record.batchSha256 !== batch.batchSha256) throw new Error('Empty-pool frozen batch changed.');
        if (record?.phase === 'cancelled') throw new Error('This empty-pool operation was cancelled.');
        if (!record) {
          const previous = current.effectiveCatalogVersion && current.effectiveCatalogSha256
            ? { catalogVersion: current.effectiveCatalogVersion, manifestSha256: current.effectiveCatalogSha256 }
            : getRevealCatalogDescriptor(current.catalogVersion);
          if (current.state !== 'paused' || current.revision !== request.expectedRevision || current.catalogUpdateId != null ||
            current.provisionedAtMs == null || JSON.stringify(previous) !== JSON.stringify(batch.predecessor.descriptor)) {
            throw new Error('Pause the initialized empty deployment at the expected predecessor revision.');
          }
          this.host.initializeStore();
          const { chainId, contractAddress, metadataBaseUri, deploymentBlock, catalogVersion, templateSha256 } = current;
          record = { operationId: request.operationId, deploymentId: request.deploymentId, expectedRevision: request.expectedRevision,
            batchSha256: batch.batchSha256, batchId: batch.batchId, phase: 'fencing', sourceRevision: current.catalogRevision ?? 0,
            predecessor: batch.predecessor.descriptor, target: batch.target.descriptor, observationUntilMs: 0,
            identity: { chainId, contractAddress, metadataBaseUri, deploymentBlock, catalogVersion, templateSha256 } };
          await this.save(record);
        }
        const status = this.store(record).status(record.operationId);
        if (status?.activatedAtMs != null || record.phase !== 'fencing') return await this.advance(request, current, record);
        this.host.fence.acquire(record, Date.now());
        this.mutate(record, store => store.beginEmptyRebuild({ operationId: record!.operationId, batch }));
        await this.host.storage.deleteAlarm();
        if (current.catalogUpdateId == null) {
          const row = await this.host.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET catalog_update_id=?,
            catalog_update_started_at_ms=?,revision=revision+1,updated_at_ms=? WHERE deployment_id=? AND revision=?
            AND state='paused' AND catalog_update_id IS NULL AND retired_at_ms IS NULL RETURNING deployment_id`)
            .bind(record.operationId, Date.now(), Date.now(), record.deploymentId, record.expectedRevision).first();
          if (!row) throw new Error('Empty-pool registry claim changed; inspect before retrying.');
        }
        current = await this.owned(current, record);
        return this.result(request, current, record, this.store(record).status(record.operationId) ?? undefined);
      }
      if (!record) throw new Error('Begin the empty-pool operation with its frozen batch.');
      if (request.action === 'cancel') return await this.cancel(request, current, record);
      return await this.advance(request, current, record);
    } finally { this.running = false; }
  }

  private async mirror(current: EthereumRevealDeployment, record: RecordState): Promise<EthereumRevealDeployment> {
    current = await this.owned(current, record);
    if (current.effectiveCatalogVersion === record.target.catalogVersion && current.effectiveCatalogSha256 === record.target.manifestSha256 &&
      current.catalogRevision === record.sourceRevision + 1 && current.state === 'active') return current;
    const row = await this.host.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET effective_catalog_version=?,
      effective_catalog_sha256=?,catalog_revision=?,state='active',revision=revision+1,updated_at_ms=?,last_error=NULL
      WHERE deployment_id=? AND revision=? AND state='paused' AND catalog_update_id=? AND retired_at_ms IS NULL RETURNING deployment_id`)
      .bind(record.target.catalogVersion, record.target.manifestSha256, record.sourceRevision + 1, Date.now(), record.deploymentId,
        record.expectedRevision + 1, record.operationId).first();
    if (!row) throw new Error('Empty-pool activation mirror needs retry.');
    return this.owned(current, record);
  }

  private async advance(request: EthereumRevealEmptyPoolRequest, current: EthereumRevealDeployment,
    record: RecordState): Promise<EthereumRevealEmptyPoolResult> {
    const status = this.store(record).status(record.operationId);
    if (record.phase === 'complete' || record.phase === 'cancelled') return this.result(request, current, record, status ?? undefined);
    if (!status) throw new Error('Retry begin with the frozen empty-pool batch.');
    if (status.activatedAtMs != null) {
      if (current.catalogUpdateId == null && current.revision >= record.expectedRevision + 3 && status.phase === 'complete') {
        if (current.state !== 'active' || current.effectiveCatalogVersion !== record.target.catalogVersion ||
          current.effectiveCatalogSha256 !== record.target.manifestSha256 || current.catalogRevision !== record.sourceRevision + 1) {
          throw new Error('Empty-pool completion identity changed.');
        }
        record.phase = 'complete';
        await this.save(record);
        return this.result(request, current, record, status);
      }
      current = await this.mirror(current, record);
      if (record.phase !== 'observing') {
        record.phase = 'observing';
        record.observationUntilMs = Date.now() + OBSERVATION_MS;
        await this.save(record);
        await this.host.wake(current);
      }
      if (Date.now() < record.observationUntilMs) return this.result(request, current, record, status);
      if (!record.observedVerified) {
        this.store(record).verifyEmptyRebuild(record.operationId);
        await this.verifyChain(this.host.env, current, AbortSignal.timeout(15000));
        this.store(record).finalize(record.operationId);
        record.observedVerified = true;
        await this.save(record);
      }
      const cleanup = this.store(record).pruneEmptyRebuild(record.operationId, 4096);
      if (cleanup.remaining > 0) return this.result(request, current, record, this.store(record).status(record.operationId) ?? undefined);
      const row = await this.host.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET catalog_update_id=NULL,
        catalog_update_started_at_ms=NULL,revision=revision+1,updated_at_ms=? WHERE deployment_id=? AND revision=?
        AND catalog_update_id=? AND retired_at_ms IS NULL RETURNING deployment_id`)
        .bind(Date.now(), record.deploymentId, record.expectedRevision + 2, record.operationId).first();
      if (!row) throw new Error('Empty-pool completion needs retry.');
      record.phase = 'complete';
      await this.save(record);
      return this.result(request, await this.current(current, record), record, this.store(record).status(record.operationId) ?? undefined);
    }
    current = await this.owned(current, record);
    if (current.state !== 'paused') throw new Error('Empty-pool writes require paused reveals.');
    if (record.phase === 'fencing') {
      if (Date.now() < this.host.fence.inspect(record)!.drainUntilMs) return this.result(request, current, record, status);
      if (!this.host.quiescent()) throw new Error('Reveal writers have not drained.');
      const proof = this.host.fence.assertEmpty(record, Date.now());
      await this.verifyChain(this.host.env, current, AbortSignal.timeout(15000));
      await this.owned(current, record);
      record.emptyCounts = proof.counts;
      record.phase = 'staging';
    } else if (record.phase === 'staging') {
      this.host.fence.assertEmpty(record, Date.now());
      const next = this.mutate(record, store => store.stageEmptyRebuild(record.operationId, 4096));
      if (next.generationSeeded === 111111) {
        this.mutate(record, store => store.sealEmptyRebuild(record.operationId));
        record.phase = 'activating';
      }
    } else if (record.phase === 'activating') {
      if (!this.host.quiescent()) throw new Error('Reveal writers have not drained.');
      this.host.fence.assertEmpty(record, Date.now());
      await this.verifyChain(this.host.env, current, AbortSignal.timeout(15000));
      await this.owned(current, record);
      this.mutate(record, store => {
        store.activateEmptyRebuild(record.operationId);
        this.host.fence.release(record, Date.now());
      });
      current = await this.mirror(current, record);
      record.phase = 'observing';
      record.observationUntilMs = Date.now() + OBSERVATION_MS;
      await this.save(record);
      await this.host.wake(current);
    }
    await this.save(record);
    return this.result(request, current, record, this.store(record).status(record.operationId) ?? undefined);
  }

  private async cancel(request: EthereumRevealEmptyPoolRequest, current: EthereumRevealDeployment,
    record: RecordState): Promise<EthereumRevealEmptyPoolResult> {
    const status = this.store(record).status(record.operationId);
    if (status?.activatedAtMs != null) throw new Error('An activated empty-pool rebuild must finish forward.');
    if (record.phase === 'cancelled') return this.result(request, current, record, status ?? undefined);
    if (!this.host.quiescent()) throw new Error('Reveal writers have not drained.');
    current = await this.current(current, record);
    if (current.catalogUpdateId !== null && current.catalogUpdateId !== record.operationId) throw new Error('Another operation owns the deployment.');
    if (current.catalogUpdateId === record.operationId &&
      (current.revision !== record.expectedRevision + 1 || current.state !== 'paused')) throw new Error('Empty-pool cancellation ownership changed.');
    if (this.host.fence.status()) {
      this.mutate(record, store => { if (status) store.cancel(record.operationId); });
      this.host.fence.abort(record, Date.now());
    } else if (status && (this.host.fence.inspect(record)?.releasedAtMs == null || status.phase !== 'cancelled')) {
      throw new Error('Empty-pool cancellation lost its writer fence.');
    }
    if (current.catalogUpdateId === record.operationId) {
      const row = await this.host.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET catalog_update_id=NULL,
        catalog_update_started_at_ms=NULL,revision=revision+1,updated_at_ms=? WHERE deployment_id=? AND revision=?
        AND state='paused' AND catalog_update_id=? AND retired_at_ms IS NULL RETURNING deployment_id`)
        .bind(Date.now(), record.deploymentId, record.expectedRevision + 1, record.operationId).first();
      if (!row) throw new Error('Empty-pool cancellation mirror needs retry.');
    }
    record.phase = 'cancelled';
    await this.save(record);
    current = await this.current(current, record);
    await this.host.wake(current);
    return this.result(request, current, record, this.store(record).status(record.operationId) ?? undefined);
  }
}
