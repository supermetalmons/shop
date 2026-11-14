import { createHash } from 'node:crypto';
import { encodeCall } from '../../../../shared/ethereum/abi.js';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.js';
import { getRevealCatalog, getRevealCatalogDescriptor } from '../../../../shared/ethereum/revealCatalogRegistry.js';
import { validateRevealCatalogUpdateBatch, type RevealCatalogUpdateMapping } from '../../../../shared/ethereum/revealCatalogUpdate.js';
import { readEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { EthereumRevealCatalogUpdateRequest, EthereumRevealCatalogUpdateResult } from '../../../../shared/ethereum/revealMaintenance.js';
import type { RevealAssetCatalogDescriptor } from '../../../../shared/ethereum/revealAssetCatalog.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import { cancelResponseBody, readBoundedResponseBytes } from './boundedResponse.js';
import { fetchRevealAttributePayload, MAX_REVEAL_METADATA_BYTES } from './ethereumRevealAttributes.js';
import { EthereumRevealCatalogUpdateStore } from './ethereumRevealCatalogUpdateStore.js';
import type { EthereumRevealStore } from './ethereumRevealStore.js';

const OBSERVATION_MS = 300_000;
const PAGE_SIZE = 8;
type Phase = EthereumRevealCatalogUpdateResult['phase'];
type UpdateRecord = {
  batchId: string; batchSha256: string; deploymentId: string; expectedRevision: number;
  predecessor: RevealAssetCatalogDescriptor; target: RevealAssetCatalogDescriptor;
  sourceRevision: number; startedAtMs: number; phase: Phase; mappingCount: number;
  verificationAfterEggId: number; observationUntilMs: number; verifiedAfterObservation?: boolean;
};
type CatalogUpdateHost = {
  env: Env; storage: DurableObjectStorage; initializeStore(): EthereumRevealStore;
  wake(deployment: EthereumRevealDeployment): Promise<void>;
};

export function parseCatalogUpdateRequest(value: unknown): EthereumRevealCatalogUpdateRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid catalog update request.');
  const request = value as EthereumRevealCatalogUpdateRequest;
  if (Object.keys(request).some(key => !['deploymentId', 'expectedRevision', 'batchId', 'action', 'batch', 'verificationAfterEggId', 'eggCutoff', 'afterEggId'].includes(key)) ||
    typeof request.deploymentId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.deploymentId) ||
    !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 ||
    typeof request.batchId !== 'string' || !/^catalog-[a-f0-9]{32}$/.test(request.batchId) ||
    !['inspect', 'begin', 'advance', 'verify', 'cancel'].includes(request.action) ||
    request.verificationAfterEggId !== undefined && (request.action !== 'verify' || !Number.isSafeInteger(request.verificationAfterEggId) || request.verificationAfterEggId < 0) ||
    request.eggCutoff !== undefined && (request.action !== 'inspect' || !Number.isSafeInteger(request.eggCutoff) || request.eggCutoff < 0 || request.eggCutoff >= 111_111) ||
    request.afterEggId !== undefined && (request.eggCutoff === undefined || !Number.isSafeInteger(request.afterEggId) || request.afterEggId < request.eggCutoff) ||
    request.action === 'begin' && request.batch === undefined || request.action !== 'begin' && request.batch !== undefined) {
    throw new Error('Invalid catalog update request.');
  }
  if (request.batch) {
    validateRevealCatalogUpdateBatch(request.batch);
    if (request.batch.batchId !== request.batchId) throw new Error('Catalog batch identity does not match.');
  }
  return request;
}

export class EthereumRevealCatalogUpdate {
  private readonly updates: EthereumRevealCatalogUpdateStore;
  private running: Promise<EthereumRevealCatalogUpdateResult> | null = null;

  constructor(private readonly host: CatalogUpdateHost, private readonly registry = { getCatalog: getRevealCatalog, getDescriptor: getRevealCatalogDescriptor }) {
    this.updates = new EthereumRevealCatalogUpdateStore(host.storage.sql, action => host.storage.transactionSync(action));
  }

