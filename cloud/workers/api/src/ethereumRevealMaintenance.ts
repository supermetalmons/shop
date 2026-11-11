import { WorkerEntrypoint } from 'cloudflare:workers';
import type { EthereumRevealAttributeBackfillPage, EthereumRevealInspection, EthereumRevealMaintenanceRequest, EthereumRevealPurgeResult,
  EthereumRevealReplacementInspection, EthereumRevealRetirementResult,
  EthereumRevealRetirementCancellation } from '../../../../shared/ethereum/revealMaintenance.js';
import type { EthereumRevealObject } from './ethereumRevealObject.js';
import { parseRevealAttributeBackfillRequest, parseRevealMaintenanceRequest, parseRevealReplacementRequest, parseRevealRetirementRequest,
  requireAttributeBackfillDeployment, requireRetiredRevealDeployment, requireRevealReplacement, requireRevealRetirementPair, requireRevealCancellationPair,
  revealMaintenanceIdentity } from './ethereumRevealMaintenanceSupport.js';
import { acquireRevealCommerceFence, requireCancelableRevealFence, resolveRevealCommerceFence } from './ethereumRevealCommerceFence.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import { verifyRevealDeployment } from './ethereumRevealChain.js';
import { parseCatalogUpdateRequest } from './ethereumRevealCatalogUpdate.js';
import { ETHEREUM_REVEAL_DEPLOYMENTS_SQL, parseEthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { EthereumRevealCatalogUpdateResult } from '../../../../shared/ethereum/revealMaintenance.js';
import { parseRelicImagesRequest, type RelicImagesResult } from '../../../../shared/ethereum/relicImages.js';
import { requireRelicImagesDeployment } from './ethereumRelicImages.js';
import { parseEmptyPoolRequest } from './ethereumRevealEmptyPool.js';
import type { EthereumRevealEmptyPoolResult } from '../../../../shared/ethereum/revealMaintenance.js';

export class EthereumRevealMaintenance extends WorkerEntrypoint<Env> {
  async rebuildEmptyPool(value: unknown): Promise<EthereumRevealEmptyPoolResult> {
    const request = parseEmptyPoolRequest(value);
    const row = await this.env.OPS_DB.prepare(`${ETHEREUM_REVEAL_DEPLOYMENTS_SQL} WHERE deployment_id=?`)
      .bind(request.deploymentId).first<Record<string, unknown>>();
    if (!row) throw new Error('Empty-pool deployment is not registered.');
    const deployment = parseEthereumRevealDeployment(row);
    if (deployment.chainId !== 1 || deployment.retiredAtMs != null) throw new Error('Empty-pool rebuild requires a retained mainnet deployment.');
    return this.env.ETHEREUM_REVEAL.getByName(`${deployment.chainId}:${deployment.contractAddress}`).rebuildEmptyPool(deployment, request);
  }

  async relicImages(value: unknown): Promise<RelicImagesResult> {
    const request = parseRelicImagesRequest(value);
    const deadline = Date.now() + 25_000;
    const timeout = createTimedAbortScope(undefined, { timeoutMs: 25_000, timeoutMessage: 'Relic image maintenance timed out.' });
    try {
      const deployment = await raceWithSignal(requireRelicImagesDeployment(this.env, request.scope), timeout.signal);
      const operation = this.env.ETHEREUM_REVEAL_PUBLISHER.getByName(`${deployment.chainId}:${deployment.contractAddress}`)
        .relicImages(request, deadline);
      this.ctx.waitUntil(operation.then(() => undefined, () => undefined));
      return await raceWithSignal<RelicImagesResult>(operation, timeout.signal);
    } finally { timeout.dispose(); }
  }

  async catalogUpdate(value: unknown): Promise<EthereumRevealCatalogUpdateResult> {
    const request = parseCatalogUpdateRequest(value);
    const row = await this.env.OPS_DB.prepare(`${ETHEREUM_REVEAL_DEPLOYMENTS_SQL} WHERE deployment_id=?`)
      .bind(request.deploymentId).first<Record<string, unknown>>();
    if (!row) throw new Error('Catalog deployment is not registered.');
    const deployment = parseEthereumRevealDeployment(row);
    if (deployment.retiredAtMs != null) throw new Error('Retired deployments cannot receive catalog updates.');
    return this.env.ETHEREUM_REVEAL.getByName(`${deployment.chainId}:${deployment.contractAddress}`).catalogUpdate(deployment, request);
  }

  async backfillAttributes(value: unknown): Promise<EthereumRevealAttributeBackfillPage> {
    const request = parseRevealAttributeBackfillRequest(value);
    const deployment = await requireAttributeBackfillDeployment(this.env, request);
    return this.env.ETHEREUM_REVEAL.getByName(`${deployment.chainId}:${deployment.contractAddress}`).backfillAttributes(request);
  }

  async purgeRetired(value: unknown): Promise<EthereumRevealPurgeResult> {
    return this.#run(value, (object, request) => object.purgeRetired(request));
  }

  async inspectRetired(value: unknown): Promise<EthereumRevealInspection> {
    return this.#run(value, (object, request) => object.inspectRetired(request));
  }

  async inspectReplacement(value: unknown): Promise<EthereumRevealReplacementInspection> {
    const request = parseRevealReplacementRequest(value);
    const timeout = createTimedAbortScope(undefined, { timeoutMs: 55_000, timeoutMessage: 'Replacement inspection timed out.' });
    try {
      const deployment = await raceWithSignal(requireRevealReplacement(this.env, request), timeout.signal);
      return await raceWithSignal(this.env.ETHEREUM_REVEAL.getByName(`${deployment.chainId}:${deployment.contractAddress}`)
        .inspectReplacement(request), timeout.signal);
    } finally { timeout.dispose(); }
  }

  async retireForReplacement(value: unknown): Promise<EthereumRevealRetirementResult> {
    const request = parseRevealRetirementRequest(value);
    const timeout = createTimedAbortScope(undefined, { timeoutMs: 55_000, timeoutMessage: 'Reveal retirement timed out.' });
    try {
      let pair = await raceWithSignal(requireRevealRetirementPair(this.env, request), timeout.signal);
      const replacementRequest = { deploymentId: pair.replacement.deploymentId, expectedRevision: pair.replacement.revision };
      const readPair = async () => {
        const current = await requireRevealRetirementPair(this.env, request);
        if (current.replacement.revision !== replacementRequest.expectedRevision) {
          throw new Error('Replacement reveal deployment revision changed during retirement.');
        }
        return current;
      };
      await raceWithSignal(this.env.ETHEREUM_REVEAL.getByName(`${pair.replacement.chainId}:${pair.replacement.contractAddress}`)
        .inspectReplacement(replacementRequest), timeout.signal);
      if (!pair.replay) {
        await verifyRevealDeployment(this.env, pair.replacement, timeout.signal);
        await raceWithSignal(acquireRevealCommerceFence(this.env.COMMERCE_DB, request, pair.deployment, pair.replacement), timeout.signal);
        pair = await raceWithSignal(readPair(), timeout.signal);
        if (!pair.replay) {
          try {
            const row = await raceWithSignal(this.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments
              SET retired_at_ms=CAST(unixepoch('subsec') * 1000 AS INTEGER),replacement_deployment_id=?,
                revision=revision+1,updated_at_ms=CAST(unixepoch('subsec') * 1000 AS INTEGER)
              WHERE deployment_id=? AND revision=? AND state='paused' AND retired_at_ms IS NULL
                AND EXISTS (SELECT 1 FROM ethereum_reveal_deployments AS replacement
                  WHERE replacement.deployment_id=? AND replacement.revision=? AND replacement.state='active'
                    AND replacement.retired_at_ms IS NULL AND replacement.last_error IS NULL
                    AND replacement.catalog_version=?) RETURNING deployment_id`)
              .bind(request.replacementDeploymentId, request.deploymentId, request.expectedRevision,
                request.replacementDeploymentId, request.expectedReplacementRevision, pair.replacement.catalogVersion).first(), timeout.signal);
            if (!row) throw new Error('Reveal retirement revision changed before it could be committed.');
          } catch (error) {
            pair = await raceWithSignal(readPair(), timeout.signal);
            if (!pair.replay) throw error;
          }
        }
      }
      pair = await raceWithSignal(readPair(), timeout.signal);
      if (!pair.replay || pair.deployment.retiredAtMs == null) throw new Error('Reveal retirement could not be confirmed.');
      await raceWithSignal(resolveRevealCommerceFence(this.env.COMMERCE_DB, request, pair.deployment, pair.replacement, 'retired'), timeout.signal);
      const operation = this.env.ETHEREUM_REVEAL.getByName(`${pair.deployment.chainId}:${pair.deployment.contractAddress}`)
        .quiesceRetired({ deploymentId: pair.deployment.deploymentId, expectedRevision: pair.deployment.revision });
      this.ctx.waitUntil(operation.then(() => undefined, () => undefined));
      await raceWithSignal(operation, timeout.signal);
      pair = await raceWithSignal(readPair(), timeout.signal);
      return { ...revealMaintenanceIdentity(pair.deployment), retiredAtMs: pair.deployment.retiredAtMs!,
        replacementDeploymentId: pair.replacement.deploymentId, replacementRevision: request.expectedReplacementRevision, quiesced: true };
    } finally { timeout.dispose(); }
  }

  async cancelRetirement(value: unknown): Promise<EthereumRevealRetirementCancellation> {
    const request = parseRevealRetirementRequest(value);
    const timeout = createTimedAbortScope(undefined, { timeoutMs: 55_000, timeoutMessage: 'Retirement cancellation timed out.' });
    try {
      let pair = await raceWithSignal(requireRevealCancellationPair(this.env, request), timeout.signal);
      const state = await raceWithSignal(requireCancelableRevealFence(this.env.COMMERCE_DB, request,
        pair.deployment, pair.replacement), timeout.signal);
      if (state === null && pair.deployment.retiredAtMs == null && pair.deployment.revision === request.expectedRevision
        && pair.deployment.state !== 'paused') throw new Error('An unfenced retirement cancellation requires the paused old deployment.');
      if (pair.deployment.retiredAtMs == null && state !== 'cancelled') {
        await raceWithSignal(this.env.OPS_DB.prepare(`UPDATE ethereum_reveal_deployments
          SET revision=revision+1,updated_at_ms=CAST(unixepoch('subsec') * 1000 AS INTEGER)
          WHERE deployment_id=? AND revision=? AND retired_at_ms IS NULL RETURNING revision`)
          .bind(request.deploymentId, request.expectedRevision).first(), timeout.signal);
        pair = await raceWithSignal(requireRevealCancellationPair(this.env, request), timeout.signal);
      }
      const retired = pair.deployment.retiredAtMs != null;
      if (!retired && pair.deployment.revision <= request.expectedRevision) throw new Error('Retirement cancellation revision fence was not confirmed.');
      await raceWithSignal(resolveRevealCommerceFence(this.env.COMMERCE_DB, request, pair.deployment, pair.replacement,
        retired ? 'retired' : 'cancelled'), timeout.signal);
      return { deploymentId: pair.deployment.deploymentId, replacementDeploymentId: pair.replacement.deploymentId,
        revision: pair.deployment.revision, cancelled: !retired, retired };
    } finally { timeout.dispose(); }
  }

  async #run<T>(value: unknown, invoke: (object: DurableObjectStub<EthereumRevealObject>,
    request: EthereumRevealMaintenanceRequest) => Promise<T>): Promise<T> {
    const request = parseRevealMaintenanceRequest(value);
    const timeout = createTimedAbortScope(undefined, { timeoutMs: 55_000, timeoutMessage: 'Reveal maintenance timed out.' });
    try {
      const deployment = await raceWithSignal(requireRetiredRevealDeployment(this.env, request), timeout.signal);
      const object = this.env.ETHEREUM_REVEAL.getByName(`${deployment.chainId}:${deployment.contractAddress}`);
      const operation = invoke(object, request);
      this.ctx.waitUntil(operation.then(() => undefined, () => undefined));
      return await raceWithSignal(operation, timeout.signal);
    } finally { timeout.dispose(); }
  }
}
