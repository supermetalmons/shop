import type { TwinMetadataMaintenanceRequest, TwinMetadataMaintenanceResult } from '../../shared/ethereum/twinMetadataMaintenance.ts';
import type { DuplicateCorrectionRequest, DuplicateCorrectionResult } from '../../shared/ethereum/duplicateCorrection.ts';
import { duplicateCorrectionLedgerSummary } from './duplicateCorrectionLedgerSummary.ts';
import { fileURLToPath } from 'node:url';
import type { GetPlatformProxyOptions } from 'wrangler';
import type { EthereumRevealEmptyPoolRequest, EthereumRevealEmptyPoolResult } from '../../shared/ethereum/revealMaintenance.ts';
import type { RelicImagesRequest, RelicImagesResult } from '../../shared/ethereum/relicImages.ts';
import { redactOwnerHatchingCursor, type OwnerHatchingMaintenanceRequest, type OwnerHatchingMaintenanceResult } from '../../shared/ethereum/ownerHatchingMaintenance.ts';
import type { MixedAllocationMaintenanceRequest, MixedAllocationMaintenanceResult } from '../../shared/ethereum/mixedAllocationMaintenance.ts';
import type { EthereumRevealAttributeBackfillPage, EthereumRevealAttributeBackfillRequest, EthereumRevealInspection, EthereumRevealMaintenanceRequest, EthereumRevealPurgeResult,
  EthereumRevealRetirementRequest, EthereumRevealRetirementResult, EthereumRevealRetirementCancellation, EthereumRevealReplacementRequest,
  EthereumRevealReplacementInspection, EthereumRevealCatalogUpdateRequest, EthereumRevealCatalogUpdateResult } from '../../shared/ethereum/revealMaintenance.ts';

export type EthereumRevealMaintenanceTransport = {
  twinMetadata?(request: TwinMetadataMaintenanceRequest): Promise<TwinMetadataMaintenanceResult>;
  duplicateCorrection?(request: DuplicateCorrectionRequest): Promise<DuplicateCorrectionResult>;
  mixedAllocation?(request: MixedAllocationMaintenanceRequest): Promise<MixedAllocationMaintenanceResult>;
  ownerHatching?(request: OwnerHatchingMaintenanceRequest): Promise<OwnerHatchingMaintenanceResult>;
  rebuildEmptyPool?(request: EthereumRevealEmptyPoolRequest): Promise<EthereumRevealEmptyPoolResult>;
  relicImages?(request: RelicImagesRequest): Promise<RelicImagesResult>;
  catalogUpdate?(request: EthereumRevealCatalogUpdateRequest): Promise<EthereumRevealCatalogUpdateResult>;
  backfillAttributes?(request: EthereumRevealAttributeBackfillRequest): Promise<EthereumRevealAttributeBackfillPage>;
  purgeRetired(request: EthereumRevealMaintenanceRequest): Promise<EthereumRevealPurgeResult>;
  inspectRetired(request: EthereumRevealMaintenanceRequest): Promise<EthereumRevealInspection>;
  retireForReplacement?(request: EthereumRevealRetirementRequest): Promise<EthereumRevealRetirementResult>;
  cancelRetirement?(request: EthereumRevealRetirementRequest): Promise<EthereumRevealRetirementCancellation>;
  inspectReplacement?(request: EthereumRevealReplacementRequest): Promise<EthereumRevealReplacementInspection>;
};
type Proxy = { env: { REVEAL_MAINTENANCE: EthereumRevealMaintenanceTransport }; dispose(): Promise<void> };
type ProxyFactory = (options: GetPlatformProxyOptions) => Promise<Proxy>;

export function mixedAllocationProgress(value: MixedAllocationMaintenanceResult): MixedAllocationMaintenanceResult {
  return {
    deploymentId: value.deploymentId, batchId: value.batchId, phase: value.phase, readyCount: value.readyCount,
    grailCount: value.grailCount, candidates: value.candidates, scanned: value.scanned, total: value.total, staged: value.staged,
    generationSeeded: value.generationSeeded, futureCount: value.futureCount, activationChecked: value.activationChecked,
    activationSelected: value.activationSelected, published: value.published, hatched: value.hatched, retrying: value.retrying,
    conflicts: value.conflicts, pendingEnrichment: value.pendingEnrichment, failedEnrichment: value.failedEnrichment,
    verificationPasses: value.verificationPasses, verificationInProgress: value.verificationInProgress,
    observationUntilMs: value.observationUntilMs, retryAfterMs: value.retryAfterMs, complete: value.complete,
    registryRevision: value.registryRevision, catalogRevision: value.catalogRevision, catalogUpdateId: value.catalogUpdateId,
    targetVersion: value.targetVersion, targetSha256: value.targetSha256, sourceSha256: value.sourceSha256,
    ...(value.remainingCleanup === undefined ? {} : { remainingCleanup: value.remainingCleanup }),
  };
}

