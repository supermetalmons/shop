import { createHash } from 'node:crypto';
import { encodeCall } from '../../../../shared/ethereum/abi.js';
import { ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.js';
import { getStandaloneOwnerHatchingBatch, ownerHatchingCatalogSha256 } from '../../../../shared/ethereum/ownerHatchingCatalog.js';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.js';
import { redactOwnerHatchingCursor, type OwnerHatchingMaintenanceRequest, type OwnerHatchingMaintenanceResult } from '../../../../shared/ethereum/ownerHatchingMaintenance.js';
import { mixedAllocationHash } from '../../../../shared/ethereum/revealMixedAllocation.js';
import { validateRevealAssetCatalog } from '../../../../shared/ethereum/revealAssetCatalog.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { EthereumRevealStore, RevealSql } from './ethereumRevealStore.js';
import { ethereumBlockSnapshot, ethereumCallBatch, verifyEthereumBlockSnapshot, withEthereumReadProvider,
  type EthereumCollectionReadContext } from './ethereumRuntime.js';
import { ethereumCollectionStatsFromData, ethereumTokenInfos } from './ethereumRead.js';
import { fetchRevealAttributePayload, MAX_REVEAL_METADATA_BYTES } from './ethereumRevealAttributes.js';
import { REVEAL_ARTWORK_COUNT, revealRandomInteger } from './ethereumRevealCatalog.js';
import type { EthereumOwnerHatchingReader } from './ethereumOwnerHatchingReader.js';
import type { MixedAllocationInput } from './ethereumRevealMixedAllocation.js';

type SavedRequest = OwnerHatchingMaintenanceRequest & { mixedReleaseSha256?: string };
type OperationIdentity = Pick<OwnerHatchingMaintenanceRequest, 'deploymentId' | 'expectedRevision' | 'batchId'>;

function targetCount(request: SavedRequest): number {
  return request.mixedReleaseSha256 ? request.readyCount! : request.grailIds!.length;
}

function serializeBegin(request: SavedRequest): string {
  return JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))));
}

export type Preparation = {
  batch_id: string; request_json: string; block_number: number; block_hash: string; total: number; scanned: number;
  catalog_revision: number; phase: OwnerHatchingMaintenanceResult['phase']; candidates: number;
  verification_cursor: string | null; verification_passes: number; observation_until_ms: number | null;
  verification_hatched?: number | null;
};
type Activation = { batch_id: string; block_number: number; block_hash: string; checked: number; selected: number };
type ActivationCandidate = { position: number; token_id: string };
const ACTIVATION_PAGE_SIZE = 100;
type Options = {
  env: Env;
  sql: RevealSql;
  transaction<T>(action: () => T): T;
  store: EthereumRevealStore;
  recover(tokenIds: string[]): Promise<boolean>;
  requireCurrent(expectedRevision?: number): Promise<void>;
  wake(): Promise<void>;
  randomInteger?(maximum: number): number;
};

export function ownerHatchingProgress(deploymentId: string, row: Preparation, reader: EthereumOwnerHatchingReader,
  activation: Pick<Activation, 'checked' | 'selected'> | undefined, staged: number): OwnerHatchingMaintenanceResult {
  const request = JSON.parse(row.request_json) as SavedRequest;
  const prepared = reader.batchStatus(row.batch_id);
  return { deploymentId, batchId: row.batch_id, phase: row.phase, readyCount: request.readyCount!,
    grailCount: targetCount(request), candidates: row.candidates, scanned: row.scanned, total: row.total, staged,
    activationChecked: activation?.checked ?? 0, activationSelected: prepared?.readyCount ?? activation?.selected ?? 0,
    published: prepared?.published ?? 0, hatched: prepared?.hatched ?? 0,
    retrying: prepared?.pendingPublication ?? 0, conflicts: prepared?.conflicts ?? 0,
    pendingEnrichment: prepared?.pendingEnrichment ?? 0, failedEnrichment: prepared?.failedEnrichment ?? 0,
    retryAfterMs: row.phase === 'complete' || row.phase === 'cancelled' ? 0 : 1_000, verificationCursor: redactOwnerHatchingCursor(row.verification_cursor),
    observationUntilMs: row.observation_until_ms, complete: row.phase === 'complete' };
}

export class EthereumOwnerHatchingOperations {
  private readonly mixedReleaseSha256?: string;

