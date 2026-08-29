import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import type {
  CommerceDocumentData,
  CommerceDocumentKey,
  CommerceTimestamp,
} from '../src/commerceRepository.ts';

class PreparedStatement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly observeStatement?: CommerceD1StatementObserver,
    private readonly observeCall?: CommerceD1CallObserver,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const statement = new PreparedStatement(
      this.database,
      this.sql,
      this.observeStatement,
      this.observeCall,
    );
    statement.values = values as SQLInputValue[];
    return statement as unknown as D1PreparedStatement;
  }

  async first<T>(): Promise<T | null> {
    this.observeCall?.({ method: 'first', sql: this.sql });
    const result = (this.statement().get(...this.values) as T | undefined) ?? null;
    this.observeStatement?.({ method: 'first', sql: this.sql });
    return result;
  }

  async all<T>(): Promise<D1Result<T>> {
    this.observeCall?.({ method: 'all', sql: this.sql });
    const result: D1Result<T> = {
      success: true,
      results: this.statement().all(...this.values) as T[],
      meta: {} as D1Meta & Record<string, unknown>,
    };
    this.observeStatement?.({ method: 'all', sql: this.sql });
    return result;
  }

  async run<T>(): Promise<D1Result<T>> {
    this.observeCall?.({ method: 'run', sql: this.sql });
    return this.runInBatch<T>();
  }

  async runInBatch<T>(): Promise<D1Result<T>> {
    const statement = this.statement();
    let result: D1Result<T>;
    if (statement.columns().length) {
      result = {
        success: true,
        results: statement.all(...this.values) as T[],
        meta: {} as D1Meta & Record<string, unknown>,
      };
    } else {
      const execution = statement.run(...this.values);
      result = {
        success: true,
        results: [],
        meta: {
          changes: Number(execution.changes),
          last_row_id: Number(execution.lastInsertRowid),
        } as D1Meta & Record<string, unknown>,
      };
    }
    this.observeStatement?.({ method: 'run', sql: this.sql });
    return result;
  }

  batchObservation(): CommerceD1BatchStatementObservation {
    return { sql: this.sql };
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

export type CommerceD1StatementObservation = Readonly<{
  method: 'all' | 'first' | 'run';
  sql: string;
}>;

export type CommerceD1StatementObserver = (observation: CommerceD1StatementObservation) => void;

export type CommerceD1BatchStatementObservation = Readonly<{
  sql: string;
}>;

export type CommerceD1BatchObservation = Readonly<{
  statements: readonly CommerceD1BatchStatementObservation[];
}>;

export type CommerceD1BatchObserver = (observation: CommerceD1BatchObservation) => void;

export type CommerceD1CallObservation =
  | CommerceD1StatementObservation
  | Readonly<{
    method: 'batch';
    statements: readonly CommerceD1BatchStatementObservation[];
  }>;

export type CommerceD1CallObserver = (observation: CommerceD1CallObservation) => void;

export type CommerceD1Harness = {
  database: DatabaseSync;
  db: D1Database;
};

export function d1Database(
  database: DatabaseSync,
  observeStatement?: CommerceD1StatementObserver,
  observeBatchAfterCommit?: CommerceD1BatchObserver,
  observeCall?: CommerceD1CallObserver,
): D1Database {
  return {
    prepare: (sql: string) => new PreparedStatement(
      database,
      sql,
      observeStatement,
      observeCall,
    ) as unknown as D1PreparedStatement,
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const preparedStatements = statements.map((statement) => {
        if (!(statement instanceof PreparedStatement)) throw new TypeError('Invalid commerce D1 statement.');
        return statement;
      });
      const observation = {
        statements: preparedStatements.map((statement) => statement.batchObservation()),
      };
      observeCall?.({ method: 'batch', ...observation });
      const results: D1Result<T>[] = [];
      database.exec('BEGIN');
      try {
        for (const statement of preparedStatements) results.push(await statement.runInBatch<T>());
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      observeBatchAfterCommit?.(observation);
      return results;
    },
  } as unknown as D1Database;
}

export function createCommerceD1Harness(
  options: Readonly<{
    observeBatchAfterCommit?: CommerceD1BatchObserver;
    observeCall?: CommerceD1CallObserver;
    observeStatement?: CommerceD1StatementObserver;
  }> = {},
): CommerceD1Harness {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync('cloud/workers/api/commerce-migrations/0001_current_schema.sql', 'utf8'));
  database.exec(readFileSync('cloud/workers/api/commerce-migrations/0002_authority_control_lease.sql', 'utf8'));
  database.exec(readFileSync('cloud/workers/api/commerce-migrations/0003_wipe_readiness_guard.sql', 'utf8'));
  database.exec(readFileSync('cloud/workers/api/commerce-migrations/0004_ready_notification_owner_indexes.sql', 'utf8'));
  database.exec(readFileSync('cloud/workers/api/commerce-migrations/0005_delivery_owner_query_revisions.sql', 'utf8'));
  return {
    database,
    db: d1Database(
      database,
      options.observeStatement,
      options.observeBatchAfterCommit,
      options.observeCall,
    ),
  };
}