  async run(request: EthereumRevealCatalogUpdateRequest, deployment: EthereumRevealDeployment): Promise<EthereumRevealCatalogUpdateResult> {
    if (request.action === 'inspect' || request.action === 'verify') return this.read(request, deployment);
    if (this.running) throw new Error('Catalog update work is already running. Retry the same operation.');
    const operation = this.write(request, deployment).finally(() => { this.running = null; });
    this.running = operation;
    return operation;
  }

  private key(batchId: string): string { return `catalog-update:${batchId}`; }
  private save(record: UpdateRecord): Promise<void> { return this.host.storage.put(this.key(record.batchId), record); }

  private async current(scope: EthereumRevealDeployment): Promise<EthereumRevealDeployment> {
    const current = await readEthereumRevealDeployment(this.host.env.OPS_DB, scope);
    if (!current || current.deploymentId !== scope.deploymentId || current.retiredAtMs != null || current.metadataBaseUri !== scope.metadataBaseUri ||
      current.templateSha256 !== scope.templateSha256 || ![1, 11155111, 31337].includes(current.chainId)) {
      throw new Error('Catalog deployment identity is unavailable.');
    }
    return current;
  }

  private async record(request: EthereumRevealCatalogUpdateRequest): Promise<UpdateRecord | undefined> {
    const record = await this.host.storage.get<UpdateRecord>(this.key(request.batchId));
    if (record && (record.deploymentId !== request.deploymentId || record.expectedRevision !== request.expectedRevision)) {
      throw new Error('Catalog update scope or original revision does not match.');
    }
    return record;
  }

  private result(request: EthereumRevealCatalogUpdateRequest, deployment: EthereumRevealDeployment,
    record?: UpdateRecord, status = this.updates.status(request.batchId)): EthereumRevealCatalogUpdateResult {
    const phase = record?.phase ?? 'unstarted';
    return { deploymentId: deployment.deploymentId, batchId: request.batchId, phase, complete: phase === 'complete',
      catalogRevision: this.updates.effectiveCatalog()?.catalogRevision ?? deployment.catalogRevision ?? 0,
      total: status?.total ?? record?.mappingCount ?? 0, staged: status?.metadataStaged ?? 0,
      applied: status?.activatedAtMs ? status.total : 0, published: status?.published ?? 0, frozen: status?.frozen ?? 0,
      conflicts: status?.conflicts ?? 0, retrying: status?.retrying ?? 0,
      retryAfterMs: phase === 'observing' ? Math.max(0, Math.min(5_000, (record?.observationUntilMs ?? 0) - Date.now()))
        : phase === 'publishing' && status && status.published < status.frozen ? 1_000 : 0,
      ...(phase === 'complete' ? { refreshTransaction: { chainId: deployment.chainId, to: deployment.contractAddress,
        data: encodeCall('setBaseURI(string)', ['string'], [deployment.metadataBaseUri]), value: '0x0' as const } } : {}) };
  }

  private async read(request: EthereumRevealCatalogUpdateRequest, deployment: EthereumRevealDeployment): Promise<EthereumRevealCatalogUpdateResult> {
    const record = await this.record(request);
    deployment = await this.current(deployment);
    if (request.eggCutoff !== undefined) {
      if (deployment.revision !== request.expectedRevision) throw new Error('Catalog deployment revision changed.');
      const eligibleEggIds = this.updates.eligibleCutoffEggs(request.eggCutoff, request.afterEggId ?? request.eggCutoff);
      return { ...this.result(request, deployment, record), eligibleEggIds,
        nextEligibleEggId: eligibleEggIds.length === 256 ? eligibleEggIds.at(-1)! : null };
    }
    if (request.action !== 'verify') return this.result(request, deployment, record);
    const status = this.updates.verify(request.batchId);
    if (!status.activatedAtMs || status.published !== status.frozen) throw new Error('Catalog replacement publication is incomplete.');
    const next = await this.verifyPublicationPage(deployment, request.batchId, request.verificationAfterEggId ?? 0);
    await this.current(deployment);
    return { ...this.result(request, deployment, record), nextVerificationEggId: next };
  }

