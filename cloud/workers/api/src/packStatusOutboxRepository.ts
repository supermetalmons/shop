import {
  PACK_STATUS_OUTBOX_FIELD_COLUMNS,
  packStatusOutboxRow,
  parsePackStatusOutboxRecord,
  parsePackStatusOutboxRow,
  type PackStatusOutboxMutation,
  type PackStatusOutboxRecord,
} from '../../../../shared/packStatusOutbox.js';
import { CommerceRepositoryError } from './commerceRepositoryTypes.js';
import { packStatusOutboxDueQuery } from './commerceQueries.js';
import { executeCommerceD1Batch } from './commerceD1Batch.js';

const COLUMNS = Object.values(PACK_STATUS_OUTBOX_FIELD_COLUMNS);

export function packStatusOutboxInsertStatement(db: D1Database, value: PackStatusOutboxRecord): D1PreparedStatement {
  const row = packStatusOutboxRow(value);
  return db.prepare(`INSERT INTO commerce_pack_status_outbox (${COLUMNS.join(', ')})
    VALUES (${COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(parent_path) DO NOTHING`)
    .bind(...COLUMNS.map((column) => row[column]));
}

export class PackStatusOutboxRepository {
  constructor(private readonly db: D1Database) {}

  async get(parentPath: string): Promise<PackStatusOutboxRecord | null> {
    const rows = await this.read(this.db.prepare(`SELECT ${COLUMNS.join(', ')}
      FROM commerce_pack_status_outbox WHERE parent_path = ?`).bind(parentPath));
    return rows[0] ?? null;
  }

  async queryDue(args: { dropId: string; dueAtMs: number; limit: number }): Promise<PackStatusOutboxRecord[]> {
    if (!args.dropId || !Number.isSafeInteger(args.dueAtMs) || args.dueAtMs < 0 ||
      !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid pack-status outbox query.');
    }
    const query = packStatusOutboxDueQuery(args);
    return this.read(this.db.prepare(query.sql).bind(...query.bindings));
  }

  async compareAndSet(args: {
    expected: PackStatusOutboxRecord;
    changes: PackStatusOutboxMutation;
    nowMs: number;
  }): Promise<PackStatusOutboxRecord | null> {
    const expected = parsePackStatusOutboxRecord(args.expected);
    const next = parsePackStatusOutboxRecord({ ...expected, ...args.changes,
      revision: expected.revision + 1, updatedAtMs: Math.max(expected.updatedAtMs, args.nowMs) });
    const rows = await this.read(this.db.prepare(`UPDATE commerce_pack_status_outbox SET state = ?,
      revision = ?, failure_count = ?, next_attempt_at_ms = ?, completed_at_ms = ?, failed_at_ms = ?,
      last_error_code = ?, updated_at_ms = ?
      WHERE parent_path = ? AND generation = ? AND revision = ? AND state = 'pending'
      RETURNING ${COLUMNS.join(', ')}`).bind(next.state, next.revision, next.failureCount,
      next.nextAttemptAtMs, next.completedAtMs, next.failedAtMs, next.lastErrorCode, next.updatedAtMs,
      expected.parentPath, expected.generation, expected.revision));
    return rows[0] ?? null;
  }

  private async read(statement: D1PreparedStatement): Promise<PackStatusOutboxRecord[]> {
    const results = await executeCommerceD1Batch(this.db, () => [
      this.db.prepare(`SELECT authority_state,
        (SELECT storage_mode FROM commerce_pack_status_outbox_control WHERE singleton = 1) AS storage_mode
        FROM commerce_authority_control WHERE singleton = 1`), statement,
    ], {
      invalidResult: () => new CommerceRepositoryError('unavailable', 'Pack-status outbox is unavailable.'),
      mapBatchError: (cause) => {
        const error = new CommerceRepositoryError('unavailable', 'Pack-status outbox is unavailable.');
        error.cause = cause;
        return error;
      },
    });
    if (results[0].results.length !== 1 || results[0].results[0]?.authority_state !== 'd1' ||
      results[0].results[0]?.storage_mode !== 'table') {
      throw new CommerceRepositoryError('unavailable', 'Pack-status outbox is unavailable.');
    }
    try { return results[1].results.map(parsePackStatusOutboxRow); }
    catch { throw new CommerceRepositoryError('unavailable', 'Pack-status outbox data is invalid.'); }
  }
}