  constructor(private readonly options: Options, private readonly mixed?: MixedAllocationInput) {
    if (mixed) {
      validateRevealAssetCatalog(mixed.targetCatalog, mixed.definition.target);
      this.mixedReleaseSha256 = mixedAllocationHash(mixed.definition);
    }
    options.transaction(() => {
      options.sql.exec(`CREATE TABLE IF NOT EXISTS owner_hatching_preparations (
        batch_id TEXT PRIMARY KEY,request_json TEXT NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,
        total INTEGER NOT NULL,scanned INTEGER NOT NULL DEFAULT 0,catalog_revision INTEGER NOT NULL,
        phase TEXT NOT NULL DEFAULT 'scanning',candidates INTEGER NOT NULL DEFAULT 0,
        verification_cursor TEXT,verification_passes INTEGER NOT NULL DEFAULT 0,observation_until_ms INTEGER)`);
      if (mixed && !options.sql.exec("SELECT 1 FROM pragma_table_info('owner_hatching_preparations') WHERE name='verification_hatched'").toArray().length) {
        options.sql.exec('ALTER TABLE owner_hatching_preparations ADD COLUMN verification_hatched INTEGER');
      }
      options.sql.exec(`CREATE TABLE IF NOT EXISTS owner_hatching_candidates (
        batch_id TEXT NOT NULL REFERENCES owner_hatching_preparations(batch_id),token_id TEXT NOT NULL,
        PRIMARY KEY(batch_id,token_id))`);
      options.sql.exec(`CREATE TABLE IF NOT EXISTS owner_hatching_trait_staging (
        batch_id TEXT NOT NULL REFERENCES owner_hatching_preparations(batch_id),asset_id INTEGER NOT NULL,
        attributes_json TEXT NOT NULL,PRIMARY KEY(batch_id,asset_id))`);
      options.sql.exec(`CREATE TABLE IF NOT EXISTS owner_hatching_activation (
        batch_id TEXT PRIMARY KEY REFERENCES owner_hatching_preparations(batch_id),
        block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,checked INTEGER NOT NULL DEFAULT 0,selected INTEGER NOT NULL DEFAULT 0)`);
      options.sql.exec(`CREATE TABLE IF NOT EXISTS owner_hatching_activation_candidates (
        batch_id TEXT NOT NULL REFERENCES owner_hatching_activation(batch_id),position INTEGER NOT NULL,token_id TEXT NOT NULL,
        live INTEGER CHECK(live IN (0,1)),PRIMARY KEY(batch_id,position),UNIQUE(batch_id,token_id))`);
    });
  }

  private read(batchId: string): Preparation {
    const row = this.options.sql.exec<Preparation>('SELECT * FROM owner_hatching_preparations WHERE batch_id=?', batchId).toArray()[0];
    if (!row) throw new Error('Unknown owner hatching batch.');
    return row;
  }

  private context(deployment: EthereumRevealDeployment): EthereumCollectionReadContext {
    return { env: this.options.env, nowMs: Date.now(), signal: AbortSignal.timeout(45_000), fetch, providerLane: 'reveal',
      config: { enabled: true, chainId: deployment.chainId, contractAddress: deployment.contractAddress,
        metadataBaseUri: deployment.metadataBaseUri, deploymentBlock: deployment.deploymentBlock } };
  }

  private scanSnapshot(deployment: EthereumRevealDeployment) {
    return withEthereumReadProvider(this.context(deployment), async context => {
      const snapshot = await ethereumBlockSnapshot(context);
      const [statsData] = await ethereumCallBatch(context, [encodeCall(ETHEREUM_FUNCTIONS.stats, ['address'], [`0x${'0'.repeat(40)}`])], snapshot.blockHash);
      const stats = ethereumCollectionStatsFromData(context, null, statsData);
      await verifyEthereumBlockSnapshot(context, snapshot);
      return { ...snapshot, total: stats.artworksMinted };
    });
  }

  private status(deployment: EthereumRevealDeployment, batchId: string): OwnerHatchingMaintenanceResult {
    const row = this.read(batchId);
    const request = JSON.parse(row.request_json) as SavedRequest;
    const staged = this.mixed ? this.options.store.catalogUpdate.mixed.status(batchId).metadataStaged
      : row.phase === 'complete' ? targetCount(request) : this.options.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM owner_hatching_trait_staging WHERE batch_id=?', batchId).toArray()[0].count;
    return ownerHatchingProgress(deployment.deploymentId, row, this.options.store.catalogUpdate.ownerHatching.reader,
      this.activation(batchId), staged);
  }

