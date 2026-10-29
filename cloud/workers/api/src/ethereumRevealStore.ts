import type { EthereumArtworkCategory, EthereumRevealedArtwork, EthereumRevealObservation,
  EthereumRevealTransactionResponse } from '../../../../shared/ethereum/reveal.js';
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
  token_id: string; metadata_json: string; placeholder_json: string; attempts: number;
};
export type RevealSearchRange = { fromBlock: number; toBlock?: number };
export type RevealRecoveryJob = { id: string; token_ids_json: string; ranges_json: string; attempts: number; next_check_ms: number };
type RevealReplacementChunk = { chunk_index: number; crate_ids_json: string; from_block: number;
  ranges_json: string; generation: number; completed: number; checked_at_ms: number };

const REVEAL_TRANSIENT_TRANSACTION_LIMIT = 10_000;
const REVEAL_TRANSIENT_TRANSACTION_TTL_MS = 15 * 60_000;

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
  `CREATE TABLE IF NOT EXISTS replacement_candidates (original_hash TEXT NOT NULL REFERENCES transactions(hash),
    transaction_hash TEXT NOT NULL, crate_token_id TEXT NOT NULL, checked_at_ms INTEGER NOT NULL DEFAULT 0,
    verified_at_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(original_hash,transaction_hash,crate_token_id))`,
  `CREATE INDEX IF NOT EXISTS replacement_candidate_transaction ON replacement_candidates(transaction_hash)`,
  `CREATE TABLE IF NOT EXISTS replacement_chunks (original_hash TEXT NOT NULL REFERENCES transactions(hash),
    chunk_index INTEGER NOT NULL, crate_ids_json TEXT NOT NULL, from_block INTEGER NOT NULL,
    ranges_json TEXT NOT NULL DEFAULT '[]', generation INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
    checked_at_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(original_hash,chunk_index))`,
  `CREATE TABLE IF NOT EXISTS observations (transaction_hash TEXT NOT NULL, block_hash TEXT NOT NULL, crate_token_id TEXT NOT NULL,
    block_number INTEGER NOT NULL, token_ids_json TEXT NOT NULL, PRIMARY KEY(transaction_hash,block_hash,crate_token_id))`,
  `CREATE TABLE IF NOT EXISTS publication (token_id TEXT PRIMARY KEY REFERENCES assignments(token_id),
    status TEXT NOT NULL DEFAULT 'pending', next_check_ms INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`,
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

function parsedJson(value: string | null): unknown {
  try { return value === null ? null : JSON.parse(value); } catch { return null; }
}

function isObservation(value: unknown, hash: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const observation = value as Partial<EthereumRevealObservation>;
  return observation.transactionHash === hash && typeof observation.blockHash === 'string' &&
    /^0x[0-9a-f]{64}$/.test(observation.blockHash) && Number.isSafeInteger(observation.blockNumber) && observation.blockNumber! >= 0;
}

function hasRecentFailure(job: RevealTransactionJob): boolean {
  const value = parsedJson(job.failure_json);
  if (!value || typeof value !== 'object') return false;
  const failure = value as { status?: string; confirmations?: number; observation?: unknown };
  return (failure.status === 'reverted' || failure.status === 'not_unpack') && Number.isSafeInteger(failure.confirmations) &&
    failure.confirmations! >= 1 && failure.confirmations! < 64 && isObservation(failure.observation, job.hash);
}

function hasRevealScope(job: RevealTransactionJob): boolean {
  const crates = parsedJson(job.crates_json), mappings = parsedJson(job.tokens_json);
  return Array.isArray(crates) && crates.some(id => typeof id === 'string' && /^\d+$/.test(id) &&
    Number(id) >= 111_112 && Number(id) <= 116_666) ||
    Array.isArray(mappings) && mappings.some(value => value && typeof value === 'object' &&
      typeof value.tokenId === 'string' && /^[1-9]\d*$/.test(value.tokenId) && Number(value.tokenId) <= REVEAL_ARTWORK_COUNT) ||
    isObservation(parsedJson(job.observation_json), job.hash);
}