  private async write(request: EthereumRevealCatalogUpdateRequest, deployment: EthereumRevealDeployment): Promise<EthereumRevealCatalogUpdateResult> {
    let record = await this.record(request);
    deployment = await this.current(deployment);
    if (request.action === 'begin') {
      const batch = request.batch!;
      if (!this.registry.getCatalog(batch.predecessor.descriptor.catalogVersion, batch.predecessor.descriptor.manifestSha256) ||
        !this.registry.getCatalog(batch.target.descriptor.catalogVersion, batch.target.descriptor.manifestSha256)) {
        throw new Error('Deploy support for both catalog revisions before beginning the update.');
      }
      if (record && record.batchSha256 !== batch.batchSha256) throw new Error('Frozen catalog batch changed.');
      if (record?.phase === 'cancelled') throw new Error('This operation was cancelled. Prepare a new attempt with the same mapping.');
      if (record && this.updates.status(record.batchId)) return this.advance(request, deployment, record);
      this.host.initializeStore();
      if (!record) {
        const activeId = await this.host.storage.get<string>('catalog-update-active');
        const active = activeId && await this.host.storage.get<UpdateRecord>(this.key(activeId));
        if (active && !['complete', 'cancelled'].includes(active.phase)) throw new Error('Finish the previous catalog operation first.');
        const predecessor = this.updates.effectiveCatalog();
        if (deployment.revision !== request.expectedRevision || deployment.catalogUpdateId != null ||
          !['active', 'paused'].includes(deployment.state) || deployment.provisionedAtMs === null ||
          predecessor?.catalogVersion !== batch.predecessor.descriptor.catalogVersion || predecessor.manifestSha256 !== batch.predecessor.descriptor.manifestSha256) {
          throw new Error('Catalog update predecessor, deployment state or revision changed.');
        }
        const saved = this.host.storage.sql.exec<{ ready: number }>('SELECT ready FROM settings WHERE id=1').toArray()[0];
        if (!saved?.ready) throw new Error('Catalog inventory is not initialized.');
        record = { batchId: batch.batchId, batchSha256: batch.batchSha256, deploymentId: deployment.deploymentId,
          expectedRevision: request.expectedRevision, predecessor: batch.predecessor.descriptor, target: batch.target.descriptor,
          sourceRevision: predecessor.catalogRevision, startedAtMs: Date.now(), phase: 'staging', mappingCount: batch.mappings.length,
          verificationAfterEggId: 0, observationUntilMs: 0 };
        await this.save(record);
        await this.host.storage.put('catalog-update-active', record.batchId);
      }
      for (let offset = 0; offset < batch.mappings.length; offset += 256) {
        await this.host.storage.put(`catalog-update-mappings:${record.batchId}:${offset}`, batch.mappings.slice(offset, offset + 256));
      }
      if (deployment.catalogUpdateId == null) {
        const row = await this.host.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET catalog_update_id=?,
          catalog_update_started_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER),revision=revision+1,updated_at_ms=?
          WHERE deployment_id=? AND revision=? AND catalog_update_id IS NULL AND retired_at_ms IS NULL RETURNING deployment_id`)
          .bind(record.batchId, Date.now(), record.deploymentId, record.expectedRevision).first();
        if (!row) throw new Error('Catalog deployment changed before the operation was acquired.');
      }
      deployment = await this.requireOperation(deployment, record);
      this.updates.begin(batch, record.startedAtMs);
      return this.result(request, deployment, record);
    }
    if (!record) throw new Error('Begin this catalog operation using its frozen batch first.');
    if (request.action === 'cancel') return this.cancel(request, deployment, record);
    return this.advance(request, deployment, record);
  }

  private async requireOperation(deployment: EthereumRevealDeployment, record: UpdateRecord): Promise<EthereumRevealDeployment> {
    const current = await this.current(deployment);
    if (current.catalogUpdateId !== record.batchId || ![record.expectedRevision + 1, record.expectedRevision + 2].includes(current.revision)) {
      throw new Error('Catalog operation ownership changed.');
    }
    return current;
  }

  private async advance(request: EthereumRevealCatalogUpdateRequest, deployment: EthereumRevealDeployment, record: UpdateRecord): Promise<EthereumRevealCatalogUpdateResult> {
    if (record.phase === 'complete' || record.phase === 'cancelled') return this.result(request, deployment, record);
    this.host.initializeStore();
    const status = this.updates.status(record.batchId);
    if (!status) throw new Error('Retry begin with the frozen batch to resume preparation.');
    if (status.activatedAtMs !== null) {
      if (!['publishing', 'verifying', 'observing'].includes(record.phase)) {
        record.phase = 'publishing';
        await this.save(record);
      }
      if (record.phase === 'observing' && deployment.catalogUpdateId == null) return this.observe(request, deployment, record);
      deployment = await this.requireOperation(deployment, record);
      await this.mirror(deployment, record);
    } else {
      deployment = await this.requireOperation(deployment, record);
      if (status.phase === 'mapping') {
        const offset = status.mapped;
        if (offset === record.mappingCount) {
          this.updates.sealMappings(record.batchId);
          return this.result(request, deployment, record);
        }
        const mappings = await this.host.storage.get<RevealCatalogUpdateMapping[]>(`catalog-update-mappings:${record.batchId}:${offset}`);
        if (!mappings || mappings.length !== Math.min(256, record.mappingCount - offset)) throw new Error('Retry begin with the frozen batch to restore mapping ingestion.');
        this.updates.stageMappings(record.batchId, mappings);
        if (offset + mappings.length === record.mappingCount) this.updates.sealMappings(record.batchId);
        return this.result(request, deployment, record);
      }
      if (status.metadataStaged < status.total) {
        const catalog = this.registry.getCatalog(record.target.catalogVersion, record.target.manifestSha256)!;
        const rows = this.updates.metadataPreparationPage(record.batchId, PAGE_SIZE);
        const payloads = await Promise.all(rows.map(async row => {
          if ('attributesJson' in row) return row;
          const timeout = createTimedAbortScope(undefined, { timeoutMs: 25_000, timeoutMessage: 'Artwork trait staging timed out.' });
          try {
            const attributesJson = await fetchRevealAttributePayload(row.category, row.assetId, timeout.signal, fetch, catalog);
            return { ...row, attributesJson, sha256: createHash('sha256').update(attributesJson).digest('hex') };
          } finally { timeout.dispose(); }
        }));
        await this.requireOperation(deployment, record);
        this.updates.metadataStage(record.batchId, payloads);
        return this.result(request, deployment, record);
      }
      if (status.generationSeeded < 111_111) {
        this.updates.generationStage(record.batchId, 256);
        return this.result(request, deployment, record);
      }
      if (record.phase === 'staging') {
        this.updates.seal(record.batchId);
        record.phase = 'activating';
        await this.save(record);
        return this.result(request, deployment, record);
      }
      this.updates.activate(record.batchId);
      record.phase = 'publishing';
      await this.save(record);
      await this.host.wake(this.updates.effectiveDeployment(deployment));
      await this.mirror(deployment, record);
      return this.result(request, deployment, record);
    }
    if (record.phase === 'publishing') {
      const jobs = this.updates.pendingPublications(record.batchId, 2, Date.now());
      const scope = { deploymentId: deployment.deploymentId, chainId: deployment.chainId,
        contractAddress: deployment.contractAddress, metadataBaseUri: deployment.metadataBaseUri };
      const results = await this.host.env.ETHEREUM_REVEAL_PUBLISHER.getByName(`${deployment.chainId}:${deployment.contractAddress}`)
        .publishBatch(scope, jobs.map(job => ({ token_id: job.tokenId, metadata_json: job.metadataJson, placeholder_json: job.expectedJsons[0] ?? '',
          metadata_revision: job.metadataRevision, expected_jsons_json: JSON.stringify(job.expectedJsons), allow_missing: job.allowMissing,
          migration: true, attempts: 0 })), Date.now() + 25_000);
      await this.requireOperation(deployment, record);
      for (const result of results) {
        const job = jobs.find(value => value.tokenId === result.tokenId);
        if (!job) throw new Error('Unexpected catalog publication result.');
        if (result.status === 'published') this.updates.acknowledgePublication(record.batchId, job.tokenId, job.metadataRevision, job.targetSha256);
        else this.updates.failPublication(record.batchId, job.tokenId, job.metadataRevision, result.status === 'conflict' ? 'conflict' : 'retry', Date.now());
      }
      const progress = this.updates.status(record.batchId)!;
      if (progress.published === progress.frozen) record.phase = 'verifying';
    } else if (record.phase === 'verifying') {
      this.updates.verify(record.batchId);
      const next = await this.verifyPublicationPage(deployment, record.batchId, record.verificationAfterEggId);
      record.verificationAfterEggId = next ?? 0;
      if (next === null) {
        record.phase = 'observing';
        record.observationUntilMs = Date.now() + OBSERVATION_MS;
      }
    } else if (record.phase === 'observing') return this.observe(request, deployment, record);
    await this.save(record);
    return this.result(request, await this.current(deployment), record);
  }

  private async mirror(deployment: EthereumRevealDeployment, record: UpdateRecord): Promise<void> {
    const current = await this.requireOperation(deployment, record);
    if (current.effectiveCatalogVersion === record.target.catalogVersion && current.effectiveCatalogSha256 === record.target.manifestSha256 &&
      current.catalogRevision === record.sourceRevision + 1) return;
    const row = await this.host.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET effective_catalog_version=?,effective_catalog_sha256=?,
      catalog_revision=?,revision=revision+1,updated_at_ms=? WHERE deployment_id=? AND revision=? AND catalog_update_id=?
      AND catalog_revision=? AND retired_at_ms IS NULL RETURNING deployment_id`)
      .bind(record.target.catalogVersion, record.target.manifestSha256, record.sourceRevision + 1, Date.now(), record.deploymentId,
        record.expectedRevision + 1, record.batchId, record.sourceRevision).first();
    if (!row) throw new Error('Catalog registry mirror needs retry; the active allocator remains online.');
  }