  async run(deployment: EthereumRevealDeployment, request: OwnerHatchingMaintenanceRequest): Promise<OwnerHatchingMaintenanceResult> {
    if (request.deploymentId !== deployment.deploymentId || this.mixed && this.mixed.batchId !== request.batchId) {
      throw new Error('Owner hatching deployment or batch does not match.');
    }
    if (request.action === 'begin') {
      if (this.mixed && Object.keys(request).some(key => !['action', 'batchId', 'expectedRevision', 'deploymentId'].includes(key))) {
        throw new Error('Mixed allocation derives its rewards from the frozen release.');
      }
      await this.begin(deployment, this.mixed ? { ...request, mixedReleaseSha256: this.mixedReleaseSha256,
        sourceSha256: this.mixed.definition.sourceSha256, readyCount: this.mixed.definition.groups.reduce((n, group) => n + group.ownerCount, 0),
      } : request);
    }
    let row = this.read(request.batchId);
    const saved = this.originalRequest(row, request);
    if (request.action === 'status') return this.status(deployment, request.batchId);
    if (row.phase !== 'cancelled' && (row.phase !== 'complete' || request.action === 'verify')) {
      await this.options.requireCurrent();
      row = this.read(request.batchId);
      if (['scanning', 'staging', 'prepared', 'activating'].includes(row.phase)) this.requirePreparationCatalog(row);
    }
    if (row.phase === 'cancelled') throw new Error('This mixed allocation was cancelled.');
    if (request.action === 'verify') await this.verify(deployment, row, saved);
    if (request.action === 'refresh-scan') await this.refreshScan(deployment, row, saved.readyCount!);
    if (request.action === 'refresh-activation') await this.refreshActivation(deployment, row);
    if (request.action === 'complete' && row.phase === 'complete') this.enrichmentPending(this.status(deployment, request.batchId));
    if (row.phase !== 'complete') {
      if (request.action === 'scan') await this.scan(deployment, row);
      if (request.action === 'stage') await this.stage(row, saved);
      if (request.action === 'activate') await this.activate(deployment, row, saved);
      if (request.action === 'complete') {
        row = this.read(request.batchId);
        const status = this.status(deployment, request.batchId);
        if (row.verification_passes >= 2 && this.restartMixedVerification(status, row.verification_hatched ?? null)) {
          await this.options.wake();
          return this.status(deployment, request.batchId);
        }
        if (this.mixed && row.verification_passes >= 2 && row.verification_cursor !== null) return status;
        if (row.verification_passes < 2 || row.verification_cursor !== null || row.observation_until_ms === null ||
          Date.now() < row.observation_until_ms || status.published !== status.readyCount || status.conflicts || status.retrying ||
          status.pendingEnrichment || status.failedEnrichment) {
          throw new Error('Owner hatching requires complete publication, trait enrichment and two verification passes separated by a scheduler interval.');
        }
        if (this.mixed) {
          const updates = this.options.store.catalogUpdate;
          updates.mixed.finalize(request.batchId);
          if (updates.prune(request.batchId).remaining) return status;
        }
        this.options.transaction(() => {
          this.options.sql.exec('DELETE FROM owner_hatching_candidates WHERE batch_id=?', request.batchId);
          this.options.sql.exec('DELETE FROM owner_hatching_trait_staging WHERE batch_id=?', request.batchId);
          this.options.sql.exec('DELETE FROM owner_hatching_activation_candidates WHERE batch_id=?', request.batchId);
          this.options.sql.exec("UPDATE owner_hatching_preparations SET phase='complete' WHERE batch_id=?", request.batchId);
        });
      }
    }
    return this.status(deployment, request.batchId);
  }

  private originalRequest(row: Preparation, identity: OperationIdentity): SavedRequest {
    const saved: SavedRequest = JSON.parse(row.request_json);
    if (saved.deploymentId !== identity.deploymentId || saved.expectedRevision !== identity.expectedRevision ||
      saved.mixedReleaseSha256 !== this.mixedReleaseSha256) {
      throw new Error('Resume owner hatching with its original operation identity.');
    }
    return saved;
  }

