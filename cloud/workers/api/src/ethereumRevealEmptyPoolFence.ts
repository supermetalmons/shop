import type { RevealSql } from './ethereumRevealStore.js';

export const ETHEREUM_REVEAL_EMPTY_POOL_DRAIN_MS = 65_000;
const FENCES = 'reveal_empty_pool_fences';
const TABLES = ['settings', 'reveal_migrations', 'pools', 'free_slots', 'crates', 'assignments', 'transactions',
  'crate_recovery_trackers', 'replacement_candidates', 'replacement_chunks', 'observations', 'publication',
  'recovery_jobs', 'token_recovery', 'provenance', 'reveal_enrichment', 'reveal_enrichment_acknowledgments',
  'reveal_recovery_migration', 'crate_recovery_jobs', 'receipt_work', 'reveal_dispatch_control',
  'reveal_overflow_claims', 'crate_candidates', 'receipt_claim_crates', 'receipt_token_interest', 'receipt_claim_tokens',
  'reveal_catalog_generations', 'reveal_catalog_mappings', 'reveal_catalog_pools', 'reveal_catalog_free', 'reveal_catalog_publications'];

export type EthereumRevealEmptyPoolFenceScope = {
  operationId: string; deploymentId: string; batchSha256: string; expectedRevision: number;
};
export type EthereumRevealEmptyPoolFenceState = EthereumRevealEmptyPoolFenceScope & {
  acquiredAtMs: number; drainUntilMs: number; releasedAtMs: number | null;
};
export type EthereumRevealEmptyPoolProof = {
  fence: EthereumRevealEmptyPoolFenceState; checkedAtMs: number; drained: boolean; ready: boolean;
  empty: boolean; counts: Record<string, number>;
};
type FenceRow = { operation_id: string; deployment_id: string; batch_sha256: string; expected_revision: number;
  acquired_at_ms: number; drain_until_ms: number; released_at_ms: number | null; bypass: number };

function validateScope(scope: EthereumRevealEmptyPoolFenceScope): void {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(scope.operationId) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(scope.deploymentId) ||
    !/^[a-f0-9]{64}$/.test(scope.batchSha256) || !Number.isSafeInteger(scope.expectedRevision) || scope.expectedRevision < 1) {
    throw new Error('Invalid empty-pool fence scope.');
  }
}

function validateTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + ETHEREUM_REVEAL_EMPTY_POOL_DRAIN_MS)) {
    throw new Error('Invalid empty-pool fence time.');
  }
}

function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error('Unsupported reveal ledger table name.');
  return `"${value}"`;
}

function synchronous<T>(action: () => T): T {
  const value = action();
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
    throw new Error('Empty-pool rebuild transactions must be synchronous.');
  }
  return value;
}

export class EthereumRevealEmptyPoolFence {
  private transactionDepth = 0;
  private rebuildDepth = 0;
  private triggerSchema: string | null = null;

  constructor(private readonly sql: RevealSql, private readonly transaction: <T>(action: () => T) => T) {}

  private atomic<T>(action: () => T): T {
    if (this.transactionDepth) return synchronous(action);
    return this.transaction(() => {
      this.transactionDepth++;
      try { return synchronous(action); } finally { this.transactionDepth--; }
    });
  }

  private tables(): string[] {
    return this.sql.exec<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .toArray().map(row => row.name).filter(name => name !== FENCES &&
        !name.toLowerCase().startsWith('sqlite_') && !name.toLowerCase().startsWith('_cf_'));
  }

