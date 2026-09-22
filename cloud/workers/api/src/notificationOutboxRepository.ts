import {
  parseNotificationOutboxRecord,
  parseNotificationOutboxRow,
  type NotificationOutboxFamily,
  type NotificationOutboxMutation,
  type NotificationOutboxRecord,
} from '../../../../shared/notificationOutbox.js';
import { CommerceRepositoryError } from './commerceRepositoryTypes.js';
import { NOTIFICATION_OUTBOX_COLUMNS, notificationOutboxDueQuery } from './commerceQueries.js';

export function notificationOutboxAuthorityStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT authority_state,
    (SELECT storage_mode FROM commerce_notification_outbox_control WHERE singleton = 1) AS storage_mode
    FROM commerce_authority_control WHERE singleton = 1`);
}

export function requireNotificationOutboxAuthority(result: D1Result<Record<string, unknown>>): void {
  if (!result.success || result.results.length !== 1 || result.results[0].authority_state !== 'd1' ||
    result.results[0].storage_mode !== 'table') {
    throw new CommerceRepositoryError('unavailable', 'Notification outbox is unavailable.');
  }
}

export function notificationOutboxWriteStatement(db: D1Database, value: NotificationOutboxRecord): D1PreparedStatement {
  const row = parseNotificationOutboxRecord(value);
  return db.prepare(`INSERT INTO commerce_notification_outbox (${NOTIFICATION_OUTBOX_COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(parent_path, family) DO UPDATE SET
      generation = excluded.generation, outcome = excluded.outcome, state = excluded.state,
      entries_json = excluded.entries_json, revision = excluded.revision, attempt_count = excluded.attempt_count,
      next_attempt_at_ms = excluded.next_attempt_at_ms, claim_id = excluded.claim_id,
      claim_expires_at_ms = excluded.claim_expires_at_ms, retry_until_ms = excluded.retry_until_ms,
      created_at_ms = excluded.created_at_ms, updated_at_ms = excluded.updated_at_ms,
      last_error_code = excluded.last_error_code`).bind(
    row.parentPath, row.family, row.dropId, row.generation, row.outcome, row.state, JSON.stringify(row.entries),
    row.revision, row.attemptCount, row.nextAttemptAtMs, row.claimId, row.claimExpiresAtMs, row.retryUntilMs,
    row.createdAtMs, row.updatedAtMs, row.lastErrorCode,
  );
}

function limitValue(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid notification outbox query limit.');
  }
  return limit;
}

export class NotificationOutboxRepository {
  constructor(private readonly db: D1Database) {}

  async get(parentPath: string, family: NotificationOutboxFamily): Promise<NotificationOutboxRecord | null> {
    const rows = await this.read(this.db.prepare(`SELECT ${NOTIFICATION_OUTBOX_COLUMNS}
      FROM commerce_notification_outbox WHERE parent_path = ? AND family = ?`).bind(parentPath, family));
    return rows[0] ?? null;
  }

  async getMany(parentPaths: readonly string[], family: NotificationOutboxFamily): Promise<NotificationOutboxRecord[]> {
    const paths = [...new Set(parentPaths)];
    const rows: NotificationOutboxRecord[] = [];
    for (let offset = 0; offset < paths.length; offset += 50) {
      const batch = paths.slice(offset, offset + 50);
      rows.push(...await this.read(this.db.prepare(`SELECT ${NOTIFICATION_OUTBOX_COLUMNS}
        FROM commerce_notification_outbox WHERE family = ? AND parent_path IN (${batch.map(() => '?').join(', ')})`)
        .bind(family, ...batch)));
    }
    return rows;
  }

  async queryDue(args: { family?: NotificationOutboxFamily; dueAtMs: number; limit: number }): Promise<NotificationOutboxRecord[]> {
    limitValue(args.limit);
    if (!Number.isSafeInteger(args.dueAtMs) || args.dueAtMs < 0) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid notification outbox cutoff.');
    }
    const query = notificationOutboxDueQuery(args);
    return this.read(this.db.prepare(query.sql).bind(...query.bindings));
  }

  async compareAndSet(args: {
    expected: NotificationOutboxRecord;
    changes: NotificationOutboxMutation;
    nowMs: number;
    parentVersion?: number;
  }): Promise<NotificationOutboxRecord | null> {
    const expected = parseNotificationOutboxRecord(args.expected);
    const next = parseNotificationOutboxRecord({
      ...expected, ...args.changes, revision: expected.revision + 1,
      updatedAtMs: Math.max(expected.updatedAtMs, args.nowMs),
    });
    const rows = await this.read(this.db.prepare(`UPDATE commerce_notification_outbox SET
      state = ?, entries_json = ?, revision = ?, attempt_count = ?, next_attempt_at_ms = ?,
      claim_id = ?, claim_expires_at_ms = ?, retry_until_ms = ?, updated_at_ms = ?, last_error_code = ?
      WHERE parent_path = ? AND family = ? AND generation = ? AND revision = ? AND claim_id IS ?
        ${args.parentVersion === undefined ? '' : `AND EXISTS (
          SELECT 1 FROM commerce_documents WHERE document_path = parent_path AND version = ?
        )`}
      RETURNING ${NOTIFICATION_OUTBOX_COLUMNS}`).bind(
      next.state, JSON.stringify(next.entries), next.revision, next.attemptCount, next.nextAttemptAtMs,
      next.claimId, next.claimExpiresAtMs, next.retryUntilMs, next.updatedAtMs, next.lastErrorCode,
      expected.parentPath, expected.family, expected.generation, expected.revision, expected.claimId,
      ...(args.parentVersion === undefined ? [] : [args.parentVersion]),
    ));
    return rows[0] ?? null;
  }

  private async read(statement: D1PreparedStatement): Promise<NotificationOutboxRecord[]> {
    let results: D1Result<Record<string, unknown>>[];
    try {
      results = await this.db.batch<Record<string, unknown>>([notificationOutboxAuthorityStatement(this.db), statement]);
    } catch (error) {
      if (error instanceof Error && /notification outbox is unavailable|authority is not d1/i.test(error.message)) {
        throw new CommerceRepositoryError('unavailable', 'Notification outbox is unavailable.');
      }
      throw error;
    }
    if (results.length !== 2 || !results[1].success || !Array.isArray(results[1].results)) {
      throw new CommerceRepositoryError('unavailable', 'Notification outbox is unavailable.');
    }
    requireNotificationOutboxAuthority(results[0]);
    return results[1].results.map(parseNotificationOutboxRow);
  }
}