export function createCommerceD1(): D1Database {
  return createCommerceD1Harness().db;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeLegacyFirestoreFixtureValue(value: unknown): unknown {
  if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
  if (Object.hasOwn(value, 'nullValue')) return null;
  if (typeof value.booleanValue === 'boolean') return value.booleanValue;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.timestampValue === 'string') {
    const milliseconds = Date.parse(value.timestampValue);
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  if (typeof value.integerValue === 'string' && /^-?\d+$/.test(value.integerValue)) {
    const integer = Number(value.integerValue);
    return Number.isSafeInteger(integer) ? integer : value.integerValue;
  }
  if (typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue)) return value.doubleValue;
  if (typeof value.bytesValue === 'string') return value.bytesValue;
  if (typeof value.referenceValue === 'string') return value.referenceValue;
  if (isRecord(value.arrayValue)) {
    if (value.arrayValue.values === undefined) return [];
    if (!Array.isArray(value.arrayValue.values)) return undefined;
    const decoded = value.arrayValue.values.map(decodeLegacyFirestoreFixtureValue);
    return decoded.some((entry) => entry === undefined) ? undefined : decoded;
  }
  if (isRecord(value.mapValue)) {
    if (value.mapValue.fields === undefined) return {};
    if (!isRecord(value.mapValue.fields)) return undefined;
    const decoded: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value.mapValue.fields)) {
      const result = decodeLegacyFirestoreFixtureValue(entry);
      if (result === undefined) return undefined;
      decoded[key] = result;
    }
    return decoded;
  }
  return undefined;
}

export function decodeLegacyFirestoreFixtureFields(fields: unknown): Record<string, unknown> | null {
  if (!isRecord(fields)) return null;
  const decoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(fields)) {
    const result = decodeLegacyFirestoreFixtureValue(entry);
    if (result === undefined) return null;
    decoded[key] = result;
  }
  return decoded;
}

export type CommerceDocumentSeed = {
  key: CommerceDocumentKey;
  data: CommerceDocumentData;
  version?: number;
  createTime?: string;
  updateTime?: string;
  processedAt?: CommerceTimestamp | null;
};

export type CommerceDocumentFixtureMutation =
  | Readonly<{ type: 'upsert'; seed: CommerceDocumentSeed }>
  | Readonly<{ type: 'delete'; key: CommerceDocumentKey }>;

function writeCommerceDocument(
  harness: CommerceD1Harness,
  seed: CommerceDocumentSeed,
): void {
  const updateTime = seed.updateTime || '2026-01-01T00:00:00.000Z';
  const createTime = seed.createTime || updateTime;
  const version = seed.version ?? 1;
  harness.database.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json,
    version, create_time, update_time, processed_at_seconds, processed_at_nanos
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(document_path) DO UPDATE SET
    document_kind = excluded.document_kind,
    drop_id = excluded.drop_id,
    document_id = excluded.document_id,
    document_json = excluded.document_json,
    version = excluded.version,
    create_time = excluded.create_time,
    update_time = excluded.update_time,
    processed_at_seconds = excluded.processed_at_seconds,
    processed_at_nanos = excluded.processed_at_nanos`).run(
    seed.key.path,
    seed.key.kind,
    seed.key.dropId,
    seed.key.documentId,
    JSON.stringify(seed.data),
    version,
    createTime,
    updateTime,
    seed.processedAt?.seconds ?? null,
    seed.processedAt?.nanos ?? null,
  );
}

export function applyCommerceDocumentFixtureEpoch(
  harness: CommerceD1Harness,
  mutations: readonly CommerceDocumentFixtureMutation[],
): void {
  if (!mutations.length) throw new TypeError('A commerce fixture epoch requires at least one mutation.');
  harness.database.exec('BEGIN');
  try {
    for (const mutation of mutations) {
      if (mutation.type === 'upsert') writeCommerceDocument(harness, mutation.seed);
      else harness.database.prepare('DELETE FROM commerce_documents WHERE document_path = ?').run(mutation.key.path);
    }
    harness.database.exec(`UPDATE commerce_authority_control
      SET documents_revision = documents_revision + 1,
        updated_at_ms = updated_at_ms + 1
      WHERE singleton = 1`);
    const invalid = harness.database.prepare(`SELECT EXISTS (
      SELECT 1
      FROM commerce_delivery_owner_revisions AS owner_revision
      JOIN commerce_authority_control AS control ON control.singleton = 1
      WHERE owner_revision.revision > control.documents_revision
    ) AS invalid`).get()!.invalid;
    if (invalid) throw new Error('Commerce fixture owner revision exceeds the global revision.');
    harness.database.exec('COMMIT');
  } catch (error) {
    harness.database.exec('ROLLBACK');
    throw error;
  }
}

export function seedCommerceDocuments(
  harness: CommerceD1Harness,
  seeds: readonly CommerceDocumentSeed[],
): void {
  applyCommerceDocumentFixtureEpoch(
    harness,
    seeds.map((seed) => ({ type: 'upsert', seed })),
  );
}

export function seedCommerceDocument(
  harness: CommerceD1Harness,
  seed: CommerceDocumentSeed,
): void {
  seedCommerceDocuments(harness, [seed]);
}