  private async observe(request: EthereumRevealCatalogUpdateRequest, deployment: EthereumRevealDeployment, record: UpdateRecord): Promise<EthereumRevealCatalogUpdateResult> {
    if (Date.now() < record.observationUntilMs) return this.result(request, deployment, record);
    if (!record.verifiedAfterObservation) {
      this.updates.verify(record.batchId);
      const next = await this.verifyPublicationPage(deployment, record.batchId, record.verificationAfterEggId);
      record.verificationAfterEggId = next ?? 0;
      record.verifiedAfterObservation = next === null;
      await this.save(record);
    }
    if (record.verifiedAfterObservation) {
      this.updates.finalize(record.batchId);
      if (this.updates.prune(record.batchId, 256).remaining > 0) {
        await this.save(record);
        return this.result(request, await this.current(deployment), record);
      }
      await this.discardMappingPages(record);
      deployment = await this.current(deployment);
      if (deployment.catalogUpdateId != null) {
        await this.mirror(deployment, record);
        const row = await this.host.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET catalog_update_id=NULL,
          catalog_update_started_at_ms=NULL,revision=revision+1,updated_at_ms=? WHERE deployment_id=? AND revision=?
          AND catalog_update_id=? AND retired_at_ms IS NULL RETURNING deployment_id`)
          .bind(Date.now(), record.deploymentId, record.expectedRevision + 2, record.batchId).first();
        if (!row) throw new Error('Catalog operation completion needs retry.');
      } else if (deployment.effectiveCatalogVersion !== record.target.catalogVersion || deployment.effectiveCatalogSha256 !== record.target.manifestSha256 ||
        deployment.catalogRevision !== record.sourceRevision + 1 || deployment.revision < record.expectedRevision + 3) {
        throw new Error('Catalog operation completion identity changed.');
      }
      record.phase = 'complete';
    }
    await this.save(record);
    return this.result(request, await this.current(deployment), record);
  }

  private async discardMappingPages(record: UpdateRecord): Promise<void> {
    const keys = Array.from({ length: Math.ceil(record.mappingCount / 256) }, (_, index) => `catalog-update-mappings:${record.batchId}:${index * 256}`);
    for (let offset = 0; offset < keys.length; offset += 128) await this.host.storage.delete(keys.slice(offset, offset + 128));
  }

  private async verifyPublicationPage(deployment: EthereumRevealDeployment, batchId: string, afterEggId: number): Promise<number | null> {
    const rows = this.updates.publicationPage(batchId, afterEggId, PAGE_SIZE);
    const timeout = createTimedAbortScope(undefined, { timeoutMs: 25_000, timeoutMessage: 'Catalog publication verification timed out.' });
    try {
      await Promise.all(rows.map(async row => {
        const url = ethereumTokenMetadataUri(deployment, row.tokenId);
        const object = await raceWithSignal(this.host.env.ETHEREUM_REVEAL_METADATA.get(new URL(url).pathname.slice(1)), timeout.signal);
        if (!object || object.size > MAX_REVEAL_METADATA_BYTES || object.httpMetadata?.contentType !== 'application/json; charset=utf-8' ||
          object.httpMetadata.cacheControl !== 'no-store' || object.httpMetadata.contentEncoding) throw new Error(`Invalid stored metadata for token ${row.tokenId}.`);
        const bytes = await raceWithSignal(object.arrayBuffer(), timeout.signal);
        if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== row.metadataJson) throw new Error(`Stored metadata differs for token ${row.tokenId}.`);
        const response = await fetch(url, { cache: 'no-store', redirect: 'manual', signal: timeout.signal });
        if (response.status !== 200 || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
          !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '')) {
          await cancelResponseBody(response);
          throw new Error(`Invalid public metadata headers for token ${row.tokenId}.`);
        }
        const publicBytes = await readBoundedResponseBytes(response, { maxBytes: MAX_REVEAL_METADATA_BYTES, signal: timeout.signal,
          createError: () => new Error(`Invalid public metadata for token ${row.tokenId}.`) });
        if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(publicBytes) !== row.metadataJson) throw new Error(`Public metadata differs for token ${row.tokenId}.`);
      }));
    } finally { timeout.dispose(); }
    return rows.length === PAGE_SIZE ? rows[rows.length - 1].eggId : null;
  }

  private async cancel(request: EthereumRevealCatalogUpdateRequest, deployment: EthereumRevealDeployment, record: UpdateRecord): Promise<EthereumRevealCatalogUpdateResult> {
    if (record.phase === 'cancelled') {
      await this.discardMappingPages(record);
      await this.host.wake(deployment);
      return this.result(request, deployment, record);
    }
    const status = this.updates.status(record.batchId);
    if (status?.activatedAtMs != null) throw new Error('An activated catalog update must resume forward.');
    if (deployment.catalogUpdateId != null) {
      await this.requireOperation(deployment, record);
      if (status) this.updates.cancel(record.batchId);
      const row = await this.host.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments SET catalog_update_id=NULL,
        catalog_update_started_at_ms=NULL,revision=revision+1,updated_at_ms=? WHERE deployment_id=? AND revision=?
        AND catalog_update_id=? AND retired_at_ms IS NULL RETURNING deployment_id`)
        .bind(Date.now(), record.deploymentId, record.expectedRevision + 1, record.batchId).first();
      if (!row) throw new Error('Catalog cancellation needs retry.');
    } else if (status && status.phase !== 'cancelled') throw new Error('Catalog cancellation scope changed.');
    await this.discardMappingPages(record);
    record.phase = 'cancelled';
    await this.save(record);
    await this.host.wake(await this.current(deployment));
    return this.result(request, await this.current(deployment), record);
  }
}