  private installTriggers(): void {
    const schema = () => JSON.stringify(this.sql.exec<{ type: string; name: string; tbl_name: string }>(
      "SELECT type,name,tbl_name FROM sqlite_schema WHERE type='table' OR (type='trigger' AND name GLOB 'reveal_empty_fence_*') ORDER BY type,name").toArray());
    if (schema() === this.triggerSchema) return;
    for (const table of this.tables()) for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const trigger = identifier(`reveal_empty_fence_${table}_${event.toLowerCase()}`);
      try {
        this.sql.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger} BEFORE ${event} ON ${identifier(table)}
          WHEN EXISTS(SELECT 1 FROM ${FENCES} WHERE released_at_ms IS NULL AND bypass=0)
          BEGIN SELECT RAISE(ABORT,'Reveal writes are fenced for empty-pool rebuild'); END`);
      } catch (error) {
        throw new Error(`Empty-pool fence trigger failed for ${table.slice(0, 128)} ${event}.`, { cause: error });
      }
    }
    this.triggerSchema = schema();
  }

  initialize(): void {
    this.atomic(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ${FENCES} (operation_id TEXT PRIMARY KEY,deployment_id TEXT NOT NULL,
        batch_sha256 TEXT NOT NULL,expected_revision INTEGER NOT NULL,acquired_at_ms INTEGER NOT NULL,
        drain_until_ms INTEGER NOT NULL,released_at_ms INTEGER,bypass INTEGER NOT NULL DEFAULT 0 CHECK(bypass IN (0,1)),
        singleton INTEGER NOT NULL DEFAULT 1 CHECK(singleton=1),CHECK(released_at_ms IS NULL OR bypass=0))`);
      this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS reveal_empty_pool_one_fence ON ${FENCES}(singleton) WHERE released_at_ms IS NULL`);
      this.installTriggers();
    });
  }

  private exists(): boolean {
    return this.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", FENCES).toArray().length === 1;
  }

  private state(row: FenceRow): EthereumRevealEmptyPoolFenceState {
    if (row.bypass !== 0 && !this.rebuildDepth) throw new Error('Empty-pool fence bypass escaped its transaction.');
    return { operationId: row.operation_id, deploymentId: row.deployment_id, batchSha256: row.batch_sha256,
      expectedRevision: row.expected_revision, acquiredAtMs: row.acquired_at_ms, drainUntilMs: row.drain_until_ms,
      releasedAtMs: row.released_at_ms };
  }

  status(): EthereumRevealEmptyPoolFenceState | null {
    if (!this.exists()) return null;
    const row = this.sql.exec<FenceRow>(`SELECT * FROM ${FENCES} WHERE released_at_ms IS NULL`).toArray()[0];
    return row ? this.state(row) : null;
  }

  inspect(scope: EthereumRevealEmptyPoolFenceScope): EthereumRevealEmptyPoolFenceState | null {
    validateScope(scope);
    if (!this.exists()) return null;
    const row = this.sql.exec<FenceRow>(`SELECT * FROM ${FENCES} WHERE operation_id=?`, scope.operationId).toArray()[0];
    if (!row) return null;
    const state = this.state(row);
    if (state.deploymentId !== scope.deploymentId || state.batchSha256 !== scope.batchSha256 || state.expectedRevision !== scope.expectedRevision) {
      throw new Error('Empty-pool fence identity or original revision changed.');
    }
    return state;
  }

  private active(scope: EthereumRevealEmptyPoolFenceScope): EthereumRevealEmptyPoolFenceState {
    const state = this.inspect(scope);
    if (!state || state.releasedAtMs !== null) throw new Error('The empty-pool rebuild does not own an active fence.');
    return state;
  }

  assertWritable(): void {
    if (this.status()) throw new Error('Reveal writes are fenced for empty-pool rebuild.');
  }

  acquire(scope: EthereumRevealEmptyPoolFenceScope, now: number): EthereumRevealEmptyPoolFenceState {
    validateScope(scope);
    validateTime(now);
    return this.atomic(() => {
      this.initialize();
      const previous = this.inspect(scope);
      if (previous) {
        if (previous.releasedAtMs !== null) throw new Error('A released empty-pool operation cannot be reacquired.');
        return previous;
      }
      if (this.status()) throw new Error('Another empty-pool rebuild owns the writer fence.');
      const settings = this.sql.exec<{ deployment_json: string }>('SELECT deployment_json FROM settings WHERE id=1').toArray()[0];
      if (!settings || JSON.parse(settings.deployment_json).deploymentId !== scope.deploymentId) {
        throw new Error('Empty-pool fence does not match the initialized deployment.');
      }
      this.sql.exec(`INSERT INTO ${FENCES}(operation_id,deployment_id,batch_sha256,expected_revision,acquired_at_ms,drain_until_ms)
        VALUES(?,?,?,?,?,?)`, scope.operationId, scope.deploymentId, scope.batchSha256, scope.expectedRevision,
      now, now + ETHEREUM_REVEAL_EMPTY_POOL_DRAIN_MS);
      return this.active(scope);
    });
  }

  withRebuild<T>(scope: EthereumRevealEmptyPoolFenceScope, action: () => T): T {
    return this.atomic(() => {
      this.active(scope);
      if (this.rebuildDepth) return synchronous(action);
      this.sql.exec(`UPDATE ${FENCES} SET bypass=1 WHERE operation_id=? AND released_at_ms IS NULL`, scope.operationId);
      this.rebuildDepth++;
      try {
        const value = synchronous(action);
        this.installTriggers();
        return value;
      } finally {
        try { this.sql.exec(`UPDATE ${FENCES} SET bypass=0 WHERE operation_id=?`, scope.operationId); }
        finally { this.rebuildDepth--; }
      }
    });
  }

  inspectEmpty(scope: EthereumRevealEmptyPoolFenceScope, now: number): EthereumRevealEmptyPoolProof {
    validateTime(now);
    const fence = this.active(scope);
    const tables = new Set(this.tables());
    if (TABLES.some(table => !tables.has(table))) throw new Error('Empty-pool proof requires the complete initialized reveal schema.');
    const counts: Record<string, number> = {};
    const count = (name: string, table: string, where = '', values: Array<string | number> = []) => {
      counts[name] = this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${identifier(table)} ${where}`, ...values).toArray()[0].count;
    };
    for (const table of ['assignments', 'crates', 'publication', 'reveal_enrichment', 'reveal_enrichment_acknowledgments',
      'crate_recovery_trackers', 'replacement_candidates', 'observations', 'provenance', 'recovery_jobs',
      'crate_recovery_jobs', 'reveal_overflow_claims', 'crate_candidates', 'receipt_claim_crates', 'receipt_token_interest',
      'receipt_claim_tokens', 'reveal_catalog_publications']) count(table, table);
    count('reserved', 'assignments', 'WHERE token_id IS NULL');
    count('frozen', 'assignments', 'WHERE token_id IS NOT NULL');
    count('pendingTransactions', 'transactions', "WHERE status NOT IN ('reverted','not_unpack') OR lease_until_ms>?", [now]);
    count('pendingReplacementChunks', 'replacement_chunks', 'WHERE completed=0');
    count('pendingTokens', 'token_recovery', "WHERE status!='unminted' OR job_id IS NOT NULL");
    count('pendingReceipts', 'receipt_work', 'WHERE resolved=0 OR request_pending!=0 OR legacy_pending!=0 OR claim_id IS NOT NULL OR claim_active!=0 OR lease_until_ms>?', [now]);
    count('pendingCatalogs', 'reveal_catalog_generations', "WHERE phase NOT IN ('complete','cancelled') AND batch_id!=?", [scope.operationId]);
    count('foreignCandidate', 'settings', 'WHERE candidate_catalog_generation IS NOT NULL AND candidate_catalog_generation!=?', [scope.operationId]);
    const settings = this.sql.exec<{ ready: number; deployment_json: string }>('SELECT ready,deployment_json FROM settings WHERE id=1').toArray()[0];
    const migration = this.sql.exec<{ phase: string }>('SELECT phase FROM reveal_recovery_migration WHERE id=1').toArray()[0];
    const ready = settings?.ready === 1 && JSON.parse(settings.deployment_json).deploymentId === scope.deploymentId && migration?.phase === 'ready';
    return { fence, checkedAtMs: now, drained: now >= fence.drainUntilMs, ready,
      empty: Object.values(counts).every(value => value === 0), counts };
  }

  assertEmpty(scope: EthereumRevealEmptyPoolFenceScope, now: number): EthereumRevealEmptyPoolProof {
    const proof = this.inspectEmpty(scope, now);
    if (!proof.drained) throw new Error('Empty-pool writer drain has not completed.');
    if (!proof.ready || !proof.empty) throw new Error(`Reveal ledger is not empty and ready for rebuild: ${JSON.stringify(proof.counts)}`);
    return proof;
  }

  release(scope: EthereumRevealEmptyPoolFenceScope, now: number): EthereumRevealEmptyPoolFenceState {
    validateTime(now);
    return this.atomic(() => {
      const previous = this.inspect(scope);
      if (!previous) throw new Error('Unknown empty-pool fence.');
      if (previous.releasedAtMs !== null) return previous;
      this.assertEmpty(scope, now);
      this.sql.exec(`UPDATE ${FENCES} SET bypass=0,released_at_ms=? WHERE operation_id=? AND released_at_ms IS NULL`, now, scope.operationId);
      return this.inspect(scope)!;
    });
  }

  abort(scope: EthereumRevealEmptyPoolFenceScope, now: number): EthereumRevealEmptyPoolFenceState {
    validateTime(now);
    return this.atomic(() => {
      const previous = this.inspect(scope);
      if (!previous) throw new Error('Unknown empty-pool fence.');
      if (previous.releasedAtMs !== null) return previous;
      if (now < previous.drainUntilMs) throw new Error('Empty-pool writer drain has not completed.');
      if (this.tables().includes('reveal_catalog_generations') && this.sql.exec(`SELECT 1 FROM reveal_catalog_generations
        WHERE batch_id=? AND activated_at_ms IS NOT NULL`, scope.operationId).toArray().length) {
        throw new Error('An activated empty-pool rebuild cannot be aborted.');
      }
      this.sql.exec(`UPDATE ${FENCES} SET bypass=0,released_at_ms=? WHERE operation_id=? AND released_at_ms IS NULL`, now, scope.operationId);
      return this.inspect(scope)!;
    });
  }
}
