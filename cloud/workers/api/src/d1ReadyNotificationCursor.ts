import { isCanonicalReadyNotificationCursorPath } from '../../../../shared/readyToShipNotificationReconciliation.js';

const READY_NOTIFICATION_CURSOR_KEY = 'ready_notifications';

export type ReadyNotificationCursor = {
  cursorPath: string | null;
  revision: number;
};

type ReadyNotificationCursorRow = {
  control_key: unknown;
  cursor_path: unknown;
  revision: unknown;
};

function nonnegativeSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function positiveSafeInteger(value: unknown): number | null {
  const normalized = nonnegativeSafeInteger(value);
  return normalized !== null && normalized > 0 ? normalized : null;
}

function parseReadyNotificationCursor(row: ReadyNotificationCursorRow | undefined): ReadyNotificationCursor {
  if (
    !row ||
    row.control_key !== READY_NOTIFICATION_CURSOR_KEY ||
    (
      row.cursor_path !== null &&
      !isCanonicalReadyNotificationCursorPath(row.cursor_path)
    )
  ) throw new Error('invalid_ready_notification_cursor');
  const revision = positiveSafeInteger(row.revision);
  if (revision === null) throw new Error('invalid_ready_notification_cursor');
  return { cursorPath: row.cursor_path, revision };
}

function validNowMs(nowMs: number): number {
  const normalized = nonnegativeSafeInteger(nowMs);
  if (normalized === null) throw new Error('invalid_ready_notification_cursor_timestamp');
  return normalized;
}

export async function loadReadyNotificationCursor(
  db: D1Database,
  nowMs: number,
): Promise<ReadyNotificationCursor> {
  const timestamp = validNowMs(nowMs);
  const [, selected] = await db.batch<ReadyNotificationCursorRow>([
    db.prepare(
      `INSERT INTO worker_controls (
        control_key,
        cursor_path,
        revision,
        created_at_ms,
        updated_at_ms,
        cursor_updated_at_ms
      ) VALUES (?, NULL, 1, ?, ?, NULL)
      ON CONFLICT(control_key) DO NOTHING`,
    ).bind(READY_NOTIFICATION_CURSOR_KEY, timestamp, timestamp),
    db.prepare(
      `SELECT control_key, cursor_path, revision
      FROM worker_controls
      WHERE control_key = ?`,
    ).bind(READY_NOTIFICATION_CURSOR_KEY),
  ]);
  if (!selected || selected.results.length !== 1) {
    throw new Error('invalid_ready_notification_cursor');
  }
  return parseReadyNotificationCursor(selected.results[0]);
}

export async function compareAndSetReadyNotificationCursor(
  db: D1Database,
  cursorPath: string,
  expectedRevision: number,
  nowMs: number,
): Promise<boolean> {
  if (!isCanonicalReadyNotificationCursorPath(cursorPath)) {
    throw new Error('invalid_ready_notification_cursor_path');
  }
  const revision = positiveSafeInteger(expectedRevision);
  if (revision === null) throw new Error('invalid_ready_notification_cursor_revision');
  const timestamp = validNowMs(nowMs);
  const result = await db.prepare(
    `UPDATE worker_controls
    SET
      cursor_path = ?,
      revision = revision + 1,
      updated_at_ms = ?,
      cursor_updated_at_ms = ?
    WHERE control_key = ?
      AND revision = ?`,
  ).bind(
    cursorPath,
    timestamp,
    timestamp,
    READY_NOTIFICATION_CURSOR_KEY,
    revision,
  ).run();
  return result.meta.changes === 1;
}
