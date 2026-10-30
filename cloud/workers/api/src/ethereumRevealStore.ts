import type { EthereumArtworkCategory, EthereumRevealedArtwork, EthereumRevealObservation,
  EthereumRevealTransactionResponse } from '../../../../shared/ethereum/reveal.js';
import { EthereumRevealRecoveryStore, type RevealDispatchState, type RevealReceiptClaim, type RevealScanClaim, type RevealWorkLane } from './ethereumRevealRecoveryStore.js';
import type { EthereumRevealCrateRecovery, EthereumRevealTokenRecovery, EthereumRevealTransactionInspection } from './ethereumRevealChain.js';
export type { RevealDispatchState, RevealReceiptClaim, RevealScanClaim, RevealWorkLane } from './ethereumRevealRecoveryStore.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { buildRevealedArtwork, REVEAL_ARTWORK_COUNT, REVEAL_CATEGORIES, REVEAL_CATEGORY_COUNTS,
  revealCrateSize, revealRandomInteger } from './ethereumRevealCatalog.js';

type SqlValue = string | number | null | ArrayBuffer;
export type RevealSql = { exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): { toArray(): T[] } };
type PoolRow = { category: EthereumArtworkCategory; available: number; seeded: number; total: number };
type ReservationRow = { category: EthereumArtworkCategory; asset_id: number; crate_token_id: string; slot: number };
export type RevealCrate = { crateTokenId: string; tokenIds: string[] };
export type RevealTransactionJob = {
  hash: string; status: 'pending' | 'revealed' | 'reverted' | 'not_unpack'; crates_json: string;
  from_block: number; next_check_ms: number; attempts: number; observation_json: string | null;
  tokens_json: string; revealed_all: number; requested_all: number; replacement_ranges_json: string;
  created_at_ms: number; last_requested_at_ms: number; checked_at_ms: number; lease_until_ms: number; dormant: number;
  tracking_generation: number; receipt_seen: number; failure_json: string | null;
  incarnation: string; transient: number; admission_expires_at_ms: number;
};
export type RevealPublicationJob = {
  token_id: string; metadata_json: string; placeholder_json: string; attempts: number; claim_id?: string;
};
export type RevealPublicationResult = { job: RevealPublicationJob; status: 'published' | 'conflict' | 'retry' };
export type RevealSearchRange = { fromBlock: number; toBlock?: number };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), deployment_json TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS reveal_migrations (name TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS pools (category TEXT PRIMARY KEY CHECK(category IN ('egg','painting','video')),
    total INTEGER NOT NULL, seeded INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 0,
    CHECK(available >= 0 AND available <= seeded AND seeded <= total))`,
  `CREATE TABLE IF NOT EXISTS free_slots (category TEXT NOT NULL, slot INTEGER NOT NULL, asset_id INTEGER NOT NULL,
    PRIMARY KEY(category,slot), UNIQUE(category,asset_id), FOREIGN KEY(category) REFERENCES pools(category))`,
  `CREATE TABLE IF NOT EXISTS crates (sequence INTEGER PRIMARY KEY AUTOINCREMENT, crate_token_id TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS assignments (category TEXT NOT NULL, asset_id INTEGER NOT NULL,
    crate_token_id TEXT NOT NULL, slot INTEGER NOT NULL, token_id TEXT UNIQUE, artwork_json TEXT,
    metadata_json TEXT, placeholder_json TEXT, frozen_at_ms INTEGER,
    PRIMARY KEY(category,asset_id), FOREIGN KEY(crate_token_id) REFERENCES crates(crate_token_id),
    CHECK((token_id IS NULL AND artwork_json IS NULL AND metadata_json IS NULL AND frozen_at_ms IS NULL) OR
      (token_id IS NOT NULL AND artwork_json IS NOT NULL AND metadata_json IS NOT NULL AND placeholder_json IS NOT NULL AND frozen_at_ms IS NOT NULL)))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS private_slot ON assignments(crate_token_id,slot) WHERE token_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS assignments_crate ON assignments(crate_token_id,token_id)`,
  `CREATE TRIGGER IF NOT EXISTS frozen_assignment_update BEFORE UPDATE ON assignments WHEN OLD.token_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Frozen reveal cannot change'); END`,
  `CREATE TRIGGER IF NOT EXISTS frozen_assignment_delete BEFORE DELETE ON assignments WHEN OLD.token_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'Frozen reveal cannot be deleted'); END`,
  `CREATE TRIGGER IF NOT EXISTS assignment_not_free BEFORE INSERT ON assignments WHEN
    EXISTS(SELECT 1 FROM free_slots WHERE category=NEW.category AND asset_id=NEW.asset_id)
    BEGIN SELECT RAISE(ABORT,'Assigned reveal asset is still free'); END`,
  `CREATE TRIGGER IF NOT EXISTS free_not_assigned BEFORE INSERT ON free_slots WHEN
    EXISTS(SELECT 1 FROM assignments WHERE category=NEW.category AND asset_id=NEW.asset_id)
    BEGIN SELECT RAISE(ABORT,'Reveal asset is already assigned'); END`,
  `CREATE TRIGGER IF NOT EXISTS free_update_not_assigned BEFORE UPDATE ON free_slots WHEN
    EXISTS(SELECT 1 FROM assignments WHERE category=NEW.category AND asset_id=NEW.asset_id)
    BEGIN SELECT RAISE(ABORT,'Reveal asset is already assigned'); END`,
  `CREATE TABLE IF NOT EXISTS transactions (hash TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
    crates_json TEXT NOT NULL DEFAULT '[]', from_block INTEGER NOT NULL, next_check_ms INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, observation_json TEXT, tokens_json TEXT NOT NULL DEFAULT '[]', revealed_all INTEGER NOT NULL DEFAULT 0,
    requested_all INTEGER NOT NULL DEFAULT 0, replacement_ranges_json TEXT NOT NULL DEFAULT '[]',
    created_at_ms INTEGER NOT NULL, last_requested_at_ms INTEGER NOT NULL, checked_at_ms INTEGER NOT NULL DEFAULT 0,
    lease_until_ms INTEGER NOT NULL DEFAULT 0, dormant INTEGER NOT NULL DEFAULT 0,
    tracking_generation INTEGER NOT NULL DEFAULT 0, receipt_seen INTEGER NOT NULL DEFAULT 0, failure_json TEXT,
    incarnation TEXT NOT NULL DEFAULT '', transient INTEGER NOT NULL DEFAULT 1, admission_expires_at_ms INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS transactions_active_due ON transactions(next_check_ms,hash) WHERE dormant=0`,
  `DROP INDEX IF EXISTS transactions_due`,
  `CREATE TABLE IF NOT EXISTS crate_recovery_trackers (crate_token_id TEXT PRIMARY KEY,
    transaction_hash TEXT NOT NULL REFERENCES transactions(hash))`,
  `CREATE INDEX IF NOT EXISTS crate_recovery_tracker_transaction ON crate_recovery_trackers(transaction_hash)`,
  `CREATE TABLE IF NOT EXISTS replacement_candidates (original_hash TEXT NOT NULL REFERENCES transactions(hash),
    transaction_hash TEXT NOT NULL, crate_token_id TEXT NOT NULL, checked_at_ms INTEGER NOT NULL DEFAULT 0,
    verified_at_ms INTEGER NOT NULL DEFAULT 0, discovered_at_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(original_hash,transaction_hash,crate_token_id))`,
  `CREATE INDEX IF NOT EXISTS replacement_candidate_transaction ON replacement_candidates(transaction_hash)`,
  `CREATE TABLE IF NOT EXISTS replacement_chunks (original_hash TEXT NOT NULL REFERENCES transactions(hash),
    chunk_index INTEGER NOT NULL, crate_ids_json TEXT NOT NULL, from_block INTEGER NOT NULL,
    ranges_json TEXT NOT NULL DEFAULT '[]', generation INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
    checked_at_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(original_hash,chunk_index))`,
  `CREATE TABLE IF NOT EXISTS observations (transaction_hash TEXT NOT NULL, block_hash TEXT NOT NULL, crate_token_id TEXT NOT NULL,
    block_number INTEGER NOT NULL, token_ids_json TEXT NOT NULL, PRIMARY KEY(transaction_hash,block_hash,crate_token_id))`,
  `CREATE TABLE IF NOT EXISTS publication (token_id TEXT PRIMARY KEY REFERENCES assignments(token_id),
    status TEXT NOT NULL DEFAULT 'pending', next_check_ms INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,claim_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS publication_due_numeric ON publication(status,next_check_ms,CAST(token_id AS INTEGER))`,
  `DROP INDEX IF EXISTS publication_due`,
  `CREATE TABLE IF NOT EXISTS recovery_jobs (id TEXT PRIMARY KEY, token_ids_json TEXT NOT NULL, ranges_json TEXT NOT NULL,
    next_check_ms INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS recovery_due ON recovery_jobs(next_check_ms)`,
  `CREATE TABLE IF NOT EXISTS token_recovery (token_id TEXT PRIMARY KEY, job_id TEXT, status TEXT NOT NULL,
    checked_at_ms INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS provenance (token_id TEXT PRIMARY KEY, transaction_hash TEXT NOT NULL,
    block_number INTEGER NOT NULL, block_hash TEXT NOT NULL)`,
];

function immutableDeployment(deployment: EthereumRevealDeployment): string {
  return JSON.stringify({ deploymentId: deployment.deploymentId, dropId: deployment.dropId, chainId: deployment.chainId,
    contractAddress: deployment.contractAddress, metadataBaseUri: deployment.metadataBaseUri,
    deploymentBlock: deployment.deploymentBlock, catalogVersion: deployment.catalogVersion,
    templateJson: deployment.templateJson, templateSha256: deployment.templateSha256 });
}

export class EthereumRevealStore {
  private readonly transaction: <T>(action: () => T) => T;
  private readonly recovery: EthereumRevealRecoveryStore;

  constructor(private readonly sql: RevealSql, transaction: <T>(action: () => T) => T,
    private readonly randomInteger: (maximum: number) => number = revealRandomInteger) {
    let depth = 0;
    this.transaction = action => {
      if (depth) return action();
      return transaction(() => {
        depth++;
        try { return action(); } finally { depth--; }
      });
    };
    this.transaction(() => {
      for (const statement of SCHEMA) this.sql.exec(statement);
      const columns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(transactions)').toArray().map(row => row.name));
      for (const [name, definition] of [['tracking_generation', 'INTEGER NOT NULL DEFAULT 0'],
        ['receipt_seen', 'INTEGER NOT NULL DEFAULT 0'], ['failure_json', 'TEXT'], ['incarnation', "TEXT NOT NULL DEFAULT ''"],
        ['transient', 'INTEGER NOT NULL DEFAULT 1'], ['admission_expires_at_ms', 'INTEGER NOT NULL DEFAULT 0']]) {
        if (!columns.has(name)) this.sql.exec(`ALTER TABLE transactions ADD COLUMN ${name} ${definition}`);
      }
      if (!this.sql.exec<{ name: string }>('PRAGMA table_info(publication)').toArray().some(row => row.name === 'claim_id')) {
        this.sql.exec('ALTER TABLE publication ADD COLUMN claim_id TEXT');
      }
    });
    this.recovery = new EthereumRevealRecoveryStore(sql, action => this.transaction(action), {
      freeze: (deployment, observation, crates, now, allCrates) => this.freezeRecords(deployment, observation, crates, now, allCrates),
      reserve: crates => this.reserve(crates),
      frozen: ids => this.frozen(ids),
    });
  }

  configure(deployment: EthereumRevealDeployment): void {
    const serialized = immutableDeployment(deployment);
    const existing = this.sql.exec<{ deployment_json: string }>('SELECT deployment_json FROM settings WHERE id=1').toArray()[0];
    if (existing && existing.deployment_json !== serialized) throw new Error('Reveal deployment identity cannot change.');
    if (existing) return;
    this.transaction(() => {
      this.sql.exec('INSERT INTO settings(id,deployment_json) VALUES(1,?)', serialized);
      for (const category of REVEAL_CATEGORIES) this.sql.exec('INSERT INTO pools(category,total) VALUES(?,?)', category, REVEAL_CATEGORY_COUNTS[category]);
    });
  }

  identity(): { chainId: number; contractAddress: string } | null {
    const row = this.sql.exec<{ deployment_json: string }>('SELECT deployment_json FROM settings WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.deployment_json) : null;
  }

  ready(): boolean {
    return this.sql.exec<{ ready: number }>('SELECT ready FROM settings WHERE id=1').toArray()[0]?.ready === 1;
  }

  initializeChunk(limit = 2_000): boolean {
    if (this.ready()) return true;
    return this.transaction(() => {
      let remaining = limit;
      for (const pool of this.pools()) {
        const count = Math.min(remaining, pool.total - pool.seeded);
        if (!count) continue;
        this.sql.exec(`WITH RECURSIVE ids(id) AS (SELECT ? UNION ALL SELECT id+1 FROM ids WHERE id < ?)
          INSERT INTO free_slots(category,slot,asset_id) SELECT ?, id-1, id FROM ids`, pool.seeded + 1, pool.seeded + count, pool.category);
        this.sql.exec('UPDATE pools SET seeded=seeded+?, available=available+? WHERE category=?', count, count, pool.category);
        remaining -= count;
        if (!remaining) break;
      }
      const count = this.sql.exec<{ count: number }>('SELECT SUM(seeded) AS count FROM pools').toArray()[0].count;
      if (count === REVEAL_ARTWORK_COUNT) this.sql.exec('UPDATE settings SET ready=1 WHERE id=1');
      return count === REVEAL_ARTWORK_COUNT;
    });
  }

  private pools(): PoolRow[] { return this.sql.exec<PoolRow>('SELECT * FROM pools ORDER BY category').toArray(); }

  private privateSlot(crateTokenId: string, slot: number): ReservationRow | undefined {
    return this.sql.exec<ReservationRow>(`SELECT category,asset_id,crate_token_id,slot FROM assignments
      WHERE crate_token_id=? AND slot=? AND token_id IS NULL`, crateTokenId, slot).toArray()[0];
  }

  private freeReservation(reservation: ReservationRow): void {
    this.sql.exec('DELETE FROM assignments WHERE category=? AND asset_id=? AND token_id IS NULL', reservation.category, reservation.asset_id);
    const pool = this.sql.exec<PoolRow>('SELECT * FROM pools WHERE category=?', reservation.category).toArray()[0];
    this.sql.exec('INSERT INTO free_slots(category,slot,asset_id) VALUES(?,?,?)', reservation.category, pool.available, reservation.asset_id);
    this.sql.exec('UPDATE pools SET available=available+1 WHERE category=?', reservation.category);
  }

  private takeAsset(crateTokenId: string, slot: number, reclaim: boolean): ReservationRow | undefined {
    let pools = this.pools().filter(pool => pool.available > 0);
    if (!pools.length && reclaim) {
      const donor = this.sql.exec<ReservationRow>(`SELECT a.category,a.asset_id,a.crate_token_id,a.slot FROM assignments a
        JOIN crates c ON c.crate_token_id=a.crate_token_id WHERE a.token_id IS NULL
        ORDER BY c.sequence DESC,a.crate_token_id DESC,a.slot DESC LIMIT 1`).toArray()[0];
      if (donor) this.freeReservation(donor);
      pools = this.pools().filter(pool => pool.available > 0);
    }
    if (!pools.length) return undefined;
    let selection = this.randomInteger(pools.reduce((sum, pool) => sum + pool.total, 0));
    const pool = pools.find(value => { selection -= value.total; return selection < 0; })!;
    const index = this.randomInteger(pool.available);
    const chosen = this.sql.exec<{ asset_id: number }>('SELECT asset_id FROM free_slots WHERE category=? AND slot=?', pool.category, index).toArray()[0];
    const last = this.sql.exec<{ asset_id: number }>('SELECT asset_id FROM free_slots WHERE category=? AND slot=?', pool.category, pool.available - 1).toArray()[0];
    if (!chosen || !last) throw new Error('Reveal free pool is inconsistent.');
    this.sql.exec('DELETE FROM free_slots WHERE category=? AND slot=?', pool.category, pool.available - 1);
    if (index !== pool.available - 1) this.sql.exec('UPDATE free_slots SET asset_id=? WHERE category=? AND slot=?', last.asset_id, pool.category, index);
    this.sql.exec('UPDATE pools SET available=available-1 WHERE category=?', pool.category);
    this.sql.exec('INSERT INTO assignments(category,asset_id,crate_token_id,slot) VALUES(?,?,?,?)', pool.category, chosen.asset_id, crateTokenId, slot);
    return { category: pool.category, asset_id: chosen.asset_id, crate_token_id: crateTokenId, slot };
  }

  reserve(crateTokenIds: string[]): void {
    if (!this.ready()) throw new Error('Reveal inventory is not provisioned.');
    this.transaction(() => {
      for (const crateTokenId of new Set(crateTokenIds)) {
        const count = revealCrateSize(crateTokenId);
        this.sql.exec('INSERT OR IGNORE INTO crates(crate_token_id) VALUES(?)', crateTokenId);
        for (let slot = 0; slot < count; slot++) {
          if (!this.privateSlot(crateTokenId, slot)) this.takeAsset(crateTokenId, slot, false);
        }
      }
    });
  }

  frozen(tokenIds: string[]): EthereumRevealedArtwork[] {
    const byId = new Map<string, EthereumRevealedArtwork>();
    for (let start = 0; start < tokenIds.length; start += 100) {
      const page = tokenIds.slice(start, start + 100);
      if (!page.length) continue;
      const rows = this.sql.exec<{ token_id: string; artwork_json: string }>(`SELECT token_id,artwork_json FROM assignments
        WHERE token_id IN (${page.map(() => '?').join(',')})`, ...page).toArray();
      for (const row of rows) byId.set(row.token_id, JSON.parse(row.artwork_json));
    }
    return tokenIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  }

  private freezeRecords(deployment: EthereumRevealDeployment, observation: EthereumRevealObservation, crates: RevealCrate[], now: number,
    allCrates = true): number {
    if (!this.ready()) throw new Error('Reveal inventory is not provisioned.');
    this.configure(deployment);
    const tokens = crates.flatMap(crate => crate.tokenIds);
    if (new Set(tokens).size !== tokens.length || new Set(crates.map(crate => crate.crateTokenId)).size !== crates.length ||
      tokens.some(id => !/^[1-9]\d*$/.test(id) || Number(id) > REVEAL_ARTWORK_COUNT) ||
      crates.some(crate => crate.tokenIds.length !== revealCrateSize(crate.crateTokenId))) throw new Error('Invalid verified reveal ranges.');
    return this.transaction(() => {
      const existing = new Set(this.frozen(tokens).map(artwork => artwork.tokenId));
      for (const crate of crates) {
        this.sql.exec('INSERT OR IGNORE INTO crates(crate_token_id) VALUES(?)', crate.crateTokenId);
        for (let slot = 0; slot < crate.tokenIds.length; slot++) {
          if (!existing.has(crate.tokenIds[slot])) continue;
          const reservation = this.privateSlot(crate.crateTokenId, slot);
          if (reservation) this.freeReservation(reservation);
        }
      }
      for (const crate of crates) {
        for (let slot = 0; slot < crate.tokenIds.length; slot++) {
          const tokenId = crate.tokenIds[slot];
          if (existing.has(tokenId)) continue;
          const reservation = this.privateSlot(crate.crateTokenId, slot) || this.takeAsset(crate.crateTokenId, slot, true);
          if (!reservation) throw new Error('Reveal inventory invariant failed.');
          const value = buildRevealedArtwork({ templateJson: deployment.templateJson, tokenId, crateTokenId: crate.crateTokenId,
            category: reservation.category, assetId: reservation.asset_id, observation });
          this.sql.exec(`UPDATE assignments SET token_id=?,artwork_json=?,metadata_json=?,placeholder_json=?,frozen_at_ms=?
            WHERE category=? AND asset_id=? AND token_id IS NULL`, tokenId, JSON.stringify(value.artwork), value.metadataJson,
            value.placeholderJson, now, reservation.category, reservation.asset_id);
          this.sql.exec('INSERT INTO publication(token_id) VALUES(?)', tokenId);
        }
        this.sql.exec(`INSERT OR IGNORE INTO observations(transaction_hash,block_hash,crate_token_id,block_number,token_ids_json)
          VALUES(?,?,?,?,?)`, observation.transactionHash, observation.blockHash, crate.crateTokenId, observation.blockNumber, JSON.stringify(crate.tokenIds));
      }
      this.sql.exec(`INSERT OR IGNORE INTO transactions(hash,from_block,created_at_ms,last_requested_at_ms,incarnation,transient)
        VALUES(?,?,?,?,?,0)`, observation.transactionHash, deployment.deploymentBlock, now, now, crypto.randomUUID());
      const mappings = crates.flatMap(crate => crate.tokenIds.map(tokenId => ({ tokenId, crateTokenId: crate.crateTokenId })));
      const previous = this.transactionJob(observation.transactionHash)!;
      const sameObservation = previous.observation_json === JSON.stringify(observation);
      const previousMappings: Array<{ tokenId: string; crateTokenId: string }> = sameObservation ? JSON.parse(previous.tokens_json) : [];
      const merged = new Map([...previousMappings, ...mappings].map(value => [value.tokenId, value]));
      const admitted = [...new Set([...(JSON.parse(previous.crates_json) as string[]), ...crates.map(crate => crate.crateTokenId)])];
      this.sql.exec(`UPDATE transactions SET status='revealed',observation_json=?,tokens_json=?,revealed_all=?,crates_json=?,
        next_check_ms=?,attempts=0,lease_until_ms=0,dormant=0,receipt_seen=1,tracking_generation=tracking_generation+1,
        transient=0,admission_expires_at_ms=0 WHERE hash=?`,
        JSON.stringify(observation), JSON.stringify([...merged.values()]),
        allCrates || sameObservation && previous.revealed_all ? 1 : 0,
        JSON.stringify(admitted), now + 15_000, observation.transactionHash);
      return previous.tracking_generation + 1;
    });
  }

  freeze(deployment: EthereumRevealDeployment, observation: EthereumRevealObservation, crates: RevealCrate[], now: number,
    allCrates = true): number {
    return this.transaction(() => {
      const generation = this.freezeRecords(deployment, observation, crates, now, allCrates);
      this.recovery.seedConfirmed(deployment, observation, crates, now);
      return generation;
    });
  }

  transactionJob(hash: string): RevealTransactionJob | undefined {
    return this.sql.exec<RevealTransactionJob>('SELECT * FROM transactions WHERE hash=?', hash).toArray()[0];
  }

  transactionResponse(deployment: EthereumRevealDeployment, hash: string): EthereumRevealTransactionResponse {
    const job = this.transactionJob(hash);
    const mappings: Array<{ tokenId: string; crateTokenId: string }> = job ? JSON.parse(job.tokens_json) : [];
    const cratesByToken = new Map(mappings.map(value => [value.tokenId, value.crateTokenId]));
    const status = job?.status === 'revealed' && !job.revealed_all ? 'pending' : job?.status || 'pending';
    const artworks = status === 'revealed' ? this.frozen(mappings.map(value => value.tokenId))
      .map(value => ({ ...value, crateTokenId: cratesByToken.get(value.tokenId)! })) : [];
    const observation: EthereumRevealObservation | null = job?.observation_json ? JSON.parse(job.observation_json) : null;
    return { deploymentId: deployment.deploymentId, dropId: deployment.dropId, chainId: deployment.chainId,
      contractAddress: deployment.contractAddress, status, artworks,
      retryAfterMs: status === 'pending' ? 2_000 : 0,
      ...(observation ? { observedBlock: { number: observation.blockNumber, hash: observation.blockHash } } : {}) };
  }

  migrationReady(): boolean { return this.recovery.migrationReady(); }
  migrateChunk(now: number, limit = 128) { return this.recovery.migrateChunk(now, limit); }
  knownTransaction(hash: string): boolean { return this.recovery.knownTransaction(hash); }
  knownTokens(ids: string[], now: number): boolean { return this.recovery.knownTokens(ids, now); }
  recoveringTokenIds(ids: string[]): string[] { return this.recovery.recoveringTokenIds(ids); }
  admitTransaction(hash: string, fromBlock: number, now: number) { return this.recovery.admitTransaction(hash, fromBlock, now); }
  admitTokens(ids: string[], fromBlock: number, now: number): void { this.recovery.admitTokens(ids, fromBlock, now); }
  tokensResponse(deployment: EthereumRevealDeployment, ids: string[]) { return this.recovery.tokensResponse(deployment, ids); }
  opaqueCount(): number { return this.recovery.opaqueCount(); }
  dispatchState(now: number): RevealDispatchState { return this.recovery.dispatchState(now); }
  recordThrottle(now: number, retryAfterMs: number): void { this.recovery.recordThrottle(now, retryAfterMs); }
  claimOverflow(hash: string, now: number, deadlineMs: number): RevealReceiptClaim | null {
    return this.recovery.claimOverflow(hash, now, deadlineMs);
  }
  validOverflow(claim: RevealReceiptClaim, now: number): boolean { return this.recovery.validOverflow(claim, now); }
  releaseOverflow(claim: RevealReceiptClaim): boolean { return this.recovery.releaseOverflow(claim); }
  validReceiptClaim(claim: RevealReceiptClaim, now: number): boolean { return this.recovery.validReceiptClaim(claim, now); }
  claimReceipt(now: number, lane: RevealWorkLane, preferredHash?: string, excludeHashes: string[] = []): RevealReceiptClaim | null {
    return this.recovery.claimReceipt(now, lane, preferredHash, excludeHashes);
  }
  recordReceiptPresence(claim: RevealReceiptClaim, now: number): boolean { return this.recovery.recordReceiptPresence(claim, now); }
  completeReceipt(deployment: EthereumRevealDeployment, claim: RevealReceiptClaim, result: EthereumRevealTransactionInspection, now: number): boolean {
    return this.recovery.completeReceipt(deployment, claim, result, now);
  }
  failReceipt(claim: RevealReceiptClaim, now: number): boolean { return this.recovery.failReceipt(claim, now); }
  acceptVerified(deployment: EthereumRevealDeployment, hash: string, result: EthereumRevealTransactionInspection, startedAtMs: number, now: number): boolean {
    return this.recovery.acceptVerified(deployment, hash, result, startedAtMs, now);
  }
  claimScan(now: number, lane: RevealWorkLane, scope?: { tokenIds?: string[] }): RevealScanClaim | null {
    return this.recovery.claimScan(now, lane, scope);
  }
  completeCrateScan(claim: RevealScanClaim, result: EthereumRevealCrateRecovery, now: number): boolean {
    return this.recovery.completeCrateScan(claim, result, now);
  }
  completeTokenScan(claim: RevealScanClaim, result: EthereumRevealTokenRecovery, now: number): boolean {
    return this.recovery.completeTokenScan(claim, result, now);
  }
  failScan(claim: RevealScanClaim, now: number): boolean { return this.recovery.failScan(claim, now); }

  provenance(tokenIds: string[]): EthereumRevealObservation[] {
    const values = new Map<string, EthereumRevealObservation>();
    for (let offset = 0; offset < tokenIds.length; offset += 100) {
      const ids = tokenIds.slice(offset, offset + 100);
      for (const row of this.sql.exec<{ transaction_hash: string; block_number: number; block_hash: string }>(
        `SELECT transaction_hash,block_number,block_hash FROM provenance WHERE token_id IN (${ids.map(() => '?').join(',')})`, ...ids).toArray()) {
        values.set(row.transaction_hash, { transactionHash: row.transaction_hash, blockNumber: row.block_number, blockHash: row.block_hash });
      }
    }
    return [...values.values()];
  }

  claimPublications(now: number, limit = 8): RevealPublicationJob[] {
    return this.transaction(() => {
      const rows = this.sql.exec<RevealPublicationJob>(`SELECT p.token_id,a.metadata_json,a.placeholder_json,p.attempts FROM publication p
        JOIN assignments a ON a.token_id=p.token_id WHERE p.status='pending' AND p.next_check_ms<=?
        ORDER BY p.next_check_ms,CAST(p.token_id AS INTEGER) LIMIT ?`, now, limit).toArray();
      if (!rows.length) return rows;
      const claimId = crypto.randomUUID();
      for (const row of rows) {
        row.claim_id = claimId;
        this.sql.exec('UPDATE publication SET next_check_ms=?,attempts=attempts+1,claim_id=? WHERE token_id=?',
          now + 60_000, claimId, row.token_id);
      }
      return rows;
    });
  }

  releasePublicationClaims(jobs: RevealPublicationJob[], now: number): void {
    this.transaction(() => {
      for (const job of jobs) {
        this.sql.exec(`UPDATE publication SET attempts=?,next_check_ms=?,claim_id=NULL
          WHERE token_id=? AND status='pending' AND attempts=? AND claim_id IS ?`,
        job.attempts, now, job.token_id, job.attempts + 1, job.claim_id ?? null);
      }
    });
  }

  completePublications(results: RevealPublicationResult[], now: number): RevealPublicationResult[] {
    return this.transaction(() => {
      const applied: RevealPublicationResult[] = [];
      for (const result of results) {
        const { job, status } = result;
        const updated = status === 'published' ? this.publicationComplete(job.token_id, job.attempts + 1, job.claim_id)
          : this.publicationFailed(job.token_id, now, job.attempts, status === 'conflict', job.attempts + 1, job.claim_id);
        if (updated) applied.push(result);
      }
      return applied;
    });
  }

  publicationComplete(tokenId: string, expectedAttempts?: number, expectedClaimId?: string): boolean {
    return this.sql.exec(`UPDATE publication SET status='published',last_error=NULL,claim_id=NULL WHERE token_id=?${
      expectedAttempts === undefined ? '' : " AND status='pending' AND attempts=? AND claim_id IS ?"} RETURNING token_id`,
      tokenId, ...(expectedAttempts === undefined ? [] : [expectedAttempts, expectedClaimId ?? null])).toArray().length > 0;
  }

  publicationFailed(tokenId: string, now: number, attempts: number, conflict = false, expectedAttempts?: number, expectedClaimId?: string): boolean {
    return this.sql.exec(`UPDATE publication SET status=?,last_error=?,next_check_ms=?,claim_id=NULL WHERE token_id=?${
      expectedAttempts === undefined ? '' : " AND status='pending' AND attempts=? AND claim_id IS ?"} RETURNING token_id`,
      conflict ? 'conflict' : 'pending', conflict ? 'metadata-conflict' : 'publication-unavailable',
      now + Math.min(300_000, 1_000 * 2 ** Math.min(attempts + 1, 8)), tokenId,
      ...(expectedAttempts === undefined ? [] : [expectedAttempts, expectedClaimId ?? null])).toArray().length > 0;
  }

  publicationError(): 'metadata-conflict' | 'publication-unavailable' | null {
    if (this.sql.exec<{ found: number }>("SELECT 1 AS found FROM publication WHERE status='conflict' LIMIT 1").toArray().length) return 'metadata-conflict';
    return this.sql.exec<{ found: number }>("SELECT 1 AS found FROM publication WHERE status='pending' AND last_error IS NOT NULL LIMIT 1")
      .toArray().length ? 'publication-unavailable' : null;
  }

  nextWake(now: number): number | null {
    const recovery = this.recovery.nextWake(now);
    const publication = this.sql.exec<{ due: number | null }>("SELECT MIN(next_check_ms) AS due FROM publication WHERE status='pending'").toArray()[0]?.due;
    const times = [recovery, publication].filter((value): value is number => value != null);
    return times.length ? Math.max(now + 250, Math.min(...times)) : null;
  }

  summary() {
    const row = this.sql.exec<{ reserved: number; frozen: number }>(`SELECT
      COALESCE(SUM(token_id IS NULL),0) AS reserved,COALESCE(SUM(token_id IS NOT NULL),0) AS frozen FROM assignments`).toArray()[0];
    const publication = this.sql.exec<{ status: string; count: number }>('SELECT status,COUNT(*) AS count FROM publication GROUP BY status').toArray();
    return { ready: this.ready(), seeded: this.pools().reduce((sum, pool) => sum + pool.seeded, 0),
      available: this.pools().reduce((sum, pool) => sum + pool.available, 0), ...row,
      publication: Object.fromEntries(publication.map(value => [value.status, value.count])), recovery: this.recovery.summary() };
  }
}