  async cancelMixed(deployment: EthereumRevealDeployment, identity: OperationIdentity) {
    if (!this.mixed || identity.batchId !== this.mixed.batchId || identity.deploymentId !== deployment.deploymentId) {
      throw new Error('Mixed cancellation requires its original release and deployment.');
    }
    await this.options.requireCurrent();
    const batchId = identity.batchId;
    const updates = this.options.store.catalogUpdate;
    return this.options.transaction(() => {
      const row = this.read(batchId);
      this.originalRequest(row, identity);
      if (row.phase !== 'cancelled') {
        updates.mixed.cancel(batchId);
        this.options.sql.exec("UPDATE owner_hatching_preparations SET phase='cancelled' WHERE batch_id=?", batchId);
      }
      let remaining = updates.prune(batchId).remaining;
      for (const table of ['owner_hatching_candidates', 'owner_hatching_activation_candidates']) {
        this.options.sql.exec(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE batch_id=? LIMIT 256)`, batchId);
        remaining += this.options.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE batch_id=?`, batchId).toArray()[0].n;
      }
      if (!remaining) this.options.sql.exec('DELETE FROM owner_hatching_activation WHERE batch_id=?', batchId);
      return { cancelled: true, remaining };
    });
  }

  private async begin(deployment: EthereumRevealDeployment, request: SavedRequest): Promise<void> {
    const serialized = serializeBegin(request);
    const alreadyPrepared = () => {
      const previous = this.options.sql.exec<Pick<Preparation, 'request_json'>>(
        'SELECT request_json FROM owner_hatching_preparations WHERE batch_id=?', request.batchId).toArray()[0];
      if (!previous) return false;
      const frozen = JSON.parse(previous.request_json) as SavedRequest;
      if (serializeBegin(frozen) !== serializeBegin({ ...request, catalogSha256: frozen.catalogSha256 }) ||
        request.catalogSha256 !== frozen.catalogSha256 && request.catalogSha256 !== ownerHatchingCatalogSha256) {
        throw new Error('Owner hatching batch inputs changed.');
      }
      return true;
    };
    if (alreadyPrepared()) return;
    const updates = this.options.store.catalogUpdate;
    const predecessor = this.mixed?.definition.predecessor ?? this.ownerSupplementPredecessor(request);
    const effective = updates.reader.effectiveCatalog();
    if (!effective?.generation || predecessor.catalogVersion !== effective.catalogVersion ||
      predecessor.manifestSha256 !== effective.manifestSha256) throw new Error('Owner hatching requires its catalog predecessor.');
    await this.options.requireCurrent(request.expectedRevision);
    const captured = await this.scanSnapshot(deployment);
    await this.options.requireCurrent(request.expectedRevision);
    this.options.transaction(() => {
      if (alreadyPrepared()) return;
      if (updates.reader.effectiveCatalog()?.catalogRevision !== effective.catalogRevision) throw new Error('Catalog changed during owner hatching preparation.');
      if (this.mixed) updates.mixed.begin(this.mixed);
      this.options.sql.exec(`INSERT INTO owner_hatching_preparations(batch_id,request_json,block_number,block_hash,total,catalog_revision)
        VALUES(?,?,?,?,?,?)`, request.batchId, serialized, captured.blockNumber, captured.blockHash, captured.total, effective.catalogRevision);
    });
  }

  private ownerSupplementPredecessor(request: OwnerHatchingMaintenanceRequest) {
    const updates = this.options.store.catalogUpdate;
    const source = getStandaloneOwnerHatchingBatch(request.sourceSha256);
    if (!source || request.catalogSha256 !== ownerHatchingCatalogSha256 ||
      request.grailIds!.some(id => !source.artworks.some(asset => asset.assetId === id) ||
        updates.ownerHatching.reader.reservedGrail({ category: 'animated', assetId: id })) ||
      request.freshEggIds!.some(id => !updates.reader.freshOwnerEggAvailable(id))) {
      throw new Error('Owner hatching catalog or fresh egg inventory does not match.');
    }
    return source.predecessor;
  }

  private async scan(deployment: EthereumRevealDeployment, row: Preparation): Promise<void> {
    if (row.phase !== 'scanning') return;
    const end = Math.min(row.total, row.scanned + 100);
    const ids = Array.from({ length: end - row.scanned }, (_, index) => String(row.scanned + index + 1));
    const infos = ids.length ? await withEthereumReadProvider(this.context(deployment), async context => {
      const result = await ethereumTokenInfos(context, ids, row.block_hash);
      await verifyEthereumBlockSnapshot(context, { blockNumber: row.block_number, blockHash: row.block_hash });
      return result;
    }) : [];
    const minted = infos.filter(info => info.kind === 'artwork').map(info => info.tokenId);
    if (minted.length && !await this.options.recover(minted)) return;
    await this.options.requireCurrent();
    this.options.transaction(() => {
      const current = this.read(row.batch_id);
      if (current.phase !== 'scanning' || current.scanned !== row.scanned || current.block_hash !== row.block_hash) return;
      this.requirePreparationCatalog(current);
      for (const token of this.options.store.catalogUpdate.reader.canonicalMetadata(minted)) {
        if (token.category !== 'egg' || this.options.store.catalogUpdate.ownerHatching.reader.hasProtectedEgg(token.assetId)) continue;
        this.options.sql.exec('INSERT OR IGNORE INTO owner_hatching_candidates(batch_id,token_id) VALUES(?,?)', row.batch_id, token.tokenId);
      }
      this.options.sql.exec(`UPDATE owner_hatching_preparations SET scanned=?,phase=?,candidates=
        (SELECT COUNT(*) FROM owner_hatching_candidates WHERE batch_id=?) WHERE batch_id=?`,
        end, end === row.total ? 'staging' : 'scanning', row.batch_id, row.batch_id);
    });
  }

  private canRefreshScan(row: Preparation, count: number): boolean {
    if (row.phase === 'scanning') return true;
    if (!this.mixed || row.scanned !== row.total) return false;
    if (row.phase === 'staging') return row.candidates < count;
    if (row.phase !== 'activating') return false;
    const unchecked = this.options.sql.exec(`SELECT 1 FROM owner_hatching_candidates c
      LEFT JOIN owner_hatching_activation_candidates a USING(batch_id,token_id)
      WHERE c.batch_id=? AND a.live IS NULL LIMIT 1`, row.batch_id).toArray();
    return !unchecked.length && this.selectedCandidates(row.batch_id, count).length < count;
  }

  private async refreshScan(deployment: EthereumRevealDeployment, row: Preparation, readyCount: number): Promise<void> {
    const owner = this.options.store.catalogUpdate.ownerHatching;
    if (!this.canRefreshScan(row, readyCount) || owner.reader.batchStatus(row.batch_id)) throw new Error('Only an unfinished scan or exhausted mixed batch can refresh its snapshot.');
    const captured = await this.scanSnapshot(deployment);
    await this.options.requireCurrent();
    this.options.transaction(() => {
      const current = this.read(row.batch_id);
      if (current.phase !== row.phase || current.scanned !== row.scanned || current.block_hash !== row.block_hash ||
        owner.reader.batchStatus(row.batch_id) || !this.canRefreshScan(current, readyCount)) {
        throw new Error('Scan changed while refreshing its snapshot; inspect before retrying.');
      }
      this.requirePreparationCatalog(current);
      this.options.sql.exec('DELETE FROM owner_hatching_candidates WHERE batch_id=?', row.batch_id);
      this.options.sql.exec(`UPDATE owner_hatching_preparations SET phase='scanning',block_number=?,block_hash=?,total=?,scanned=0,candidates=0 WHERE batch_id=?`,
        captured.blockNumber, captured.blockHash, captured.total, row.batch_id);
    });
  }

  private async stage(row: Preparation, request: OwnerHatchingMaintenanceRequest): Promise<void> {
    if (row.phase !== 'staging') return;
    if (row.candidates < request.readyCount!) throw new Error('The frozen snapshot has too few eligible eggs; no allocation was made.');
    if (this.mixed) return this.stageMixed(row, this.mixed);
    const staged = new Set(this.options.sql.exec<{ asset_id: number }>(
      'SELECT asset_id FROM owner_hatching_trait_staging WHERE batch_id=?', row.batch_id).toArray().map(value => value.asset_id));
    const remaining = request.grailIds!.filter(id => !staged.has(id)).slice(0, 8);
    const payloads = await Promise.all(remaining.map(async assetId => ({ assetId, attributesJson: await fetchRevealAttributePayload(
      'animated', assetId, AbortSignal.timeout(20_000), fetch, this.options.store.catalogUpdate.reader.activeCatalog(), true) })));
    await this.options.requireCurrent();
    this.options.transaction(() => {
      const current = this.read(row.batch_id);
      if (current.phase !== 'staging') return;
      this.requirePreparationCatalog(current);
      for (const payload of payloads) this.options.sql.exec(
        'INSERT OR IGNORE INTO owner_hatching_trait_staging(batch_id,asset_id,attributes_json) VALUES(?,?,?)', row.batch_id, payload.assetId, payload.attributesJson);
      if (staged.size + payloads.length === request.grailIds!.length) {
        this.options.sql.exec("UPDATE owner_hatching_preparations SET phase='prepared' WHERE batch_id=?", row.batch_id);
      }
    });
  }

  private async stageMixed(row: Preparation, release: MixedAllocationInput): Promise<void> {
    const mixed = this.options.store.catalogUpdate.mixed;
    const pending = mixed.pendingTraits(row.batch_id);
    const traits = await Promise.all(pending.map(async asset => {
      const attributesJson = await fetchRevealAttributePayload(asset.category, asset.assetId, AbortSignal.timeout(20_000), fetch,
        release.targetCatalog, asset.category === 'animated');
      return { ...asset, attributesJson, sha256: createHash('sha256').update(attributesJson).digest('hex') };
    }));
    await this.options.requireCurrent();
    this.options.transaction(() => {
      if (this.read(row.batch_id).phase !== 'staging') return;
      this.requirePreparationCatalog(row);
      if (traits.length) {
        mixed.stageTraits(row.batch_id, traits);
        return;
      }
      if (mixed.stageInventory(row.batch_id).generationSeeded < REVEAL_ARTWORK_COUNT) return;
      mixed.seal(row.batch_id);
      this.options.sql.exec("UPDATE owner_hatching_preparations SET phase='prepared' WHERE batch_id=?", row.batch_id);
    });
  }

  private activation(batchId: string): Activation | undefined {
    return this.options.sql.exec<Activation>('SELECT * FROM owner_hatching_activation WHERE batch_id=?', batchId).toArray()[0];
  }

  private selectedCandidates(batchId: string, count: number): string[] {
    const rows = this.options.sql.exec<ActivationCandidate>(`SELECT position,token_id FROM owner_hatching_activation_candidates
      JOIN owner_hatching_candidates USING(batch_id,token_id) WHERE batch_id=? AND live=1 ORDER BY position`, batchId).toArray();
    const selected: string[] = [];
    for (const row of rows) {
      if (this.options.store.catalogUpdate.ownerHatching.eligibleCandidate(row.token_id)) selected.push(row.token_id);
      if (selected.length === count) break;
    }
    return selected;
  }

  private requirePreparationCatalog(row: Preparation): void {
    if (row.catalog_revision !== this.options.store.catalogUpdate.reader.effectiveCatalog()?.catalogRevision) {
      throw new Error('The catalog changed while preparing owner hatching.');
    }
  }

  private setActivationSnapshot(batchId: string, snapshot: { blockNumber: number; blockHash: string }): void {
    this.options.sql.exec(`INSERT INTO owner_hatching_activation(batch_id,block_number,block_hash) VALUES(?,?,?)
      ON CONFLICT(batch_id) DO UPDATE SET block_number=excluded.block_number,block_hash=excluded.block_hash,checked=0,selected=0`,
      batchId, snapshot.blockNumber, snapshot.blockHash);
    this.options.sql.exec('UPDATE owner_hatching_activation_candidates SET live=NULL WHERE batch_id=?', batchId);
  }

  private async refreshActivation(deployment: EthereumRevealDeployment, row: Preparation): Promise<void> {
    const owner = this.options.store.catalogUpdate.ownerHatching;
    if (row.phase !== 'activating' || owner.reader.batchStatus(row.batch_id)) {
      throw new Error('Only an unallocated activation can refresh its snapshot.');
    }
    const previous = this.activation(row.batch_id)!;
    const snapshot = await withEthereumReadProvider(this.context(deployment), async context => {
      const current = await ethereumBlockSnapshot(context);
      await verifyEthereumBlockSnapshot(context, current);
      return current;
    });
    await this.options.requireCurrent();
    this.options.transaction(() => {
      const current = this.read(row.batch_id);
      const activation = this.activation(row.batch_id);
      if (current.phase !== 'activating' || owner.reader.batchStatus(row.batch_id) ||
        activation?.checked !== previous.checked || activation.block_hash !== previous.block_hash) {
        throw new Error('Activation changed while refreshing its snapshot; inspect before retrying.');
      }
      this.requirePreparationCatalog(current);
      this.setActivationSnapshot(row.batch_id, snapshot);
    });
  }

  private activationPage(row: Preparation, count: number) {
    return this.options.transaction(() => {
      const current = this.read(row.batch_id);
      if (current.phase !== 'activating') return null;
      this.requirePreparationCatalog(current);
      const activation = this.activation(row.batch_id)!;
      const selected = this.selectedCandidates(row.batch_id, count);
      let page = this.options.sql.exec<ActivationCandidate>(`SELECT position,token_id FROM owner_hatching_activation_candidates
        WHERE batch_id=? AND live IS NULL ORDER BY position LIMIT ?`, row.batch_id, ACTIVATION_PAGE_SIZE).toArray();
      if (!page.length && selected.length < count) {
        const candidates = this.options.sql.exec<{ token_id: string }>(`SELECT c.token_id FROM owner_hatching_candidates c WHERE c.batch_id=?
          AND NOT EXISTS(SELECT 1 FROM owner_hatching_activation_candidates a WHERE a.batch_id=c.batch_id AND a.token_id=c.token_id)
          ORDER BY CAST(c.token_id AS INTEGER)`, row.batch_id).toArray().map(value => value.token_id);
        if (!candidates.length) throw new Error(this.mixed
          ? 'Not enough eligible minted eggs remain. Run refresh-scan --write with the original journal when eligibility increases.'
          : 'Not enough eligible minted eggs remain in the activation snapshot.');
        const size = Math.min(ACTIVATION_PAGE_SIZE, count - selected.length, candidates.length);
        page = Array.from({ length: size }, (_, index) => {
          const pick = (this.options.randomInteger ?? revealRandomInteger)(candidates.length);
          const tokenId = candidates[pick];
          candidates[pick] = candidates.at(-1)!;
          candidates.pop();
          const position = activation.checked + index + 1;
          this.options.sql.exec('INSERT INTO owner_hatching_activation_candidates(batch_id,position,token_id) VALUES(?,?,?)',
            row.batch_id, position, tokenId);
          return { position, token_id: tokenId };
        });
      }
      this.options.sql.exec('UPDATE owner_hatching_activation SET selected=? WHERE batch_id=?', selected.length, row.batch_id);
      return { activation, selected, page };
    });
  }

  private async activate(deployment: EthereumRevealDeployment, row: Preparation, request: OwnerHatchingMaintenanceRequest): Promise<void> {
    const owner = this.options.store.catalogUpdate.ownerHatching;
    if (owner.reader.batchStatus(row.batch_id)) return;
    if (row.phase === 'prepared') {
      const snapshot = await withEthereumReadProvider(this.context(deployment), async context => {
        const value = await ethereumBlockSnapshot(context);
        await verifyEthereumBlockSnapshot(context, value);
        return value;
      });
      await this.options.requireCurrent();
      this.options.transaction(() => {
        const current = this.read(row.batch_id);
        if (current.phase !== 'prepared' || current.block_hash !== row.block_hash) return;
        this.requirePreparationCatalog(current);
        this.setActivationSnapshot(row.batch_id, snapshot);
        this.options.sql.exec("UPDATE owner_hatching_preparations SET phase='activating' WHERE batch_id=?", row.batch_id);
      });
      return;
    } else if (row.phase !== 'activating') throw new Error('Owner hatching preparation is incomplete.');
    const work = this.activationPage(row, request.readyCount!);
    if (!work) return;
    const { activation, page } = work;
    const snapshot = { blockNumber: activation.block_number, blockHash: activation.block_hash };
    const pageIds = page.map(candidate => candidate.token_id);
    const finalCohort = this.mixed && work.selected.length + pageIds.length >= request.readyCount!
      ? [...work.selected, ...pageIds] : null;
    const { live, cutoff } = await withEthereumReadProvider(this.context(deployment), async context => {
      const cutoff = finalCohort ? await ethereumBlockSnapshot(context) : snapshot;
      if (cutoff.blockNumber < snapshot.blockNumber ||
        cutoff.blockNumber === snapshot.blockNumber && cutoff.blockHash !== snapshot.blockHash) {
        throw new Error('Ethereum changed while reading your items. Try again.');
      }
      const infos = await ethereumTokenInfos(context, finalCohort ?? pageIds, cutoff.blockHash);
      if (cutoff.blockHash !== snapshot.blockHash) await verifyEthereumBlockSnapshot(context, snapshot);
      await verifyEthereumBlockSnapshot(context, cutoff);
      return { live: new Set(infos.filter(info => info.kind === 'artwork').map(info => info.tokenId)), cutoff };
    });
    await this.options.requireCurrent();
    const activated = this.options.transaction(() => {
      const current = this.read(row.batch_id);
      const saved = this.activation(row.batch_id);
      if (current.phase !== 'activating' || saved?.checked !== activation.checked || saved.block_hash !== activation.block_hash) return false;
      this.requirePreparationCatalog(current);
      for (const candidate of page) this.options.sql.exec(`UPDATE owner_hatching_activation_candidates SET live=?
        WHERE batch_id=? AND position=? AND token_id=? AND live IS NULL`,
        Number(live.has(candidate.token_id)), row.batch_id, candidate.position, candidate.token_id);
      if (finalCohort) {
        const missing = finalCohort.filter(id => !live.has(id));
        if (missing.length) this.options.sql.exec(`UPDATE owner_hatching_activation_candidates SET live=0
          WHERE batch_id=? AND token_id IN (SELECT value FROM json_each(?))`, row.batch_id, JSON.stringify(missing));
      }
      const selected = this.selectedCandidates(row.batch_id, request.readyCount!);
      this.options.sql.exec('UPDATE owner_hatching_activation SET checked=?,selected=?,block_number=?,block_hash=? WHERE batch_id=?',
        activation.checked + page.length, selected.length, cutoff.blockNumber, cutoff.blockHash, row.batch_id);
      if (selected.length < request.readyCount!) return false;
      if (this.mixed) {
        if (!finalCohort || !selected.every(id => live.has(id))) return false;
        this.options.store.catalogUpdate.mixed.activate(row.batch_id, selected);
      } else {
        const grails = this.options.sql.exec<{ asset_id: number; attributes_json: string }>(
          'SELECT asset_id,attributes_json FROM owner_hatching_trait_staging WHERE batch_id=? ORDER BY asset_id', row.batch_id).toArray();
        owner.prepare({ batchId: row.batch_id, sourceSha256: request.sourceSha256!, candidateTokenIds: selected,
          readyCount: request.readyCount!, grails: grails.map(value => ({ category: 'animated', assetId: value.asset_id, attributesJson: value.attributes_json })),
          freshEggIds: request.freshEggIds! });
      }
      this.options.sql.exec("UPDATE owner_hatching_preparations SET phase='publishing' WHERE batch_id=?", row.batch_id);
      return true;
    });
    if (activated) await this.options.wake();
  }

  private restartMixedVerification(status: OwnerHatchingMaintenanceResult, expectedHatches: number | null = status.hatched): boolean {
    if (!this.mixed) return false;
    if (status.conflicts || status.failedEnrichment) throw new Error('Mixed publication or enrichment conflicts require inspection.');
    if (!status.retrying && !status.pendingEnrichment) {
      if (status.published !== status.readyCount) throw new Error('Mixed owner publication count is inconsistent.');
      if (status.hatched === expectedHatches) return false;
    }
    this.options.sql.exec('UPDATE owner_hatching_preparations SET verification_cursor=? WHERE batch_id=?', '0', status.batchId);
    return true;
  }

  private async verify(deployment: EthereumRevealDeployment, row: Preparation, request: SavedRequest): Promise<void> {
    const status = this.status(deployment, row.batch_id);
    if (!this.options.store.catalogUpdate.ownerHatching.reader.batchStatus(row.batch_id)) throw new Error('Owner hatching has not activated.');
    if (this.restartMixedVerification(status) || this.enrichmentPending(status)) { await this.options.wake(); return; }
    if (status.published !== request.readyCount || status.retrying || status.conflicts) {
      if (row.phase === 'complete') throw new Error('Owner hatching publication verification failed.');
      await this.options.wake();
      return;
    }
    if (row.phase !== 'complete' && row.verification_passes >= 1 && row.observation_until_ms !== null && Date.now() < row.observation_until_ms) return;
    const cursor = this.mixed && row.verification_hatched !== status.hatched ? 0 : Number(row.verification_cursor ?? 0);
    const tokens = this.options.sql.exec<{ token_id: string }>(`SELECT token_id FROM owner_hatching_tokens WHERE batch_id=?
      AND CAST(token_id AS INTEGER)>? ORDER BY CAST(token_id AS INTEGER) LIMIT 16`, row.batch_id, cursor).toArray();
    const verified = await Promise.all(tokens.map(async ({ token_id: tokenId }) => {
      const canonical = this.options.store.catalogUpdate.ownerHatching.reader.canonical(tokenId)!;
      const object = await this.options.env.ETHEREUM_REVEAL_METADATA.get(new URL(ethereumTokenMetadataUri(deployment, tokenId)).pathname.slice(1));
      let error: string | undefined;
      if (!object || object.size > MAX_REVEAL_METADATA_BYTES) error = 'Owner hatching metadata is missing or oversized.';
      else if (object.httpMetadata?.cacheControl !== 'no-store' || !object.httpMetadata.contentType?.startsWith('application/json') ||
        createHash('sha256').update(await object.text()).digest('hex') !== canonical.targetSha256) error = 'Owner hatching metadata verification did not match.';
      return { tokenId, metadataRevision: canonical.metadataRevision, error };
    }));
    await this.options.requireCurrent();
    let superseded = false;
    for (const value of verified) {
      if (this.options.store.catalogUpdate.ownerHatching.reader.canonical(value.tokenId)?.metadataRevision !== value.metadataRevision) superseded = true;
      else if (value.error) throw new Error(value.error);
    }
    const latest = this.status(deployment, row.batch_id);
    if (this.restartMixedVerification(latest, status.hatched) || this.enrichmentPending(latest)) { await this.options.wake(); return; }
    if (superseded) {
      if (!this.mixed && row.phase === 'complete') throw new Error('Owner hatching metadata changed during verification; retry the page.');
      return;
    }
    if (this.mixed && tokens.length < 16) this.options.store.catalogUpdate.mixed.verify(row.batch_id);
    const pools = this.options.store.catalogUpdate.reader.pools();
    const assigned = this.options.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM assignments').toArray()[0].count;
    const counts = this.options.sql.exec<{ tokens: number; targets: number; grails: number; fresh: number; used_fresh: number;
      ordinary_hatched: number; retired: number; claimed: number; hatched: number }>(`SELECT
      COUNT(*) AS tokens,COALESCE(SUM(grail_asset_id IS NOT NULL),0) AS targets,
      COALESCE(SUM(status='hatched'),0) AS hatched,
      COALESCE(SUM(status='hatched' AND grail_asset_id IS NULL),0) AS ordinary_hatched,
      (SELECT COUNT(*) FROM owner_hatching_grails WHERE batch_id=?) AS grails,
      (SELECT COUNT(*) FROM owner_hatching_fresh_eggs WHERE batch_id=?) AS fresh,
      (SELECT COUNT(*) FROM owner_hatching_fresh_eggs WHERE batch_id=? AND token_id IS NOT NULL) AS used_fresh,
      (SELECT COUNT(*) FROM owner_hatching_retired_eggs r JOIN owner_hatching_tokens t ON t.token_id=r.token_id WHERE t.batch_id=?) AS retired,
      (SELECT COUNT(*) FROM owner_hatching_artwork_claims c JOIN owner_hatching_tokens t ON t.token_id=c.token_id WHERE t.batch_id=?) AS claimed
      FROM owner_hatching_tokens WHERE batch_id=?`, ...Array<string>(6).fill(row.batch_id)).toArray()[0];
    if (counts.tokens !== request.readyCount || counts.targets !== targetCount(request) || counts.grails !== counts.targets ||
      counts.fresh !== (request.freshEggIds?.length ?? 0) || counts.used_fresh !== counts.ordinary_hatched ||
      counts.retired !== counts.hatched || counts.claimed !== counts.hatched) throw new Error('Owner hatching private allocation verification failed.');
    if (pools.reduce((sum, pool) => sum + pool.available, 0) + assigned !== 111_111 ||
      pools.reduce((sum, pool) => sum + pool.total, 0) !== 111_111) throw new Error('Owner hatching allocation conservation failed.');
    this.options.transaction(() => {
      const current = this.read(row.batch_id);
      if (current.verification_cursor !== row.verification_cursor || current.verification_passes !== row.verification_passes ||
        current.phase !== row.phase || current.verification_hatched !== row.verification_hatched) return;
      if (this.mixed) this.options.sql.exec('UPDATE owner_hatching_preparations SET verification_hatched=? WHERE batch_id=?', status.hatched, row.batch_id);
      if (tokens.length === 16) {
        this.options.sql.exec('UPDATE owner_hatching_preparations SET verification_cursor=? WHERE batch_id=?', tokens.at(-1)!.token_id, row.batch_id);
      } else if (row.phase === 'complete') {
        this.options.sql.exec(`UPDATE owner_hatching_preparations SET verification_cursor=NULL,verification_passes=verification_passes+1
          WHERE batch_id=?`, row.batch_id);
      } else {
        this.options.sql.exec(`UPDATE owner_hatching_preparations SET verification_cursor=NULL,verification_passes=verification_passes+1,
          phase='observing',observation_until_ms=COALESCE(observation_until_ms,?) WHERE batch_id=?`, Date.now() + 300_000, row.batch_id);
      }
    });
  }

  private enrichmentPending(status: OwnerHatchingMaintenanceResult): boolean {
    if (status.failedEnrichment) {
      throw new Error(`Owner hatching has ${status.failedEnrichment} failed trait enrichments; restore the trait source before verifying.`);
    }
    if (!status.pendingEnrichment) return false;
    if (status.phase === 'complete' && !this.mixed) {
      throw new Error(`Owner hatching trait enrichment is incomplete (${status.pendingEnrichment} pending).`);
    }
    return true;
  }
}
