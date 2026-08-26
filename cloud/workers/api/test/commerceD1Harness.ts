import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { commerceDocumentIdentity } from '../src/commerceDocumentStore.ts';
import { decodeFirestoreFields } from '../src/firestoreContract.ts';
import {
  FirestoreWriteConflict,
  ProfileReadError,
  type CommerceDocumentRequest,
  type CommerceDocumentRequester,
} from '../src/firestoreRest.ts';

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

export const firestoreProviderCommerceRequester: CommerceDocumentRequester = async (args) => {
      const request = args as CommerceDocumentRequest & {
        providerFetch?: typeof fetch;
        signal?: AbortSignal;
      };
      if (!request.providerFetch) throw new Error('Commerce provider test requester is missing providerFetch');
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await request.providerFetch(request.url, {
            method: request.method,
            ...(request.body ? { body: request.body } : {}),
            signal: request.signal,
          });
        } catch {
          if (request.signal?.aborted) throw request.signal.reason;
          if (attempt === 0) continue;
          throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
        }
        if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 1) break;
        await response.body?.cancel().catch(() => undefined);
      }
      if (!response) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      if (response.status === 404 && args.method === 'GET') {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const payload = await response.json().catch(() => null);
      if (response.status === 400 || response.status === 409) {
        const error = payload && typeof payload === 'object' && 'error' in payload
          ? (payload as { error?: { status?: unknown } }).error
          : undefined;
        if (
          error?.status === 'ABORTED' ||
          error?.status === 'ALREADY_EXISTS' ||
          error?.status === 'FAILED_PRECONDITION'
        ) throw new FirestoreWriteConflict(error.status);
      }
      if (!response.ok) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      return payload;
};

export function seedCommerceDocument(
  harness: CommerceD1Harness,
  document: { fields?: Record<string, unknown>; name: string; updateTime?: string },
): void {
  const marker = '/documents/';
  const markerIndex = document.name.indexOf(marker);
  const path = markerIndex >= 0 ? document.name.slice(markerIndex + marker.length) : document.name;
  const identity = commerceDocumentIdentity(path);
  const fields = document.fields || {};
  const decoded = decodeFirestoreFields(fields);
  if (!identity || !decoded) throw new Error(`Invalid commerce test document: ${path}`);
  const updateTime = document.updateTime || '2026-01-01T00:00:00.000Z';
  harness.database.prepare(`INSERT INTO commerce_documents (
    document_path, document_kind, drop_id, document_id, fields_json, document_json,
    version, create_time, update_time
  ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  ON CONFLICT(document_path) DO UPDATE SET
    fields_json = excluded.fields_json,
    document_json = excluded.document_json,
    version = commerce_documents.version + 1,
    update_time = excluded.update_time`).run(
    path,
    identity.kind,
    identity.dropId,
    identity.documentId,
    JSON.stringify(fields),
    JSON.stringify(decoded),
    updateTime,
    updateTime,
  );
}
