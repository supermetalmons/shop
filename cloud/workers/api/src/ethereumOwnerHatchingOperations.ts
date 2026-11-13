import { createHash } from 'node:crypto';
import { encodeCall } from '../../../../shared/ethereum/abi.js';
import { ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.js';
import { ownerHatchingCatalogSha256 } from '../../../../shared/ethereum/ownerHatchingCatalog.js';
import supplement from '../../../../shared/ethereum/ownerHatchingCatalog.json';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.js';
import type { OwnerHatchingMaintenanceRequest, OwnerHatchingMaintenanceResult } from '../../../../shared/ethereum/ownerHatchingMaintenance.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import type { EthereumRevealStore, RevealSql } from './ethereumRevealStore.js';
import { ethereumBlockSnapshot, ethereumCallBatch, verifyEthereumBlockSnapshot, withEthereumReadProvider,
  type EthereumCollectionReadContext } from './ethereumRuntime.js';
import { ethereumCollectionStatsFromData, ethereumTokenInfos } from './ethereumRead.js';
import { fetchRevealAttributePayload, MAX_REVEAL_METADATA_BYTES } from './ethereumRevealAttributes.js';
import { revealRandomInteger } from './ethereumRevealCatalog.js';

type Preparation = {
  batch_id: string; request_json: string; block_number: number; block_hash: string; total: number; scanned: number;
  catalog_revision: number; phase: OwnerHatchingMaintenanceResult['phase']; candidates: number;
  verification_cursor: string | null; verification_passes: number; observation_until_ms: number | null;
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

export class EthereumOwnerHatchingOperations {
  constructor(private readonly options: Options) {
    options.transaction(() => {
      options.sql.exec(`CREATE TABLE IF NOT EXISTS owner_hatching_preparations (
        batch_id TEXT PRIMARY KEY,request_json TEXT NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,
        total INTEGER NOT NULL,scanned INTEGER NOT NULL DEFAULT 0,catalog_revision INTEGER NOT NULL,
        phase TEXT NOT NULL DEFAULT 'scanning',candidates INTEGER NOT NULL DEFAULT 0,
        verification_cursor TEXT,verification_passes INTEGER NOT NULL DEFAULT 0,observation_until_ms INTEGER)`);
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
    const request = JSON.parse(row.request_json) as OwnerHatchingMaintenanceRequest;
    const prepared = this.options.store.catalogUpdate.ownerHatching.batchStatus(batchId);
    const activation = this.activation(batchId);
    const staged = row.phase === 'complete' ? request.grailIds!.length : this.options.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM owner_hatching_trait_staging WHERE batch_id=?', batchId).toArray()[0].count;
    return { deploymentId: deployment.deploymentId, batchId, phase: row.phase, readyCount: request.readyCount!,
      grailCount: request.grailIds!.length, candidates: row.candidates, scanned: row.scanned, total: row.total, staged,
      activationChecked: activation?.checked ?? 0, activationSelected: prepared?.readyCount ?? activation?.selected ?? 0,
      published: prepared?.published ?? 0, hatched: prepared?.hatched ?? 0,
      retrying: prepared?.pendingPublication ?? 0, conflicts: prepared?.conflicts ?? 0,
      pendingEnrichment: prepared?.pendingEnrichment ?? 0, failedEnrichment: prepared?.failedEnrichment ?? 0,
      retryAfterMs: row.phase === 'complete' ? 0 : 1_000, verificationCursor: row.verification_cursor,
      observationUntilMs: row.observation_until_ms, complete: row.phase === 'complete' };
  }

  async run(deployment: EthereumRevealDeployment, request: OwnerHatchingMaintenanceRequest): Promise<OwnerHatchingMaintenanceResult> {
    if (request.action === 'begin') await this.begin(deployment, request);
    let row = this.read(request.batchId);
    const saved = JSON.parse(row.request_json) as OwnerHatchingMaintenanceRequest;
    if (saved.deploymentId !== request.deploymentId || saved.expectedRevision !== request.expectedRevision) {
      throw new Error('Resume owner hatching with its original operation identity.');
    }
    if (request.action !== 'status' && (row.phase !== 'complete' || request.action === 'verify')) {
      await this.options.requireCurrent();
      if (['scanning', 'staging', 'prepared', 'activating'].includes(row.phase)) this.requirePreparationCatalog(row);
    }
    if (request.action === 'verify') await this.verify(deployment, row, saved);
    if (request.action === 'refresh-scan') await this.refreshScan(deployment, row);
    if (request.action === 'refresh-activation') await this.refreshActivation(deployment, row);
    if (request.action === 'complete' && row.phase === 'complete') this.enrichmentPending(this.status(deployment, request.batchId));
    if (row.phase !== 'complete') {
      if (request.action === 'scan') await this.scan(deployment, row);
      if (request.action === 'stage') await this.stage(row, saved);
      if (request.action === 'activate') await this.activate(deployment, row, saved);
      if (request.action === 'complete') {
        row = this.read(request.batchId);
        const status = this.status(deployment, request.batchId);
        if (row.verification_passes < 2 || row.verification_cursor !== null || row.observation_until_ms === null ||
          Date.now() < row.observation_until_ms || status.published !== status.readyCount || status.conflicts || status.retrying ||
          status.pendingEnrichment || status.failedEnrichment) {
          throw new Error('Owner hatching requires complete publication, trait enrichment and two verification passes separated by a scheduler interval.');
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

  private async begin(deployment: EthereumRevealDeployment, request: OwnerHatchingMaintenanceRequest): Promise<void> {
    const serialized = JSON.stringify(request);
    const previous = this.options.sql.exec<Preparation>('SELECT * FROM owner_hatching_preparations WHERE batch_id=?', request.batchId).toArray()[0];
    if (previous) {
      const frozen = JSON.parse(previous.request_json) as OwnerHatchingMaintenanceRequest;
      if (previous.request_json !== JSON.stringify({ ...request, catalogSha256: frozen.catalogSha256 }) ||
        request.catalogSha256 !== frozen.catalogSha256 && request.catalogSha256 !== ownerHatchingCatalogSha256) {
        throw new Error('Owner hatching batch inputs changed.');
      }
      return;
    }
    const source = supplement.batches.find(batch => batch.source.sha256 === request.sourceSha256);
    if (!source || request.catalogSha256 !== ownerHatchingCatalogSha256 ||
      request.grailIds!.some(id => !source.artworks.some(asset => asset.assetId === id)) ||
      request.grailIds!.some(id => this.options.store.catalogUpdate.ownerHatching.reservedGrail({ category: 'animated', assetId: id })) ||
      request.freshEggIds!.some(id => !this.options.store.catalogUpdate.freshOwnerEggAvailable(id))) {
      throw new Error('Owner hatching catalog or fresh egg inventory does not match.');
    }
    const effective = this.options.store.catalogUpdate.effectiveCatalog();
    if (!effective?.generation || source.predecessor.catalogVersion !== effective.catalogVersion ||
      source.predecessor.manifestSha256 !== effective.manifestSha256) throw new Error('Owner hatching requires its catalog predecessor.');
    await this.options.requireCurrent(request.expectedRevision);
    const captured = await this.scanSnapshot(deployment);
    await this.options.requireCurrent(request.expectedRevision);
    this.options.sql.exec(`INSERT INTO owner_hatching_preparations(batch_id,request_json,block_number,block_hash,total,catalog_revision)
      VALUES(?,?,?,?,?,?)`, request.batchId, serialized, captured.blockNumber, captured.blockHash, captured.total, effective.catalogRevision);
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
      for (const token of this.options.store.catalogUpdate.canonicalMetadata(minted)) {
        if (token.category !== 'egg' || this.options.store.catalogUpdate.ownerHatching.hasProtectedEgg(token.assetId)) continue;
        this.options.sql.exec('INSERT OR IGNORE INTO owner_hatching_candidates(batch_id,token_id) VALUES(?,?)', row.batch_id, token.tokenId);
      }
      this.options.sql.exec(`UPDATE owner_hatching_preparations SET scanned=?,phase=?,candidates=
        (SELECT COUNT(*) FROM owner_hatching_candidates WHERE batch_id=?) WHERE batch_id=?`,
        end, end === row.total ? 'staging' : 'scanning', row.batch_id, row.batch_id);
    });
  }

  private async refreshScan(deployment: EthereumRevealDeployment, row: Preparation): Promise<void> {
    const owner = this.options.store.catalogUpdate.ownerHatching;
    if (row.phase !== 'scanning' || owner.batchStatus(row.batch_id)) throw new Error('Only an unfinished scan can refresh its snapshot.');
    const captured = await this.scanSnapshot(deployment);
    await this.options.requireCurrent();
    this.options.transaction(() => {
      const current = this.read(row.batch_id);
      if (current.phase !== 'scanning' || current.scanned !== row.scanned || current.block_hash !== row.block_hash || owner.batchStatus(row.batch_id)) {
        throw new Error('Scan changed while refreshing its snapshot; inspect before retrying.');
      }
      this.requirePreparationCatalog(current);
      this.options.sql.exec('DELETE FROM owner_hatching_candidates WHERE batch_id=?', row.batch_id);
      this.options.sql.exec(`UPDATE owner_hatching_preparations SET block_number=?,block_hash=?,total=?,scanned=0,candidates=0 WHERE batch_id=?`,
        captured.blockNumber, captured.blockHash, captured.total, row.batch_id);
    });
  }

  private async stage(row: Preparation, request: OwnerHatchingMaintenanceRequest): Promise<void> {
    if (row.phase !== 'staging') return;
    if (row.candidates < request.readyCount!) throw new Error('The frozen snapshot has too few eligible eggs; no allocation was made.');
    const staged = new Set(this.options.sql.exec<{ asset_id: number }>(
      'SELECT asset_id FROM owner_hatching_trait_staging WHERE batch_id=?', row.batch_id).toArray().map(value => value.asset_id));
    const remaining = request.grailIds!.filter(id => !staged.has(id)).slice(0, 8);
    const payloads = await Promise.all(remaining.map(async assetId => ({ assetId, attributesJson: await fetchRevealAttributePayload(
      'animated', assetId, AbortSignal.timeout(20_000), fetch, this.options.store.catalogUpdate.activeCatalog(), true) })));
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

  private activation(batchId: string): Activation | undefined {
    return this.options.sql.exec<Activation>('SELECT * FROM owner_hatching_activation WHERE batch_id=?', batchId).toArray()[0];
  }

  private selectedCandidates(batchId: string, count: number): string[] {
    const rows = this.options.sql.exec<ActivationCandidate>(`SELECT position,token_id FROM owner_hatching_activation_candidates
      WHERE batch_id=? AND live=1 ORDER BY position`, batchId).toArray();
    const selected: string[] = [];
    for (const row of rows) {
      if (this.options.store.catalogUpdate.ownerHatching.eligibleCandidate(row.token_id)) selected.push(row.token_id);
      if (selected.length === count) break;
    }
    return selected;
  }

  private requirePreparationCatalog(row: Preparation): void {
    if (row.catalog_revision !== this.options.store.catalogUpdate.effectiveCatalog()?.catalogRevision) {
      throw new Error('The catalog changed while preparing owner hatching.');
    }
  }

  private async refreshActivation(deployment: EthereumRevealDeployment, row: Preparation): Promise<void> {
    const owner = this.options.store.catalogUpdate.ownerHatching;
    if (row.phase !== 'activating' || owner.batchStatus(row.batch_id)) {
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
      if (current.phase !== 'activating' || owner.batchStatus(row.batch_id) ||
        activation?.checked !== previous.checked || activation.block_hash !== previous.block_hash) {
        throw new Error('Activation changed while refreshing its snapshot; inspect before retrying.');
      }
      this.requirePreparationCatalog(current);
      this.options.sql.exec('UPDATE owner_hatching_activation_candidates SET live=NULL WHERE batch_id=?', row.batch_id);
      this.options.sql.exec(`UPDATE owner_hatching_activation SET block_number=?,block_hash=?,checked=0,selected=0
        WHERE batch_id=?`, snapshot.blockNumber, snapshot.blockHash, row.batch_id);
    });
  }

  private activationPage(row: Preparation, count: number): { activation: Activation; page: ActivationCandidate[] } | null {
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
        if (!candidates.length) throw new Error('Not enough eligible minted eggs remain in the activation snapshot.');
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
      return { activation, page };
    });
  }

  private async activate(deployment: EthereumRevealDeployment, row: Preparation, request: OwnerHatchingMaintenanceRequest): Promise<void> {
    const owner = this.options.store.catalogUpdate.ownerHatching;
    if (owner.batchStatus(row.batch_id)) return;
    if (row.phase === 'prepared') {
      const snapshot = await withEthereumReadProvider(this.context(deployment), async context => {
        const value = await ethereumBlockSnapshot(context);
        await verifyEthereumBlockSnapshot(context, value);
        return value;
      });
      await this.options.requireCurrent();
      this.options.transaction(() => {
        const current = this.read(row.batch_id);
        if (current.phase !== 'prepared') return;
        this.requirePreparationCatalog(current);
        this.options.sql.exec('INSERT INTO owner_hatching_activation(batch_id,block_number,block_hash) VALUES(?,?,?)',
          row.batch_id, snapshot.blockNumber, snapshot.blockHash);
        this.options.sql.exec("UPDATE owner_hatching_preparations SET phase='activating' WHERE batch_id=?", row.batch_id);
      });
      return;
    } else if (row.phase !== 'activating') throw new Error('Owner hatching preparation is incomplete.');
    const work = this.activationPage(row, request.readyCount!);
    if (!work) return;
    const { activation, page } = work;
    const snapshot = { blockNumber: activation.block_number, blockHash: activation.block_hash };
    const live = new Set(await withEthereumReadProvider(this.context(deployment), async context => {
      const infos = page.length ? await ethereumTokenInfos(context, page.map(value => value.token_id), snapshot.blockHash) : [];
      await verifyEthereumBlockSnapshot(context, snapshot);
      return infos.filter(info => info.kind === 'artwork').map(info => info.tokenId);
    }));
    await this.options.requireCurrent();
    const activated = this.options.transaction(() => {
      const current = this.read(row.batch_id);
      const saved = this.activation(row.batch_id);
      if (current.phase !== 'activating' || saved?.checked !== activation.checked || saved.block_hash !== activation.block_hash) return false;
      this.requirePreparationCatalog(current);
      for (const candidate of page) this.options.sql.exec(`UPDATE owner_hatching_activation_candidates SET live=?
        WHERE batch_id=? AND position=? AND token_id=? AND live IS NULL`,
        Number(live.has(candidate.token_id)), row.batch_id, candidate.position, candidate.token_id);
      const selected = this.selectedCandidates(row.batch_id, request.readyCount!);
      this.options.sql.exec('UPDATE owner_hatching_activation SET checked=?,selected=? WHERE batch_id=?',
        activation.checked + page.length, selected.length, row.batch_id);
      if (selected.length < request.readyCount!) return false;
      const grails = this.options.sql.exec<{ asset_id: number; attributes_json: string }>(
        'SELECT asset_id,attributes_json FROM owner_hatching_trait_staging WHERE batch_id=? ORDER BY asset_id', row.batch_id).toArray();
      owner.prepare({ batchId: row.batch_id, sourceSha256: request.sourceSha256!, candidateTokenIds: selected,
        readyCount: request.readyCount!, grails: grails.map(value => ({ category: 'animated', assetId: value.asset_id, attributesJson: value.attributes_json })),
        freshEggIds: request.freshEggIds! });
      this.options.sql.exec("UPDATE owner_hatching_preparations SET phase='publishing' WHERE batch_id=?", row.batch_id);
      return true;
    });
    if (activated) await this.options.wake();
  }

  private async verify(deployment: EthereumRevealDeployment, row: Preparation, request: OwnerHatchingMaintenanceRequest): Promise<void> {
    const status = this.status(deployment, row.batch_id);
    if (!this.options.store.catalogUpdate.ownerHatching.batchStatus(row.batch_id)) throw new Error('Owner hatching has not activated.');
    if (this.enrichmentPending(status)) { await this.options.wake(); return; }
    if (status.published !== request.readyCount || status.retrying || status.conflicts) {
      if (row.phase === 'complete') throw new Error('Owner hatching publication verification failed.');
      await this.options.wake();
      return;
    }
    if (row.phase !== 'complete' && row.verification_passes >= 1 && row.observation_until_ms !== null && Date.now() < row.observation_until_ms) return;
    const tokens = this.options.sql.exec<{ token_id: string }>(`SELECT token_id FROM owner_hatching_tokens WHERE batch_id=?
      AND CAST(token_id AS INTEGER)>? ORDER BY CAST(token_id AS INTEGER) LIMIT 16`, row.batch_id, Number(row.verification_cursor ?? 0)).toArray();
    const verified = await Promise.all(tokens.map(async ({ token_id: tokenId }) => {
      const canonical = this.options.store.catalogUpdate.ownerHatching.canonical(tokenId)!;
      const object = await this.options.env.ETHEREUM_REVEAL_METADATA.get(new URL(ethereumTokenMetadataUri(deployment, tokenId)).pathname.slice(1));
      if (!object || object.size > MAX_REVEAL_METADATA_BYTES) throw new Error('Owner hatching metadata is missing or oversized.');
      const body = await object.text();
      if (object.httpMetadata?.cacheControl !== 'no-store' || !object.httpMetadata.contentType?.startsWith('application/json') ||
        createHash('sha256').update(body).digest('hex') !== canonical.targetSha256) throw new Error('Owner hatching metadata verification did not match.');
      return { tokenId, metadataRevision: canonical.metadataRevision };
    }));
    await this.options.requireCurrent();
    if (this.enrichmentPending(this.status(deployment, row.batch_id))) { await this.options.wake(); return; }
    if (verified.some(value => this.options.store.catalogUpdate.ownerHatching.canonical(value.tokenId)?.metadataRevision !== value.metadataRevision)) {
      if (row.phase === 'complete') throw new Error('Owner hatching metadata changed during verification; retry the page.');
      return;
    }
    const pools = this.options.store.catalogUpdate.pools();
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
    if (counts.tokens !== request.readyCount || counts.targets !== request.grailIds!.length || counts.grails !== counts.targets ||
      counts.fresh !== request.freshEggIds!.length || counts.used_fresh !== counts.ordinary_hatched ||
      counts.retired !== counts.hatched || counts.claimed !== counts.hatched) throw new Error('Owner hatching private allocation verification failed.');
    if (pools.reduce((sum, pool) => sum + pool.available, 0) + assigned !== 111_111 ||
      pools.reduce((sum, pool) => sum + pool.total, 0) !== 111_111) throw new Error('Owner hatching allocation conservation failed.');
    this.options.transaction(() => {
      const current = this.read(row.batch_id);
      if (current.verification_cursor !== row.verification_cursor || current.verification_passes !== row.verification_passes ||
        current.phase !== row.phase) return;
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
    if (status.phase === 'complete') {
      throw new Error(`Owner hatching trait enrichment is incomplete (${status.pendingEnrichment} pending).`);
    }
    return true;
  }
}