async function defaultProxyFactory(options: GetPlatformProxyOptions): Promise<Proxy> {
  const { getPlatformProxy } = await import('wrangler');
  return getPlatformProxy<Proxy['env']>(options);
}

export async function withEthereumRevealMaintenance<T>(run: (transport: EthereumRevealMaintenanceTransport) => Promise<T>,
  createProxy: ProxyFactory = defaultProxyFactory): Promise<T> {
  let proxy: Proxy;
  try {
    proxy = await createProxy({ configPath: fileURLToPath(new URL('../ops/ethereum-reveal-maintenance.wrangler.jsonc', import.meta.url)),
      envFiles: [], persist: false, remoteBindings: true });
  } catch {
    throw new Error('Unable to connect to Ethereum reveal maintenance using existing Wrangler authentication.');
  }
  async function call<Value>(operation: () => Promise<Value>): Promise<Value> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Ethereum reveal maintenance timed out; inspect before retrying.')), 60_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  try {
    const inspection = (value: EthereumRevealInspection): EthereumRevealInspection => ({ deploymentId: value.deploymentId,
      chainId: value.chainId, contractAddress: value.contractAddress, metadataBaseUri: value.metadataBaseUri,
      revision: value.revision, storageEmpty: value.storageEmpty, alarmCleared: value.alarmCleared });
    return await run({ async twinMetadata(request) {
      const r = await call(() => proxy.env.REVEAL_MAINTENANCE.twinMetadata!(request));
      return { operationId: r.operationId, cohortSha256: r.cohortSha256, phase: r.phase,
        total: r.total, good: r.good, evil: r.evil, groups: r.groups, published: r.published,
        registryRevision: r.registryRevision, catalogRevision: r.catalogRevision, checked: r.checked, next: r.next };
    }, async duplicateCorrection(request) {
      const r = await call(() => proxy.env.REVEAL_MAINTENANCE.duplicateCorrection!(request));
      return { deploymentId: r.deploymentId, operationId: r.operationId, definitionSha256: r.definitionSha256,
        expectedRevision: r.expectedRevision, sourceCatalogRevision: r.sourceCatalogRevision, registryRevision: r.registryRevision,
        catalogRevision: r.catalogRevision, phase: r.phase, ledger: duplicateCorrectionLedgerSummary(r.ledger) };
    }, async mixedAllocation(request) {
      const result = await call(() => proxy.env.REVEAL_MAINTENANCE.mixedAllocation!(request));
      return mixedAllocationProgress(result);
    }, async ownerHatching(request) {
      const result = await call(() => proxy.env.REVEAL_MAINTENANCE.ownerHatching!(request));
      return { deploymentId: result.deploymentId, batchId: result.batchId, phase: result.phase,
        readyCount: result.readyCount, grailCount: result.grailCount, candidates: result.candidates,
        scanned: result.scanned, total: result.total, staged: result.staged,
        activationChecked: result.activationChecked, activationSelected: result.activationSelected, published: result.published,
        hatched: result.hatched, retrying: result.retrying, conflicts: result.conflicts, retryAfterMs: result.retryAfterMs,
        pendingEnrichment: result.pendingEnrichment, failedEnrichment: result.failedEnrichment,
        verificationCursor: redactOwnerHatchingCursor(result.verificationCursor), observationUntilMs: result.observationUntilMs, complete: result.complete };
    }, async rebuildEmptyPool(request) {
      const result = await call(() => proxy.env.REVEAL_MAINTENANCE.rebuildEmptyPool!(request));
      return { deploymentId: result.deploymentId, operationId: result.operationId, phase: result.phase,
        complete: result.complete, catalogRevision: result.catalogRevision, seeded: result.seeded, total: result.total,
        fenceActive: result.fenceActive, retryAfterMs: result.retryAfterMs,
        ...(result.observationUntilMs !== undefined ? { observationUntilMs: result.observationUntilMs } : {}),
        ...(result.emptyCounts ? { emptyCounts: { ...result.emptyCounts } } : {}) };
    }, async relicImages(request) {
      const result = await call(() => proxy.env.REVEAL_MAINTENANCE.relicImages!(request));
      if (result.action === 'apply') return { action: result.action, tokenId: result.tokenId, status: result.status };
      return { action: result.action, objects: Array.from({ length: result.objects.length }, (_, index) => {
        const object = result.objects[index];
        return { tokenId: object.tokenId, beforeJson: object.beforeJson, afterJson: object.afterJson,
          beforeSha256: object.beforeSha256, afterSha256: object.afterSha256, etag: object.etag };
      }) };
    }, async catalogUpdate(request) {
      const result = await call(() => proxy.env.REVEAL_MAINTENANCE.catalogUpdate!(request));
      return { deploymentId: result.deploymentId, batchId: result.batchId, phase: result.phase, complete: result.complete,
        catalogRevision: result.catalogRevision, total: result.total, staged: result.staged, applied: result.applied,
        published: result.published, frozen: result.frozen, retryAfterMs: result.retryAfterMs,
        conflicts: result.conflicts, retrying: result.retrying,
        ...(result.nextVerificationEggId !== undefined ? { nextVerificationEggId: result.nextVerificationEggId } : {}),
        ...(result.refreshTransaction ? { refreshTransaction: { chainId: result.refreshTransaction.chainId,
          to: result.refreshTransaction.to, data: result.refreshTransaction.data, value: result.refreshTransaction.value } } : {}) };
    }, async backfillAttributes(request) {
      const page = await call(() => proxy.env.REVEAL_MAINTENANCE.backfillAttributes!(request));
      return { nextCursor: page.nextCursor, eligible: page.eligible, missing: page.missing,
        invalid: page.invalid, conflict: page.conflict, conflictRechecks: page.conflictRechecks, enqueued: page.enqueued, requeued: page.requeued,
        ...(page.frozenThroughMs !== undefined && { frozenThroughMs: page.frozenThroughMs }),
        ...(page.tokens !== undefined && { tokens: Array.from({ length: page.tokens.length }, (_, index) => {
          const token = page.tokens![index];
          return { tokenId: token.tokenId, category: token.category, assetId: token.assetId, assignmentRevision: token.assignmentRevision,
            metadataRevision: token.metadataRevision, metadataSha256: token.metadataSha256, frozenMetadataSha256: token.frozenMetadataSha256,
            nonAttributeSha256: token.nonAttributeSha256, collectionBlock: token.collectionBlock,
            enrichment: token.enrichment === null ? null : { status: token.enrichment.status, assignmentRevision: token.enrichment.assignmentRevision,
              attempts: token.enrichment.attempts, lastError: token.enrichment.lastError, targetSha256: token.enrichment.targetSha256,
              checksumValid: token.enrichment.checksumValid } };
        }) }) };
    }, async purgeRetired(request) {
      const value = await call(() => proxy.env.REVEAL_MAINTENANCE.purgeRetired(request));
      return { ...inspection(value), purged: value.purged } as EthereumRevealPurgeResult;
    }, async inspectRetired(request) {
      return inspection(await call(() => proxy.env.REVEAL_MAINTENANCE.inspectRetired(request)));
    }, async retireForReplacement(request) {
      const value = await call(() => proxy.env.REVEAL_MAINTENANCE.retireForReplacement!(request));
      return { deploymentId: value.deploymentId, chainId: value.chainId, contractAddress: value.contractAddress,
        metadataBaseUri: value.metadataBaseUri, revision: value.revision, retiredAtMs: value.retiredAtMs,
        replacementDeploymentId: value.replacementDeploymentId, replacementRevision: value.replacementRevision, quiesced: value.quiesced };
    }, async cancelRetirement(request) {
      const value = await call(() => proxy.env.REVEAL_MAINTENANCE.cancelRetirement!(request));
      return { deploymentId: value.deploymentId, replacementDeploymentId: value.replacementDeploymentId,
        revision: value.revision, cancelled: value.cancelled, retired: value.retired };
    }, async inspectReplacement(request) {
      const value = await call(() => proxy.env.REVEAL_MAINTENANCE.inspectReplacement!(request));
      return { deploymentId: value.deploymentId, chainId: value.chainId, contractAddress: value.contractAddress,
        metadataBaseUri: value.metadataBaseUri, revision: value.revision, ready: value.ready, frozenThroughMs: value.frozenThroughMs,
        frozenArtworks: value.frozenArtworks, frozenMetadataSha256: value.frozenMetadataSha256,
        frozenSamples: Array.from({ length: value.frozenSamples.length }, (_, index) => {
          const { tokenId, metadataSha256, enrichment } = value.frozenSamples[index];
          return { tokenId, metadataSha256, ...(enrichment && { enrichment: {
            version: enrichment.version, sha256: enrichment.sha256, published: enrichment.published } }) };
        }) };
    } });
  } finally { await proxy.dispose(); }
}