export class EthereumRevealStore {
  constructor(private readonly sql: RevealSql, private readonly transaction: <T>(action: () => T) => T,
    private readonly randomInteger: (maximum: number) => number = revealRandomInteger) {
    this.transaction(() => {
      for (const statement of SCHEMA) this.sql.exec(statement);
      const columns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(transactions)').toArray().map(row => row.name));
      for (const [name, definition] of [['tracking_generation', 'INTEGER NOT NULL DEFAULT 0'],
        ['receipt_seen', 'INTEGER NOT NULL DEFAULT 0'], ['failure_json', 'TEXT'], ['incarnation', "TEXT NOT NULL DEFAULT ''"],
        ['transient', 'INTEGER NOT NULL DEFAULT 1'], ['admission_expires_at_ms', 'INTEGER NOT NULL DEFAULT 0']]) {
        if (!columns.has(name)) this.sql.exec(`ALTER TABLE transactions ADD COLUMN ${name} ${definition}`);
      }
      this.sql.exec(`CREATE INDEX IF NOT EXISTS transient_transactions_expiry
        ON transactions(admission_expires_at_ms,hash) WHERE transient=1`);
      this.sql.exec('CREATE TABLE IF NOT EXISTS transaction_admission_count (id INTEGER PRIMARY KEY CHECK(id=1), count INTEGER NOT NULL CHECK(count>=0))');
      if (!this.sql.exec('SELECT id FROM transaction_admission_count WHERE id=1').toArray().length) {
        this.sql.exec('INSERT INTO transaction_admission_count(id,count) SELECT 1,COUNT(*) FROM transactions WHERE transient=1');
      }
      this.sql.exec(`CREATE TRIGGER IF NOT EXISTS transient_transaction_insert AFTER INSERT ON transactions WHEN NEW.transient=1
        BEGIN UPDATE transaction_admission_count SET count=count+1 WHERE id=1; END`);
      this.sql.exec(`CREATE TRIGGER IF NOT EXISTS transient_transaction_delete AFTER DELETE ON transactions WHEN OLD.transient=1
        BEGIN UPDATE transaction_admission_count SET count=count-1 WHERE id=1; END`);
      this.sql.exec(`CREATE TRIGGER IF NOT EXISTS transient_transaction_update AFTER UPDATE OF transient ON transactions WHEN OLD.transient!=NEW.transient
        BEGIN UPDATE transaction_admission_count SET count=count+NEW.transient-OLD.transient WHERE id=1; END`);
      const cursors = this.sql.exec(`INSERT OR IGNORE INTO reveal_migrations(name) VALUES('recovery-cursors-v1') RETURNING name`).toArray().length;
      const candidates = this.sql.exec(`INSERT OR IGNORE INTO reveal_migrations(name) VALUES('replacement-candidates-v1') RETURNING name`).toArray().length;
      if (cursors || candidates) {
        this.sql.exec(`UPDATE transactions SET from_block=COALESCE((SELECT CAST(json_extract(deployment_json,'$.deploymentBlock') AS INTEGER)
          FROM settings WHERE id=1),from_block),replacement_ranges_json='[]' WHERE crates_json!='[]'`);
      }
      if (cursors) {
        this.sql.exec(`UPDATE transactions SET next_check_ms=MIN(next_check_ms,lease_until_ms)
          WHERE requested_all=1 AND revealed_all=0 AND status='revealed'`);
      }
      if (this.sql.exec(`INSERT OR IGNORE INTO reveal_migrations(name) VALUES('tracking-scope-v2') RETURNING name`).toArray().length) {
        this.sql.exec(`UPDATE transactions SET crates_json=(SELECT json_group_array(crate_token_id) FROM (
          SELECT value AS crate_token_id FROM json_each(transactions.crates_json)
          UNION SELECT crate_token_id FROM observations WHERE transaction_hash=transactions.hash
          UNION SELECT crate_token_id FROM replacement_candidates WHERE original_hash=transactions.hash
          UNION SELECT json_extract(value,'$.crateTokenId') FROM json_each(transactions.tokens_json)
          ORDER BY crate_token_id))`);
        this.sql.exec(`UPDATE transactions SET dormant=0,next_check_ms=MIN(next_check_ms,lease_until_ms),
          tracking_generation=tracking_generation+1,receipt_seen=CASE WHEN status IN ('revealed','reverted','not_unpack') THEN 1 ELSE receipt_seen END,
          from_block=COALESCE((SELECT CAST(json_extract(deployment_json,'$.deploymentBlock') AS INTEGER) FROM settings WHERE id=1),from_block),
          replacement_ranges_json='[]' WHERE crates_json!='[]' OR status IN ('reverted','not_unpack')`);
        this.sql.exec('DELETE FROM replacement_chunks');
      }
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

  freeze(deployment: EthereumRevealDeployment, observation: EthereumRevealObservation, crates: RevealCrate[], now: number,
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
      this.registerTransaction(observation.transactionHash, deployment.deploymentBlock, false);
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

  registerTransaction(hash: string, fromBlock: number, requestAll = true, verifiedCrates: string[] = []): boolean {
    const now = Date.now();
    const transient = requestAll && !verifiedCrates.length ? 1 : 0;
    if (transient && !this.transactionJob(hash) && this.transientTransactionCount() >= REVEAL_TRANSIENT_TRANSACTION_LIMIT) return false;
    this.sql.exec(`INSERT INTO transactions(hash,from_block,requested_all,created_at_ms,last_requested_at_ms,
      incarnation,transient,admission_expires_at_ms,crates_json) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(hash) DO UPDATE SET requested_all=MAX(transactions.requested_all,excluded.requested_all),
      tracking_generation=transactions.tracking_generation+CASE WHEN excluded.requested_all=1 AND
        (transactions.requested_all=0 OR transactions.dormant=1) THEN 1 ELSE 0 END,
      last_requested_at_ms=CASE WHEN excluded.requested_all=1 THEN excluded.last_requested_at_ms ELSE transactions.last_requested_at_ms END,
      dormant=CASE WHEN excluded.requested_all=1 THEN 0 ELSE transactions.dormant END,
      next_check_ms=CASE WHEN excluded.requested_all=1 AND transactions.lease_until_ms<=? AND
        (transactions.requested_all=0 OR transactions.dormant=1 OR
          (transactions.status='pending' OR transactions.status='revealed' AND transactions.revealed_all=0) AND transactions.checked_at_ms<=?)
        THEN 0 ELSE transactions.next_check_ms END`, hash, fromBlock, requestAll ? 1 : 0, now, now,
      crypto.randomUUID(), transient, transient ? now + REVEAL_TRANSIENT_TRANSACTION_TTL_MS : 0,
      JSON.stringify(verifiedCrates), now, now - 2_000);
    return true;
  }

  transientTransactionCount(): number {
    return this.sql.exec<{ count: number }>('SELECT count FROM transaction_admission_count WHERE id=1').toArray()[0].count;
  }

  cleanupTransactions(now: number, limit = 128): void {
    this.transaction(() => {
      const jobs = this.sql.exec<RevealTransactionJob>(`SELECT * FROM transactions WHERE transient=1 AND admission_expires_at_ms<=?
        ORDER BY admission_expires_at_ms,hash LIMIT ?`, now, limit).toArray();
      for (const job of jobs) {
        const tracked = hasRevealScope(job) || this.sql.exec(`SELECT 1 AS found WHERE
            EXISTS(SELECT 1 FROM observations WHERE transaction_hash=?) OR
            EXISTS(SELECT 1 FROM replacement_candidates WHERE original_hash=?) OR
            EXISTS(SELECT 1 FROM replacement_candidates WHERE transaction_hash=?) OR
            EXISTS(SELECT 1 FROM replacement_chunks WHERE original_hash=?)`, job.hash, job.hash, job.hash, job.hash).toArray().length > 0;
        if (tracked) {
          this.sql.exec('UPDATE transactions SET transient=0,admission_expires_at_ms=0 WHERE hash=?', job.hash);
          continue;
        }
        const expiry = job.admission_expires_at_ms || job.created_at_ms + REVEAL_TRANSIENT_TRANSACTION_TTL_MS;
        if (expiry > now || hasRecentFailure(job) || job.lease_until_ms > now) {
          this.sql.exec('UPDATE transactions SET admission_expires_at_ms=? WHERE hash=?',
            expiry > now ? expiry : Math.max(job.lease_until_ms, hasRecentFailure(job) ? now + 60_000 : 0), job.hash);
        } else this.sql.exec('DELETE FROM transactions WHERE hash=?', job.hash);
      }
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

  claimTransaction(hash: string, now: number): RevealTransactionJob | null {
    const job = this.transactionJob(hash);
    if (job?.transient && now >= job.created_at_ms + REVEAL_TRANSIENT_TRANSACTION_TTL_MS &&
      !hasRecentFailure(job) && !hasRevealScope(job)) return null;
    return this.sql.exec<RevealTransactionJob>(`UPDATE transactions SET next_check_ms=?,lease_until_ms=?,checked_at_ms=?,attempts=attempts+1
      WHERE hash=? AND next_check_ms<=? AND lease_until_ms<=? AND dormant=0 RETURNING *`, now + 30_000, now + 30_000, now, hash, now, now).toArray()[0] || null;
  }

  pendingTransaction(hash: string, crateTokenIds: string[] | undefined, fromBlock: number | undefined, now: number,
    generation = this.transactionJob(hash)!.tracking_generation): void {
    const job = this.transactionJob(hash)!;
    if (job.tracking_generation !== generation) return;
    if (crateTokenIds?.length) this.reserve(crateTokenIds);
    const admitted = [...new Set([...(JSON.parse(job.crates_json) as string[]), ...(crateTokenIds || [])])];
    const knownCrates = admitted.length > 0;
    const live = now - job.last_requested_at_ms < 30_000;
    const delay = live ? 2_000 : knownCrates ? 60_000 : Math.min(3_600_000, 2_000 * 2 ** Math.min(job.attempts, 11));
    const dormant = !knownCrates && !job.receipt_seen && !live && now - job.created_at_ms >= 86_400_000;
    this.sql.exec(`UPDATE transactions SET crates_json=?,from_block=?,next_check_ms=?,lease_until_ms=0,dormant=?,
      status=CASE WHEN status='revealed' THEN status ELSE 'pending' END,tracking_generation=tracking_generation+?,
      transient=CASE WHEN ? THEN 0 ELSE transient END,
      admission_expires_at_ms=CASE WHEN ? THEN 0 ELSE admission_expires_at_ms END WHERE hash=? AND tracking_generation=?`,
      JSON.stringify(admitted),
      fromBlock === undefined || job.crates_json !== '[]' ? job.from_block : Math.max(job.from_block, fromBlock),
      now + delay, dormant ? 1 : 0, admitted.length > (JSON.parse(job.crates_json) as string[]).length ? 1 : 0,
      knownCrates ? 1 : 0, knownCrates ? 1 : 0, hash, generation);
  }

  finishTransaction(hash: string, status: 'reverted' | 'not_unpack', now: number,
    evidence?: { observation: EthereumRevealObservation; confirmations: number },
    generation = this.transactionJob(hash)!.tracking_generation): void {
    const job = this.transactionJob(hash)!;
    const terminal = evidence ? evidence.confirmations >= 64 : status === 'not_unpack';
    const dormant = job.crates_json === '[]' && terminal;
    this.sql.exec(`UPDATE transactions SET status=?,next_check_ms=?,lease_until_ms=0,dormant=?,
      receipt_seen=MAX(receipt_seen,?),failure_json=COALESCE(?,failure_json) WHERE hash=? AND tracking_generation=?`,
      job.status === 'revealed' ? job.status : status, now + (terminal ? 60_000 : 15_000), dormant ? 1 : 0,
      evidence || status === 'reverted' ? 1 : 0, evidence ? JSON.stringify({ status, ...evidence }) : null, hash, generation);
  }

  retryTransaction(hash: string, now: number, delay?: number, generation = this.transactionJob(hash)!.tracking_generation): void {
    const job = this.transactionJob(hash)!;
    const unknown = job.crates_json === '[]' && job.status !== 'revealed';
    const live = now - job.last_requested_at_ms < 30_000;
    const dormant = unknown && !job.receipt_seen && !live && now - job.created_at_ms >= 86_400_000;
    const interval = delay ?? (live ? 2_000 : unknown ? Math.min(3_600_000, 2_000 * 2 ** Math.min(job.attempts, 11)) : 10_000);
    this.sql.exec('UPDATE transactions SET next_check_ms=?,lease_until_ms=0,dormant=? WHERE hash=? AND tracking_generation=?',
      now + interval, dormant ? 1 : 0, hash, generation);
  }

  dueTransactions(now: number, limit = 8): RevealTransactionJob[] {
    return this.sql.exec<RevealTransactionJob>(`SELECT * FROM transactions WHERE next_check_ms<=? AND lease_until_ms<=? AND dormant=0
      ORDER BY next_check_ms,hash LIMIT ?`, now, now, limit).toArray();
  }

  replacementChunk(hash: string, generation: number, now: number, confirmedCrates: string[] = []): RevealReplacementChunk | null {
    return this.transaction(() => {
      const job = this.transactionJob(hash)!;
      if (job.tracking_generation !== generation) return null;
      const confirmed = new Set(confirmedCrates);
      const crates = (JSON.parse(job.crates_json) as string[]).filter(crate => !confirmed.has(crate));
      const existing = this.sql.exec<RevealReplacementChunk>(
        'SELECT * FROM replacement_chunks WHERE original_hash=? ORDER BY chunk_index', hash).toArray();
      const chunks = Array.from({ length: Math.ceil(crates.length / 15) }, (_, index) => JSON.stringify(crates.slice(index * 15, index * 15 + 15)));
      if (existing.length !== chunks.length || chunks.some((chunk, index) => chunk !== existing[index]?.crate_ids_json)) {
        this.sql.exec('DELETE FROM replacement_chunks WHERE original_hash=?', hash);
        const deploymentBlock = this.identityDeploymentBlock();
        chunks.forEach((chunk, index) => this.sql.exec(`INSERT INTO replacement_chunks
          (original_hash,chunk_index,crate_ids_json,from_block,ranges_json,generation) VALUES(?,?,?,?,?,?)`,
        hash, index, chunk, existing.length ? deploymentBlock : job.from_block,
        !existing.length && chunks.length === 1 ? job.replacement_ranges_json : '[]', generation));
      } else this.sql.exec(`UPDATE replacement_chunks SET generation=?,completed=0,checked_at_ms=0
        WHERE original_hash=? AND generation!=?`, generation, hash, generation);
      const chunk = this.sql.exec<RevealReplacementChunk>(`SELECT * FROM replacement_chunks WHERE original_hash=?
        AND generation=? AND completed=0 ORDER BY checked_at_ms,chunk_index LIMIT 1`, hash, generation).toArray()[0];
      if (!chunk) return null;
      this.sql.exec('UPDATE replacement_chunks SET checked_at_ms=? WHERE original_hash=? AND chunk_index=?', now, hash, chunk.chunk_index);
      return chunk;
    });
  }

  private identityDeploymentBlock(): number {
    return this.sql.exec<{ block: number }>(`SELECT CAST(json_extract(deployment_json,'$.deploymentBlock') AS INTEGER) AS block
      FROM settings WHERE id=1`).toArray()[0].block;
  }

  replacementRanges(hash: string, ranges: RevealSearchRange[], fromBlock: number,
    generation = this.transactionJob(hash)!.tracking_generation, chunkIndex = 0): void {
    this.transaction(() => {
      if (this.transactionJob(hash)!.tracking_generation !== generation) return;
      this.sql.exec(`UPDATE replacement_chunks SET ranges_json=?,from_block=?
        WHERE original_hash=? AND chunk_index=? AND generation=?`, JSON.stringify(ranges), fromBlock, hash, chunkIndex, generation);
      if ((JSON.parse(this.transactionJob(hash)!.crates_json) as string[]).length <= 15) {
        this.sql.exec('UPDATE transactions SET replacement_ranges_json=?,from_block=? WHERE hash=?', JSON.stringify(ranges), fromBlock, hash);
      }
    });
  }

  rememberReplacementCandidates(hash: string, candidates: Array<{ transactionHash: string; crateTokenIds: string[] }>): void {
    this.transaction(() => {
      for (const candidate of candidates) for (const crate of candidate.crateTokenIds) {
        this.sql.exec(`INSERT OR IGNORE INTO replacement_candidates(original_hash,transaction_hash,crate_token_id) VALUES(?,?,?)`,
          hash, candidate.transactionHash, crate);
      }
    });
  }

  replacementCandidates(hash: string, crateTokenIds: string[]): Array<{ transactionHash: string; crateTokenIds: string[] }> {
    const selected = new Set(crateTokenIds);
    const verified = new Set(this.sql.exec<{ crate_token_id: string }>(`SELECT DISTINCT crate_token_id FROM replacement_candidates
      WHERE original_hash=? AND verified_at_ms>0`, hash).toArray().map(row => row.crate_token_id));
    const complete = crateTokenIds.every(crate => verified.has(crate));
    return this.sql.exec<{ transaction_hash: string; crates_json: string }>(`SELECT transaction_hash,json_group_array(crate_token_id) AS crates_json
      FROM replacement_candidates WHERE original_hash=? GROUP BY transaction_hash
      ORDER BY CASE WHEN ? THEN MAX(verified_at_ms) ELSE 0 END DESC,MIN(checked_at_ms),transaction_hash`, hash, complete ? 1 : 0).toArray().flatMap(row => {
      const crates = (JSON.parse(row.crates_json) as string[]).filter(crate => selected.has(crate));
      return crates.length ? [{ transactionHash: row.transaction_hash, crateTokenIds: crates }] : [];
    });
  }

  recordReplacementCheck(hash: string, transactionHash: string, verifiedCrates: string[], now: number): void {
    this.transaction(() => {
      this.sql.exec(`UPDATE replacement_candidates SET checked_at_ms=?,verified_at_ms=0 WHERE original_hash=? AND transaction_hash=?`, now, hash, transactionHash);
      for (const crate of verifiedCrates) this.sql.exec(`INSERT INTO replacement_candidates
        (original_hash,transaction_hash,crate_token_id,checked_at_ms,verified_at_ms) VALUES(?,?,?,?,?)
        ON CONFLICT(original_hash,transaction_hash,crate_token_id) DO UPDATE SET checked_at_ms=excluded.checked_at_ms,verified_at_ms=excluded.verified_at_ms`,
      hash, transactionHash, crate, now, now);
    });
  }

  completeReplacementChunk(hash: string, chunk: RevealReplacementChunk, coveredCrates: Set<string>): boolean {
    if ((JSON.parse(chunk.crate_ids_json) as string[]).some(crate => !coveredCrates.has(crate))) return false;
    return this.sql.exec<{ chunk_index: number }>(`UPDATE replacement_chunks SET completed=1
      WHERE original_hash=? AND chunk_index=? AND generation=? AND EXISTS
      (SELECT 1 FROM transactions WHERE hash=? AND tracking_generation=?) RETURNING chunk_index`,
    hash, chunk.chunk_index, chunk.generation, hash, chunk.generation).toArray().length > 0;
  }

  replacementComplete(hash: string, generation: number): boolean {
    return this.sql.exec<{ hash: string }>(`SELECT hash FROM transactions
      WHERE hash=? AND tracking_generation=? AND crates_json!='[]'
      AND EXISTS(SELECT 1 FROM replacement_chunks WHERE original_hash=transactions.hash AND generation=?)
      AND NOT EXISTS(SELECT 1 FROM replacement_chunks WHERE original_hash=transactions.hash AND (generation!=? OR completed=0))`,
    hash, generation, generation, generation).toArray().length > 0;
  }

  retireReplacedTransaction(hash: string, generation: number): boolean {
    if (!this.replacementComplete(hash, generation)) return false;
    return this.sql.exec<{ hash: string }>(`UPDATE transactions SET dormant=1,lease_until_ms=0
      WHERE hash=? AND tracking_generation=? AND NOT(requested_all=1 AND status='revealed' AND revealed_all=0)
      RETURNING hash`, hash, generation).toArray().length > 0;
  }

  knownTokens(tokenIds: string[], now: number): boolean {
    const frozen = new Set(this.frozen(tokenIds).map(value => value.tokenId));
    return tokenIds.every(id => frozen.has(id) || !!this.sql.exec<{ status: string; checked_at_ms: number }>(
      'SELECT status,checked_at_ms FROM token_recovery WHERE token_id=?', id).toArray()
      .find(row => row.status === 'recovering' || now - row.checked_at_ms < 2_000));
  }

  requestRecovery(tokenIds: string[], fromBlock: number, now: number): void {
    this.transaction(() => {
      const frozen = new Set(this.frozen(tokenIds).map(value => value.tokenId));
      const missing = tokenIds.filter(id => {
        if (frozen.has(id)) return false;
        const row = this.sql.exec<{ status: string; checked_at_ms: number }>('SELECT status,checked_at_ms FROM token_recovery WHERE token_id=?', id).toArray()[0];
        return !row || row.status !== 'recovering' && now - row.checked_at_ms >= 2_000;
      });
      for (let offset = 0; offset < missing.length; offset += 100) {
        const ids = missing.slice(offset, offset + 100);
        const id = crypto.randomUUID();
        this.sql.exec('INSERT INTO recovery_jobs(id,token_ids_json,ranges_json) VALUES(?,?,?)', id, JSON.stringify(ids), JSON.stringify([{ fromBlock }]));
        for (const tokenId of ids) this.sql.exec(`INSERT INTO token_recovery(token_id,job_id,status,checked_at_ms) VALUES(?,?,'recovering',?)
          ON CONFLICT(token_id) DO UPDATE SET job_id=excluded.job_id,status='recovering',checked_at_ms=excluded.checked_at_ms`, tokenId, id, now);
      }
    });
  }

  tokenStatus(tokenId: string): 'unminted' | 'recovering' {
    return this.sql.exec<{ status: string }>('SELECT status FROM token_recovery WHERE token_id=?', tokenId).toArray()[0]?.status === 'unminted'
      ? 'unminted' : 'recovering';
  }

  dueRecovery(now: number, limit = 4): RevealRecoveryJob[] {
    return this.sql.exec<RevealRecoveryJob>('SELECT * FROM recovery_jobs WHERE next_check_ms<=? ORDER BY next_check_ms,id LIMIT ?', now, limit).toArray();
  }

  claimRecovery(id: string, now: number): RevealRecoveryJob | null {
    return this.sql.exec<RevealRecoveryJob>(`UPDATE recovery_jobs SET next_check_ms=?,attempts=attempts+1 WHERE id=? AND next_check_ms<=? RETURNING *`,
      now + 30_000, id, now).toArray()[0] || null;
  }

  saveProvenance(observation: EthereumRevealObservation, tokenIds: string[]): void {
    this.transaction(() => {
      for (const tokenId of tokenIds) this.sql.exec(`INSERT INTO provenance(token_id,transaction_hash,block_number,block_hash) VALUES(?,?,?,?)
        ON CONFLICT(token_id) DO UPDATE SET transaction_hash=excluded.transaction_hash,block_number=excluded.block_number,block_hash=excluded.block_hash`,
      tokenId, observation.transactionHash, observation.blockNumber, observation.blockHash);
    });
  }

  provenance(tokenIds: string[]): EthereumRevealObservation[] {
    const values = new Map<string, EthereumRevealObservation>();
    for (const tokenId of tokenIds) {
      const row = this.sql.exec<{ transaction_hash: string; block_number: number; block_hash: string }>('SELECT * FROM provenance WHERE token_id=?', tokenId).toArray()[0];
      if (row) values.set(row.transaction_hash, { transactionHash: row.transaction_hash, blockNumber: row.block_number, blockHash: row.block_hash });
    }
    return [...values.values()];
  }

  discardProvenance(observation: EthereumRevealObservation): void {
    this.sql.exec('DELETE FROM provenance WHERE transaction_hash=? AND block_hash=?', observation.transactionHash, observation.blockHash);
  }

  updateRecovery(id: string, remainingIds: string[], ranges: RevealSearchRange[], unmintedIds: string[], now: number, delay = 0): void {
    this.transaction(() => {
      for (const tokenId of unmintedIds) this.sql.exec(`UPDATE token_recovery SET status='unminted',job_id=NULL,checked_at_ms=?
        WHERE token_id=? AND job_id=?`, now, tokenId, id);
      if (!remainingIds.length) {
        this.sql.exec('DELETE FROM token_recovery WHERE job_id=?', id);
        this.sql.exec('DELETE FROM recovery_jobs WHERE id=?', id);
      } else this.sql.exec('UPDATE recovery_jobs SET token_ids_json=?,ranges_json=?,next_check_ms=? WHERE id=?',
        JSON.stringify(remainingIds), JSON.stringify(ranges), now + delay, id);
    });
  }

  retryRecovery(id: string, now: number): void { this.sql.exec('UPDATE recovery_jobs SET next_check_ms=? WHERE id=?', now + 10_000, id); }

  claimPublications(now: number, limit = 8): RevealPublicationJob[] {
    return this.transaction(() => {
      const rows = this.sql.exec<RevealPublicationJob>(`SELECT p.token_id,a.metadata_json,a.placeholder_json,p.attempts FROM publication p
        JOIN assignments a ON a.token_id=p.token_id WHERE p.status='pending' AND p.next_check_ms<=?
        ORDER BY p.next_check_ms,CAST(p.token_id AS INTEGER) LIMIT ?`, now, limit).toArray();
      for (const row of rows) this.sql.exec('UPDATE publication SET next_check_ms=?,attempts=attempts+1 WHERE token_id=?', now + 60_000, row.token_id);
      return rows;
    });
  }

  publicationComplete(tokenId: string): void {
    this.sql.exec(`UPDATE publication SET status='published',last_error=NULL WHERE token_id=?`, tokenId);
  }

  publicationFailed(tokenId: string, now: number, attempts: number, conflict = false): void {
    this.sql.exec('UPDATE publication SET status=?,last_error=?,next_check_ms=? WHERE token_id=?',
      conflict ? 'conflict' : 'pending', conflict ? 'metadata-conflict' : 'publication-unavailable',
      now + Math.min(300_000, 1_000 * 2 ** Math.min(attempts + 1, 8)), tokenId);
  }

  publicationError(): 'metadata-conflict' | 'publication-unavailable' | null {
    if (this.sql.exec<{ found: number }>("SELECT 1 AS found FROM publication WHERE status='conflict' LIMIT 1").toArray().length) return 'metadata-conflict';
    return this.sql.exec<{ found: number }>("SELECT 1 AS found FROM publication WHERE status='pending' AND last_error IS NOT NULL LIMIT 1")
      .toArray().length ? 'publication-unavailable' : null;
  }

  nextWake(now: number): number | null {
    const rows = this.sql.exec<{ due: number | null }>(`SELECT MIN(due) AS due FROM (
      SELECT MIN(next_check_ms) AS due FROM transactions WHERE dormant=0 UNION ALL
      SELECT MIN(next_check_ms) AS due FROM recovery_jobs UNION ALL
      SELECT MIN(next_check_ms) AS due FROM publication WHERE status='pending' UNION ALL
      SELECT MIN(admission_expires_at_ms) AS due FROM transactions WHERE transient=1)`).toArray();
    return rows[0]?.due == null ? null : Math.max(now + 250, rows[0].due);
  }

  summary() {
    const row = this.sql.exec<{ reserved: number; frozen: number }>(`SELECT
      COALESCE(SUM(token_id IS NULL),0) AS reserved,COALESCE(SUM(token_id IS NOT NULL),0) AS frozen FROM assignments`).toArray()[0];
    const publication = this.sql.exec<{ status: string; count: number }>('SELECT status,COUNT(*) AS count FROM publication GROUP BY status').toArray();
    return { ready: this.ready(), seeded: this.pools().reduce((sum, pool) => sum + pool.seeded, 0),
      available: this.pools().reduce((sum, pool) => sum + pool.available, 0), ...row,
      publication: Object.fromEntries(publication.map(value => [value.status, value.count])) };
  }
}
