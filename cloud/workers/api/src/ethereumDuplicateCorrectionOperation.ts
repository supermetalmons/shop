import { readEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { duplicateCorrectionRegistryPhase, requireDuplicateCorrectionScope, type DuplicateCorrectionDefinition,
  type DuplicateCorrectionRequest, type DuplicateCorrectionResult } from '../../../../shared/ethereum/duplicateCorrection.js';
import type { DuplicateCorrectionLedgerResult } from '../../../../shared/ethereum/duplicateCorrectionLedger.js';

type Journal = Pick<DuplicateCorrectionRequest, 'expectedRevision' | 'sourceCatalogRevision' | 'definitionSha256'>;

type Host = {
  storage: Pick<DurableObjectStorage, 'get' | 'put'>;
  db: D1Database;
  ledger(action: DuplicateCorrectionRequest['action']): DuplicateCorrectionLedgerResult;
  assertAvailable(): void;
};

export async function runDuplicateCorrection(host: Host, definition: DuplicateCorrectionDefinition, request: DuplicateCorrectionRequest): Promise<DuplicateCorrectionResult> {
  const current = async () => {
    const row = await readEthereumRevealDeployment(host.db, definition);
    requireDuplicateCorrectionScope(row, definition);
    return row;
  };
  const transition = async (from: EthereumRevealDeployment, set: string, bindings: (string | number)[]) => {
    host.assertAvailable();
    const changed = await host.db.prepare(`UPDATE ethereum_reveal_deployments SET ${set},revision=revision+1,updated_at_ms=?
      WHERE deployment_id=? AND chain_id=1 AND contract_address=? AND drop_id='111k' AND metadata_base_uri=? AND deployment_block=?
      AND catalog_version=? AND state='active' AND provisioned_at_ms IS NOT NULL AND retired_at_ms IS NULL AND last_error IS NULL
      AND revision=? AND catalog_revision=? AND catalog_update_id IS ? AND effective_catalog_version=? AND effective_catalog_sha256=?
      RETURNING deployment_id`).bind(...bindings, Date.now(), definition.deploymentId, definition.contractAddress, definition.metadataBaseUri,
      definition.deploymentBlock, definition.originCatalogVersion, from.revision, from.catalogRevision!, from.catalogUpdateId ?? null,
      definition.catalogVersion, definition.manifestSha256).first();
    if (!changed) throw new Error('Duplicate correction registry transition lost its revision. Inspect before retrying.');
    return current();
  };
  const journalKey = `duplicate-correction:${request.operationId}`;
  let journal = await host.storage.get<Journal>(journalKey);
  if (journal && (journal.expectedRevision !== request.expectedRevision || journal.sourceCatalogRevision !== request.sourceCatalogRevision ||
    journal.definitionSha256 !== request.definitionSha256)) throw new Error('Resume the original duplicate correction journal.');
  let row = await current();
  let phase = duplicateCorrectionRegistryPhase(row, definition, request);
  if ((!journal && (phase === 'complete' || phase === 'mirrored')) || (journal && phase === 'unstarted')) {
    throw new Error('Correction registry lost its original journal.');
  }
  if (request.action === 'verify' && phase !== 'complete') throw new Error('Complete registry and ledger cutover before verification.');
  host.assertAvailable();
  let ledger = host.ledger(phase === 'complete' || phase === 'mirrored' ? 'verify' : 'inspect');
  if (ledger.applied && phase === 'unstarted' || !ledger.applied && (phase === 'mirrored' || phase === 'complete')) {
    throw new Error('Duplicate correction registry and ledger disagree.');
  }
  if (request.action === 'apply') {
    if (phase === 'unstarted') {
      if (ledger.totals.conflicts) throw new Error('Duplicate correction found protected inventory conflicts.');
      row = await transition(row, 'catalog_update_id=?,catalog_update_started_at_ms=?', [request.operationId, Date.now()]);
      phase = duplicateCorrectionRegistryPhase(row, definition, request);
    }
    if (phase === 'claimed') {
      if (!journal) {
        journal = { expectedRevision: request.expectedRevision, sourceCatalogRevision: request.sourceCatalogRevision, definitionSha256: request.definitionSha256 };
        await host.storage.put(journalKey, journal);
      }
      host.assertAvailable();
      if (!ledger.applied) ledger = host.ledger('apply');
      if (!ledger.applied || ledger.catalogRevision !== request.sourceCatalogRevision + 1) throw new Error('Correction ledger did not commit.');
      row = await transition(row, 'catalog_revision=catalog_revision+1', []);
      phase = duplicateCorrectionRegistryPhase(row, definition, request);
    }
    if (phase === 'mirrored') {
      row = await transition(row, 'catalog_update_id=NULL,catalog_update_started_at_ms=NULL', []);
      phase = duplicateCorrectionRegistryPhase(row, definition, request);
      if (phase !== 'complete') throw new Error('Correction registry release did not complete.');
    }
  }
  return { deploymentId: definition.deploymentId, operationId: definition.operationId, definitionSha256: request.definitionSha256,
    expectedRevision: request.expectedRevision, sourceCatalogRevision: request.sourceCatalogRevision,
    registryRevision: row.revision, catalogRevision: row.catalogRevision!, phase, ledger };
}
