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
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const statement = new PreparedStatement(this.database, this.sql);
    statement.values = values as SQLInputValue[];
    return statement as unknown as D1PreparedStatement;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement().get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.statement().all(...this.values) as T[],
      meta: {} as D1Meta & Record<string, unknown>,
    };
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.statement().run(...this.values);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      } as D1Meta & Record<string, unknown>,
    };
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

export type CommerceD1Harness = {
  database: DatabaseSync;
  db: D1Database;
};

export function d1Database(database: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new PreparedStatement(database, sql) as unknown as D1PreparedStatement,
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run<T>());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

export function createCommerceD1Harness(): CommerceD1Harness {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync('cloud/workers/api/commerce-migrations/0001_current_schema.sql', 'utf8'));
  database.exec(readFileSync('cloud/workers/api/commerce-migrations/0002_authority_control_lease.sql', 'utf8'));
  database.exec(readFileSync('cloud/workers/api/commerce-migrations/0003_wipe_readiness_guard.sql', 'utf8'));
  return { database, db: d1Database(database) };
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

export function seedCommerceDocument(
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
