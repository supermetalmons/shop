import { readEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { mixedAllocationHash } from '../../../../shared/ethereum/revealMixedAllocation.js';
import type { MixedAllocationMaintenanceRequest, MixedAllocationMaintenanceResult } from '../../../../shared/ethereum/mixedAllocationMaintenance.js';
import type { OwnerHatchingMaintenanceResult } from '../../../../shared/ethereum/ownerHatchingMaintenance.js';
import type { MixedAllocationInput } from './ethereumRevealMixedAllocation.js';
import { EthereumRevealCatalogReader } from './ethereumRevealCatalogReader.js';
import { ownerHatchingProgress, type Preparation, type EthereumOwnerHatchingOperations } from './ethereumOwnerHatchingOperations.js';
import type { RevealSql } from './ethereumRevealStore.js';

type Journal = { revision: number; sourceRevision: number; releaseHash: string; cancelled?: true };
type Host = {
  db: D1Database;
  storage: Pick<DurableObjectStorage, 'get' | 'put'>;
  sql: RevealSql;
  operations(deployment: EthereumRevealDeployment, requireCurrent: (expected?: number) => Promise<void>): EthereumOwnerHatchingOperations;
};
type RegistryPhase = 'initial' | 'claimed' | 'mirrored' | 'released' | 'cancelled';

const MAINNET = { chainId: 1, contractAddress: '0x08cded8258730bda384ff198001e47a1b50f7f9d' };

export function requireMixedMainnetDeployment(row: EthereumRevealDeployment | null): asserts row is EthereumRevealDeployment {
  if (!row || row.deploymentId !== 'mainnet-v1' || row.dropId !== '111k' || row.chainId !== MAINNET.chainId ||
    row.contractAddress !== MAINNET.contractAddress || row.deploymentBlock !== 26387160 ||
    row.metadataBaseUri !== 'https://cdn.mons.shop/111k/' || row.catalogVersion !== '111k-v8' ||
    row.templateSha256 !== '07608824a33f42b56858a32cb675067fc633239cad9be461de01c62a2f2df9e9' ||
    row.state !== 'active' || row.retiredAtMs != null || row.provisionedAtMs === null || row.lastError !== null) {
    throw new Error('The active mainnet mixed allocation deployment does not match its release.');
  }
}

export class EthereumMixedAllocationOperation {
  private readonly reader: EthereumRevealCatalogReader;
  private readonly releaseHash: string;
  private readonly journalKey: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly host: Host, private readonly release: MixedAllocationInput) {
    this.reader = new EthereumRevealCatalogReader(host.sql);
    this.releaseHash = mixedAllocationHash(release.definition);
    this.journalKey = `mixed-mainnet:${release.batchId}`;
  }

  run(request: MixedAllocationMaintenanceRequest): Promise<MixedAllocationMaintenanceResult> {
    const operation = this.pending.then(() => this.advance(request));
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }

  private async current() {
    const row = await readEthereumRevealDeployment(this.host.db, MAINNET);
    requireMixedMainnetDeployment(row);
    return row;
  }

  private registryPhase(row: EthereumRevealDeployment, journal: Journal): RegistryPhase {
    const { predecessor, target } = this.release.definition;
    const old = row.effectiveCatalogVersion === predecessor.catalogVersion && row.effectiveCatalogSha256 === predecessor.manifestSha256 &&
      row.catalogRevision === journal.sourceRevision;
    const next = row.effectiveCatalogVersion === target.catalogVersion && row.effectiveCatalogSha256 === target.manifestSha256 &&
      row.catalogRevision === journal.sourceRevision + 1;
    if (row.catalogUpdateId == null) {
      if (old && row.revision === journal.revision) return 'initial';
      if (old && journal.cancelled && row.revision === journal.revision + 2) return 'cancelled';
      if (next && row.revision >= journal.revision + 3) return 'released';
    } else if (row.catalogUpdateId === this.release.batchId) {
      if (old && row.revision === journal.revision + 1) return 'claimed';
      if (next && row.revision === journal.revision + 2) return 'mirrored';
    }
    throw new Error('Mixed allocation registry owner, catalog, or revision changed.');
  }

  private async transition(from: 'initial' | 'claimed' | 'mirrored', journal: Journal, cancel = false) {
    const { predecessor, target } = this.release.definition;
    const old = from === 'mirrored' ? target : predecessor;
    const set = from === 'initial' ? 'catalog_update_id=?,catalog_update_started_at_ms=?' :
      from === 'claimed' && !cancel ? 'effective_catalog_version=?,effective_catalog_sha256=?,catalog_revision=catalog_revision+1' :
        'catalog_update_id=NULL,catalog_update_started_at_ms=NULL';
    const now = Date.now();
    const bindings = from === 'initial' ? [this.release.batchId, now] :
      from === 'claimed' && !cancel ? [target.catalogVersion, target.manifestSha256] : [];
    const step = from === 'initial' ? 0 : from === 'claimed' ? 1 : 2;
    const result = await this.host.db.prepare(`UPDATE ethereum_reveal_deployments SET ${set},revision=revision+1,updated_at_ms=?
      WHERE deployment_id='mainnet-v1' AND chain_id=1 AND contract_address=? AND revision=? AND catalog_update_id IS ?
      AND state='active' AND retired_at_ms IS NULL AND last_error IS NULL AND effective_catalog_version=? AND effective_catalog_sha256=?
      AND catalog_revision=? RETURNING deployment_id`).bind(...bindings, now, MAINNET.contractAddress, journal.revision + step,
        from === 'initial' ? null : this.release.batchId, old.catalogVersion, old.manifestSha256,
        journal.sourceRevision + Number(from === 'mirrored')).first();
    if (!result) throw new Error('Mixed allocation registry transition needs retry with its original revision.');
    return this.current();
  }

  private preparation(request: MixedAllocationMaintenanceRequest) {
    if (!this.host.sql.exec("SELECT 1 FROM sqlite_schema WHERE name='owner_hatching_preparations' AND type='table'").toArray().length) return;
    const row = this.host.sql.exec<Preparation>('SELECT * FROM owner_hatching_preparations WHERE batch_id=?', request.batchId).toArray()[0];
    if (row) {
      const saved = JSON.parse(row.request_json) as Record<string, unknown>;
      if (saved.expectedRevision !== request.expectedRevision || saved.deploymentId !== request.deploymentId ||
        saved.batchId !== request.batchId || saved.mixedReleaseSha256 !== this.releaseHash) throw new Error('Mixed preparation identity changed.');
    }
    return row;
  }

  private describe(request: MixedAllocationMaintenanceRequest, registry: EthereumRevealDeployment, journal: Journal, remainingCleanup?: number): MixedAllocationMaintenanceResult {
    const row = this.preparation(request);
    const { target, sourceSha256, groups } = this.release.definition;
    const readyCount = groups.reduce((n, group) => n + group.ownerCount, 0);
    const futureCount = groups.reduce((n, group) => n + group.lastId - group.firstId + 1 - group.ownerCount, 0);
    const work = row && this.host.sql.exec<{ seeded: number }>('SELECT seeded FROM reveal_catalog_generations WHERE batch_id=?', request.batchId).toArray()[0];
    let progress: OwnerHatchingMaintenanceResult | undefined;
    if (row) {
      const activation = this.host.sql.exec<{ selected:number; checked:number }>(
        'SELECT selected,checked FROM owner_hatching_activation WHERE batch_id=?', request.batchId).toArray()[0];
      const staged = this.host.sql.exec<{ n:number }>('SELECT COUNT(*) AS n FROM reveal_mixed_artworks WHERE batch_id=? AND attributes_sha256 IS NOT NULL', request.batchId).toArray()[0].n;
      progress = ownerHatchingProgress(request.deploymentId, row, this.reader.ownerHatching, activation, staged);
    }
    const { verificationCursor, ...safe } = progress ?? { deploymentId: request.deploymentId, batchId: request.batchId,
      phase: journal.cancelled ? 'cancelled' as const : 'unstarted' as const, readyCount, grailCount: readyCount, candidates: 0, scanned: 0,
      total: 0, staged: 0, activationChecked: 0, activationSelected: 0, published: 0, hatched: 0, retrying: 0, conflicts: 0,
      pendingEnrichment: 0, failedEnrichment: 0, retryAfterMs: 0, verificationCursor: null, observationUntilMs: null, complete: false };
    return { ...safe, complete: safe.complete && registry.catalogUpdateId !== this.release.batchId,
      verificationInProgress: verificationCursor !== null || row?.verification_hatched != null && row.verification_hatched !== safe.hatched,
      verificationPasses: row?.verification_passes ?? 0, generationSeeded: work?.seeded ?? 0,
      futureCount, registryRevision: registry.revision, catalogRevision: registry.catalogRevision!, catalogUpdateId: registry.catalogUpdateId ?? null,
      targetVersion: target.catalogVersion, targetSha256: target.manifestSha256, sourceSha256, ...(remainingCleanup === undefined ? {} : { remainingCleanup }) };
  }

  private localCommitted(journal: Journal) {
    const local = this.reader.effectiveCatalog();
    const { predecessor, target } = this.release.definition;
    if (local?.catalogVersion === target.catalogVersion && local.manifestSha256 === target.manifestSha256 &&
      local.catalogRevision === journal.sourceRevision + 1 && local.generation === this.release.batchId) return true;
    if (local?.catalogVersion === predecessor.catalogVersion && local.manifestSha256 === predecessor.manifestSha256 &&
      local.catalogRevision === journal.sourceRevision && local.generation) return false;
    throw new Error('Mixed allocation ledger catalog does not match its operation.');
  }

  private async advance(request: MixedAllocationMaintenanceRequest) {
    let registry = await this.current();
    let saved = await this.host.storage.get<Journal>(this.journalKey);
    if (saved && !saved.cancelled && saved.releaseHash === this.releaseHash && registry.revision > saved.revision &&
      registry.catalogUpdateId == null && registry.catalogRevision === saved.sourceRevision &&
      !this.localCommitted(saved) && !this.preparation(request) && !this.reader.status(request.batchId)) {
      if (request.expectedRevision !== registry.revision) throw new Error('Initial mixed claim lost. Use the current registry revision and a new --journal path.');
      saved = undefined;
    }
    const hasJournal = !!saved;
    let journal: Journal = saved ?? { revision: request.expectedRevision, sourceRevision: registry.catalogRevision!, releaseHash: this.releaseHash };
    if (journal.revision !== request.expectedRevision || journal.releaseHash !== this.releaseHash) throw new Error('Resume the original mixed allocation journal.');
    if (saved && !saved.cancelled && (request.action === 'status' || request.action === 'verify') &&
      registry.catalogUpdateId !== request.batchId && this.preparation(request)?.phase === 'complete') {
      const targetRevision = journal.sourceRevision + 1;
      const record = this.host.sql.exec(`SELECT 1 FROM reveal_catalog_generations WHERE batch_id=? AND batch_sha256=?
        AND phase='complete' AND activated_at_ms IS NOT NULL AND source_revision=? AND target_revision=?`,
        request.batchId, this.releaseHash, journal.sourceRevision, targetRevision).toArray();
      if (!record.length) throw new Error('Mixed allocation completion evidence is missing.');
      const { target } = this.release.definition;
      const requireReleased = (current: EthereumRevealDeployment) => {
        const revision = current.catalogRevision ?? 0;
        if (current.catalogUpdateId === request.batchId || current.revision < journal.revision + 3 || revision < targetRevision ||
          revision === targetRevision && (current.effectiveCatalogVersion !== target.catalogVersion ||
            current.effectiveCatalogSha256 !== target.manifestSha256)) throw new Error('Mixed allocation release history does not match the registry.');
      };
      requireReleased(registry);
      if (request.action === 'verify') {
        const operations = this.host.operations(registry, async () => requireReleased(await this.current()));
        await operations.run(registry, { ...request, action: 'verify' });
        registry = await this.current();
        requireReleased(registry);
      }
      return this.describe(request, registry, journal);
    }
    let phase = this.registryPhase(registry, journal);
    const committed = this.localCommitted(journal);
    if (phase === 'initial' && committed || (phase === 'released' || phase === 'mirrored') && !committed ||
      !hasJournal && (phase !== 'initial' || this.preparation(request))) throw new Error('Mixed allocation registry and ledger do not agree.');
    if (request.action === 'status') return this.describe(request, registry, journal);
    if (request.action === 'cancel' && phase === 'initial' && hasJournal && !journal.cancelled) {
      journal = { ...journal, cancelled: true };
      await this.host.storage.put(this.journalKey, journal);
    }
    if (phase === 'initial' && !journal.cancelled) {
      if (request.action !== 'begin') throw new Error('Begin the mixed allocation first.');
      const settings = this.reader.settings();
      if (settings?.candidate_catalog_generation ||
        this.host.sql.exec("SELECT 1 FROM reveal_catalog_generations WHERE phase='active' LIMIT 1").toArray().length ||
        this.host.sql.exec("SELECT 1 FROM sqlite_schema WHERE name='owner_hatching_preparations'").toArray().length &&
        this.host.sql.exec("SELECT 1 FROM owner_hatching_preparations WHERE phase NOT IN ('complete','cancelled') LIMIT 1").toArray().length) {
        throw new Error('A catalog or owner operation is already running.');
      }
      if (!hasJournal) await this.host.storage.put(this.journalKey, journal);
      registry = await this.transition('initial', journal);
      phase = this.registryPhase(registry, journal);
    }
    if (phase === 'claimed' && committed) {
      registry = await this.transition('claimed', journal);
      phase = this.registryPhase(registry, journal);
    }
    if (phase === 'cancelled' || journal.cancelled) {
      if (request.action !== 'cancel') throw new Error('This mixed allocation was cancelled.');
      if (phase === 'claimed') registry = await this.transition('claimed', journal, true);
      return this.describe(request, registry, journal, 0);
    }
    const requireCurrent = async (expected?: number) => {
      const state = this.registryPhase(await this.current(), journal);
      if (expected !== undefined && expected !== journal.revision || state !== 'claimed' && state !== 'mirrored' &&
        !(state === 'released' && this.preparation(request)?.phase === 'complete')) throw new Error('Mixed allocation does not own the registry.');
    };
    await requireCurrent();
    const operations = this.host.operations(registry, requireCurrent);
    if (request.action === 'cancel') {
      if (phase !== 'claimed' || committed) throw new Error('An activated mixed allocation must resume forward.');
      const cleanup = this.preparation(request) ? await operations.cancelMixed(registry, request) : { remaining: 0 };
      if (!cleanup.remaining) {
        journal = { ...journal, cancelled: true };
        await this.host.storage.put(this.journalKey, journal);
        registry = await this.transition('claimed', journal, true);
      }
      return this.describe(request, registry, journal, cleanup.remaining);
    }
    const result = await operations.run(registry, { ...request, action: request.action });
    if (phase === 'claimed' && this.localCommitted(journal)) {
      registry = await this.transition('claimed', journal);
      phase = this.registryPhase(registry, journal);
    }
    if (result.complete && phase === 'mirrored') registry = await this.transition('mirrored', journal);
    return this.describe(request, registry, journal);
  }
}
