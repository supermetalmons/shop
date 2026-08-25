import { isCanonicalReadyNotificationCursorPath } from '../../../../shared/readyToShipNotificationReconciliation.js';

const READY_NOTIFICATION_CONTROL_KEY = 'ready_notifications';

export type ReadyNotificationControl = {
  cursorPath: string | null;
  paused: boolean;
  revision: number;
};

type ReadyNotificationControlRow = {
  control_key: unknown;
  cursor_path: unknown;
  paused: unknown;
  revision: unknown;
};

function nonnegativeSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function positiveSafeInteger(value: unknown): number | null {
  const normalized = nonnegativeSafeInteger(value);
  return normalized !== null && normalized > 0 ? normalized : null;
}

function parseReadyNotificationControl(row: ReadyNotificationControlRow | undefined): ReadyNotificationControl {
  if (
    !row ||
    row.control_key !== READY_NOTIFICATION_CONTROL_KEY ||
    (row.paused !== 0 && row.paused !== 1) ||
    (
      row.cursor_path !== null &&
      !isCanonicalReadyNotificationCursorPath(row.cursor_path)
    )
  ) throw new Error('invalid_ready_notification_control');
  const revision = positiveSafeInteger(row.revision);
  if (revision === null) throw new Error('invalid_ready_notification_control');
  return {
    cursorPath: row.cursor_path,
    paused: row.paused === 1,
    revision,
  };
}

function validNowMs(nowMs: number): number {
  const normalized = nonnegativeSafeInteger(nowMs);
  if (normalized === null) throw new Error('invalid_ready_notification_control_timestamp');
  return normalized;
}

export async function loadReadyNotificationControl(
  db: D1Database,
  nowMs: number,
): Promise<ReadyNotificationControl> {
  const timestamp = validNowMs(nowMs);
  const [, selected] = await db.batch<ReadyNotificationControlRow>([
    db.prepare(
      `INSERT INTO worker_controls (
        control_key,
        paused,
        cursor_path,
        revision,
        created_at_ms,
        updated_at_ms,
        cursor_updated_at_ms
      ) VALUES (?, 0, NULL, 1, ?, ?, NULL)
      ON CONFLICT(control_key) DO NOTHING`,
    ).bind(READY_NOTIFICATION_CONTROL_KEY, timestamp, timestamp),
    db.prepare(
      `SELECT control_key, paused, cursor_path, revision
      FROM worker_controls
      WHERE control_key = ?`,
    ).bind(READY_NOTIFICATION_CONTROL_KEY),
  ]);
  if (!selected || selected.results.length !== 1) {
    throw new Error('invalid_ready_notification_control');
  }
  return parseReadyNotificationControl(selected.results[0]);
}

export async function compareAndSetReadyNotificationCursor(
  db: D1Database,
  cursorPath: string,
  expectedRevision: number,
  nowMs: number,
): Promise<boolean> {
  if (!isCanonicalReadyNotificationCursorPath(cursorPath)) {
    throw new Error('invalid_ready_notification_control_cursor');
  }
  const revision = positiveSafeInteger(expectedRevision);
  if (revision === null) throw new Error('invalid_ready_notification_control_revision');
  const timestamp = validNowMs(nowMs);
  const result = await db.prepare(
    `UPDATE worker_controls
    SET
      cursor_path = ?,
      revision = revision + 1,
      updated_at_ms = ?,
      cursor_updated_at_ms = ?
    WHERE control_key = ?
      AND revision = ?
      AND paused = 0`,
  ).bind(
    cursorPath,
    timestamp,
    timestamp,
    READY_NOTIFICATION_CONTROL_KEY,
    revision,
  ).run();
  return result.meta.changes === 1;
}
