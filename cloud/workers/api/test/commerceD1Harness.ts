import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { commerceKeyFromPath } from '../src/commerceRepository.ts';

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
  for (const file of readdirSync('cloud/workers/api/commerce-migrations').sort()) {
    if (file.startsWith('0009_')) {
      database.exec(`UPDATE commerce_authority_control SET
        authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
        WHERE singleton = 1`);
    }
    database.exec(readFileSync(`cloud/workers/api/commerce-migrations/${file}`, 'utf8'));
  }
  database.exec(`UPDATE commerce_authority_control SET
    authority_state = 'paused', revision = 2, paused_at_ms = 1, updated_at_ms = 1
    WHERE singleton = 1`);
  database.prepare(`INSERT INTO commerce_import_manifests (
    manifest_sha256, document_count, kind_counts_json, source_updated_at_ms, imported_at_ms, archive_object_prefix
  ) VALUES (?, 0, '{}', 1, 1, 'test')`).run('a'.repeat(64));
  database.prepare(`UPDATE commerce_authority_control SET
    authority_state = 'd1', revision = 3, cutover_at_ms = 2, paused_at_ms = NULL,
    import_manifest_sha256 = ?, updated_at_ms = 2 WHERE singleton = 1`).run('a'.repeat(64));
  return { database, db: d1Database(database) };
}

export function createCommerceD1(): D1Database {
  return createCommerceD1Harness().db;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeFixtureValue(value: unknown): unknown {
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
    const decoded = value.arrayValue.values.map(decodeFixtureValue);
    return decoded.some((entry) => entry === undefined) ? undefined : decoded;
  }
  if (isRecord(value.mapValue)) {
    if (value.mapValue.fields === undefined) return {};
    if (!isRecord(value.mapValue.fields)) return undefined;
    const decoded: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value.mapValue.fields)) {
      const result = decodeFixtureValue(entry);
      if (result === undefined) return undefined;
      decoded[key] = result;
    }
    return decoded;
  }
  return undefined;
}

export function decodeFixtureFields(fields: unknown): Record<string, unknown> | null {
  if (!isRecord(fields)) return null;
  const decoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(fields)) {
    const result = decodeFixtureValue(entry);
    if (result === undefined) return null;
    decoded[key] = result;
  }
  return decoded;
}

function processedTimestamp(fields: Record<string, unknown>): { seconds: number; nanos: number } | null {
  const value = isRecord(fields.processedAt) ? fields.processedAt.timestampValue : undefined;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}Z`) / 1000;
  return Number.isSafeInteger(seconds) && seconds >= 0
    ? { seconds, nanos: Number((match[2] || '').padEnd(9, '0')) }
    : null;
}

export function seedCommerceDocument(
  harness: CommerceD1Harness,
  document: { fields?: Record<string, unknown>; name: string; updateTime?: string },
): void {
  const marker = '/documents/';
  const markerIndex = document.name.indexOf(marker);
  const path = markerIndex >= 0 ? document.name.slice(markerIndex + marker.length) : document.name;
  const identity = commerceKeyFromPath(path);
  const fields = document.fields || {};
  const decoded = decodeFixtureFields(fields);
  if (!identity || !decoded) throw new Error(`Invalid commerce test document: ${path}`);
  const processedAt = processedTimestamp(fields);
  const updateTime = document.updateTime || '2026-01-01T00:00:00.000Z';
  harness.database.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, document_json,
    version, create_time, update_time, processed_at_seconds, processed_at_nanos
  ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  ON CONFLICT(document_path) DO UPDATE SET
    document_json = excluded.document_json,
    version = commerce_documents.version + 1,
    update_time = excluded.update_time,
    processed_at_seconds = excluded.processed_at_seconds,
    processed_at_nanos = excluded.processed_at_nanos`).run(
    path,
    identity.kind,
    identity.dropId,
    identity.documentId,
    JSON.stringify(decoded),
    updateTime,
    updateTime,
    processedAt?.seconds ?? null,
    processedAt?.nanos ?? null,
  );
}
