import { createHash } from 'node:crypto';
import { duplicateCorrectionDefinition as definition, duplicateCorrectionDefinitionSha256 } from '../../../../shared/ethereum/installedDuplicateCorrection.js';
import { requireDuplicateCorrectionScope } from '../../../../shared/ethereum/duplicateCorrection.js';
import { readEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { REVEAL_ENRICHMENT_VERSION } from '../../../../shared/ethereum/reveal.js';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.js';
import { appendTwinTrait, type TwinRole } from '../../../../shared/ethereum/twinMetadataTrait.js';
import type { TwinMetadataCohortRow, TwinMetadataMaintenanceRequest, TwinMetadataMaintenanceResult } from '../../../../shared/ethereum/twinMetadataMaintenance.js';
import { MAX_REVEAL_METADATA_BYTES, revealMetadataFits } from './ethereumRevealAttributes.js';
import type { RevealCanonicalMetadata } from './ethereumRevealCatalogTypes.js';
import type { RevealSql } from './ethereumRevealStore.js';

const PAGE = 4;
const approvedCohortSha256 = 'b83888dc0cf2251b940548ecd4105f76b704308fb4d679876222cf0b6af9affd';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Entry = { token_id: string; painting_id: number; role: TwinRole; predecessor_json: string; predecessor_sha256: string;
  target_json: string; target_sha256: string; metadata_revision: number; etag: string; published: number };
type Journal = { operation_id: string; cohort_sha256: string; registry_revision: number; catalog_revision: number; group_count: number; token_count: number };
type Host = { sql: RevealSql; transaction<T>(fn: () => T): T; canonical(id: string): RevealCanonicalMetadata | undefined;
  bucket: R2Bucket; current(): Promise<EthereumRevealDeployment>; };

export async function currentTwinDeployment(db: D1Database, r: TwinMetadataMaintenanceRequest) {
  if (r.cohortSha256 !== approvedCohortSha256) throw new Error('Unapproved twin metadata cohort digest.');
  const row = await readEthereumRevealDeployment(db, definition);
  requireDuplicateCorrectionScope(row, definition);
  if (row.revision < r.expectedRevision || row.catalogUpdateId != null) throw new Error('Twin annotation registry revision or ownership changed.');
  return row;
}

export class EthereumTwinMetadataOperation {
  constructor(private readonly host: Host) {}

  private journal() {
    if (!this.host.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='reveal_twin_operation'").toArray().length) return;
    const journals = this.host.sql.exec<Journal>('SELECT * FROM reveal_twin_operation LIMIT 2').toArray();
    if (journals.length !== 1) throw new Error('Invalid twin amendment journal.');
    return journals[0];
  }

  private scope(deployment: EthereumRevealDeployment) {
    const row = this.host.sql.exec<{catalog_revision:number;effective_catalog_version:string;effective_catalog_sha256:string;ready:number;
      candidate_catalog_generation:string|null;deployment_json:string}>('SELECT * FROM settings WHERE id=1').toArray()[0];
    if (!row || row.ready !== 1 || row.catalog_revision !== deployment.catalogRevision || row.effective_catalog_version !== deployment.effectiveCatalogVersion ||
      row.effective_catalog_sha256 !== deployment.effectiveCatalogSha256 || row.candidate_catalog_generation) throw new Error('Twin annotation ledger is not at the registered revision.');
    const origin: EthereumRevealDeployment = JSON.parse(row.deployment_json);
    if (origin.chainId !== deployment.chainId || origin.deploymentId !== deployment.deploymentId || origin.contractAddress !== deployment.contractAddress ||
      origin.metadataBaseUri !== deployment.metadataBaseUri || origin.deploymentBlock !== deployment.deploymentBlock || origin.catalogVersion !== definition.originCatalogVersion) {
      throw new Error('Twin annotation ledger identity changed.');
    }
  }

  private cohort(rows: TwinMetadataCohortRow[]) {
    const proof = this.host.sql.exec<{definition_sha256:string;protected_counts:string}>(
      'SELECT definition_sha256,protected_counts FROM reveal_duplicate_corrections WHERE operation_id=?', definition.operationId).toArray()[0];
    if (proof?.definition_sha256 !== duplicateCorrectionDefinitionSha256) throw new Error('Twin annotation requires the verified duplicate correction.');
    const counts: number[] = JSON.parse(proof.protected_counts);
    if (!Array.isArray(counts) || counts.length !== definition.groups.length) throw new Error('Invalid correction evidence for twin cohort.');
    const candidates = this.host.sql.exec<{painting_id:number;token_id:string;published:number}>(`SELECT i.value AS painting_id,
      COALESCE(c.token_id,a.token_id) AS token_id, CASE WHEN c.token_id IS NOT NULL THEN
      (t.status='hatched' AND op.status='published' AND op.metadata_revision=t.metadata_revision AND (oe.token_id IS NULL OR oe.status='complete'))
      ELSE (p.status='published' AND e.status='published') END AS published
      FROM json_each(?) i
      LEFT JOIN owner_hatching_artwork_claims c ON c.category='painting' AND c.asset_id=i.value
      LEFT JOIN owner_hatching_tokens t ON t.token_id=c.token_id
      LEFT JOIN owner_hatching_publication op ON op.token_id=c.token_id
      LEFT JOIN owner_hatching_enrichment oe ON oe.token_id=c.token_id
      LEFT JOIN assignments a ON a.category='painting' AND a.asset_id=i.value AND a.token_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM owner_hatching_slot_overrides o WHERE o.origin_category=a.category AND o.origin_asset_id=a.asset_id)
        AND NOT EXISTS (SELECT 1 FROM reveal_duplicate_replacements d WHERE d.origin_category=a.category AND d.origin_asset_id=a.asset_id)
      LEFT JOIN publication p ON p.token_id=a.token_id
      LEFT JOIN reveal_enrichment e ON e.token_id=a.token_id AND e.version=? AND e.assignment_revision=a.assignment_revision
      WHERE c.token_id IS NOT NULL OR a.token_id IS NOT NULL`, JSON.stringify(definition.groups.flat()), REVEAL_ENRICHMENT_VERSION).toArray();
    const byPainting = new Map(candidates.map(v => [v.painting_id,v]));
    const rowsByToken = new Map(rows.map(v => [v.tokenId,v]));
    let members = 0, groups = 0;
    if (byPainting.size !== candidates.length) throw new Error('Ambiguous effective twin painting.');
    for (const [i, ids] of definition.groups.entries()) {
      const items = ids.flatMap(id => byPainting.get(id) ?? []).sort((a,b) => Number(a.token_id)-Number(b.token_id));
      const baseline = counts[i];
      if (!Number.isSafeInteger(baseline) || baseline < 0 || baseline > ids.length || items.length < baseline || items.length > Math.max(baseline,1)) {
        throw new Error('Twin cohort conflicts with the corrected inventory.');
      }
      if (items.length < 2) continue;
      groups++;
      for (const [j,item] of items.entries()) {
        const row = rowsByToken.get(item.token_id);
        if (!item.published || !row || row.paintingId !== item.painting_id || row.role !== (j === 0 ? 'good twin' : 'evil twin')) {
          throw new Error('Twin cohort contains missing, unsettled or incorrectly labeled tokens.');
        }
        members++;
      }
    }
    if (!groups || members !== rows.length) throw new Error('Twin cohort includes unexpected or missing tokens.');
    return groups;
  }

  private prepare(r: TwinMetadataMaintenanceRequest, deployment: EthereumRevealDeployment) {
    this.host.transaction(() => {
      this.scope(deployment);
      const rows = r.rows!;
      const groups = this.cohort(rows);
      this.host.sql.exec(`CREATE TABLE reveal_twin_operation(id INTEGER PRIMARY KEY CHECK(id=1), operation_id TEXT NOT NULL UNIQUE,
        cohort_sha256 TEXT NOT NULL,registry_revision INTEGER NOT NULL,catalog_revision INTEGER NOT NULL,group_count INTEGER NOT NULL,token_count INTEGER NOT NULL)`);
      this.host.sql.exec(`CREATE TABLE reveal_twin_annotations(token_id TEXT PRIMARY KEY,painting_id INTEGER NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('good twin','evil twin')),predecessor_json TEXT NOT NULL,predecessor_sha256 TEXT NOT NULL,
        target_json TEXT NOT NULL,target_sha256 TEXT NOT NULL,metadata_revision INTEGER NOT NULL,etag TEXT NOT NULL,
        published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)))`);
      this.host.sql.exec('INSERT INTO reveal_twin_operation VALUES(1,?,?,?,?,?,?)',r.operationId,r.cohortSha256,r.expectedRevision,deployment.catalogRevision!,groups,rows.length);
      for (const row of rows) {
        const current = this.host.canonical(row.tokenId);
        if (!current || current.category !== 'painting' || current.assetId !== row.paintingId ||
          current.targetSha256 !== row.beforeSha256 || hash(current.metadataJson) !== row.beforeSha256 ||
          createHash('md5').update(current.metadataJson).digest('hex') !== row.etag) throw new Error('Twin predecessor differs from its verified canonical token.');
        const target = appendTwinTrait(current.metadataJson,row.role);
        if (!revealMetadataFits(target)) throw new Error('Twin metadata exceeds the supported size.');
        this.host.sql.exec(`INSERT INTO reveal_twin_annotations(token_id,painting_id,role,predecessor_json,predecessor_sha256,
          target_json,target_sha256,metadata_revision,etag) VALUES(?,?,?,?,?,?,?,?,?)`,row.tokenId,row.paintingId,row.role,current.metadataJson,
          row.beforeSha256,target,hash(target),current.metadataRevision+1,row.etag);
      }
      for (const table of ['reveal_twin_operation','reveal_twin_annotations']) {
        this.host.sql.exec(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Twin journal is immutable'); END`);
        this.host.sql.exec(`CREATE TRIGGER ${table}_no_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Twin cohort is sealed'); END`);
      }
      this.host.sql.exec("CREATE TRIGGER reveal_twin_operation_no_update BEFORE UPDATE ON reveal_twin_operation BEGIN SELECT RAISE(ABORT,'Twin journal is immutable'); END");
      this.host.sql.exec(`CREATE TRIGGER reveal_twin_annotations_no_edit BEFORE UPDATE OF token_id,painting_id,role,predecessor_json,predecessor_sha256,
        target_json,target_sha256,metadata_revision,etag ON reveal_twin_annotations BEGIN SELECT RAISE(ABORT,'Twin journal is immutable'); END`);
      this.host.sql.exec(`CREATE TRIGGER reveal_twin_annotations_ack_once BEFORE UPDATE OF published ON reveal_twin_annotations
        WHEN OLD.published!=0 OR NEW.published!=1 BEGIN SELECT RAISE(ABORT,'Invalid twin publication acknowledgement'); END`);
    });
  }

  private async object(deployment: EthereumRevealDeployment, row: Entry, write: boolean) {
    const key = new URL(ethereumTokenMetadataUri(deployment,row.token_id)).pathname.slice(1);
    const current = this.host.canonical(row.token_id);
    if (!current || current.assetId !== row.painting_id || current.category !== 'painting' || current.metadataRevision !== row.metadata_revision ||
      current.targetSha256 !== row.target_sha256 || current.metadataJson !== row.target_json ||
      hash(row.predecessor_json) !== row.predecessor_sha256 || hash(row.target_json) !== row.target_sha256) throw new Error('Twin metadata no longer matches the canonical ledger.');
    const object = await this.host.bucket.get(key);
    if (!object || object.size > MAX_REVEAL_METADATA_BYTES || object.httpMetadata?.contentType !== 'application/json; charset=utf-8' ||
      object.httpMetadata.cacheControl !== 'no-store' || object.httpMetadata.contentEncoding) throw new Error('Unexpected twin metadata object or headers.');
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== object.size) throw new Error('Incomplete twin metadata read.');
    const json = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    const target = json === row.target_json && object.etag === createHash('md5').update(row.target_json).digest('hex');
    if (target && object.customMetadata?.sha256 === row.target_sha256 &&
      object.customMetadata.revealMetadataRevision === String(row.metadata_revision)) return;
    const predecessor = json === row.predecessor_json && object.etag === row.etag &&
      (object.customMetadata?.sha256 === undefined || object.customMetadata.sha256 === row.predecessor_sha256);
    if (!write || !target && !predecessor) throw new Error('Twin metadata predecessor or storage headers conflict.');
    const latest = await this.host.current();
    if (latest.revision !== deployment.revision || latest.catalogRevision !== deployment.catalogRevision) throw new Error('Twin publication registry changed during the page.');
    const authorized = this.host.canonical(row.token_id);
    if (authorized?.targetSha256 !== row.target_sha256 || authorized.metadataRevision !== row.metadata_revision ||
      authorized.metadataJson !== row.target_json) throw new Error('Twin publication authorization changed.');
    const result = await this.host.bucket.put(key,row.target_json,{onlyIf:{etagMatches:object.etag},httpMetadata:object.httpMetadata,
      customMetadata:{...object.customMetadata,sha256:row.target_sha256,revealMetadataRevision:String(row.metadata_revision)}});
    if (!result) throw new Error('Twin metadata conditional write conflicted. Retry from the journal.');
  }

  async run(r: TwinMetadataMaintenanceRequest): Promise<TwinMetadataMaintenanceResult> {
    const deployment = await this.host.current();
    this.scope(deployment);
    let journal = this.journal();
    if (journal && (journal.operation_id !== r.operationId || journal.cohort_sha256 !== r.cohortSha256 ||
      journal.registry_revision !== r.expectedRevision || journal.catalog_revision > deployment.catalogRevision!)) throw new Error('Resume the original twin metadata journal and revision.');
    if (!journal && (deployment.revision !== r.expectedRevision || deployment.effectiveCatalogVersion !== definition.catalogVersion ||
      deployment.effectiveCatalogSha256 !== definition.manifestSha256) || journal && deployment.catalogRevision === journal.catalog_revision &&
      (deployment.effectiveCatalogVersion !== definition.catalogVersion || deployment.effectiveCatalogSha256 !== definition.manifestSha256)) {
      throw new Error('Twin metadata predecessor revision or catalog changed.');
    }
    if (r.action === 'prepare' && !journal) {
      this.prepare(r,deployment);
      journal = this.journal();
    }
    if (!journal && r.action !== 'inspect') throw new Error('Prepare the complete twin metadata cohort first.');
    let checked = 0, next: number | null = null;
    if (journal && (r.action === 'advance' || r.action === 'verify')) {
      const verify = r.action === 'verify', offset = r.after ?? 0;
      if (verify && (offset >= journal.token_count || this.host.sql.exec('SELECT 1 FROM reveal_twin_annotations WHERE published=0 LIMIT 1').toArray().length)) {
        throw new Error('Twin verification requires a complete publication and valid cursor.');
      }
      const rows = verify ? this.host.sql.exec<Entry>('SELECT * FROM reveal_twin_annotations ORDER BY CAST(token_id AS INTEGER) LIMIT ? OFFSET ?',PAGE,offset).toArray()
        : this.host.sql.exec<Entry>('SELECT * FROM reveal_twin_annotations WHERE published=0 ORDER BY CAST(token_id AS INTEGER) LIMIT ?',PAGE).toArray();
      for (const row of rows) {
        await this.object(deployment,row,!verify);
        if (!verify) this.host.sql.exec('UPDATE reveal_twin_annotations SET published=1 WHERE token_id=? AND published=0',row.token_id);
        checked++;
      }
      if (verify && offset+checked < journal.token_count) next=offset+checked;
      await this.host.current();
    }
    const counts = journal ? this.host.sql.exec<{total:number;good:number;published:number}>(
      "SELECT COUNT(*) AS total,SUM(role='good twin') AS good,SUM(published) AS published FROM reveal_twin_annotations").toArray()[0] : {total:0,good:0,published:0};
    if (journal && (counts.total !== journal.token_count || counts.good !== journal.group_count)) throw new Error('Twin cohort counts changed.');
    return {operationId:r.operationId,cohortSha256:r.cohortSha256,phase:!journal?'unstarted':counts.published===counts.total?'complete':counts.published?'publishing':'prepared',
      total:counts.total,good:counts.good,evil:counts.total-counts.good,groups:counts.good,published:counts.published,
      registryRevision:deployment.revision,catalogRevision:deployment.catalogRevision!,checked,next};
  }
}
