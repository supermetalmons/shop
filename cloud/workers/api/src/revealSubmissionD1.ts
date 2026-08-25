export type RevealSubmissionRecord = {
  owner: string;
  signature: string;
  recentBlockhash: string;
  blockhashContextSlot: number;
  dudeIds: number[];
  reservationId: string;
  status: 'pending' | 'confirmed' | 'failed';
};

export type RevealSubmissionStorageControl = {
  paused: boolean;
  source: 'd1';
  revision: number;
  updatedAtMs: number;
  cutoverAtMs: number | null;
};

type StoredRevealSubmission = {
  submission: RevealSubmissionRecord;
  revision: number;
};

type NormalizeRevealSubmission = (
  raw: Record<string, unknown>,
  boxAssetId: string,
) => RevealSubmissionRecord;

const REQUIRED_CUTOVER_SUBMISSION_COUNT = 14;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

function safeInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : null;
}

function changed(result: D1Result): boolean {
  return Number(result.meta.changes || 0) > 0;
}

function sameTransaction(left: RevealSubmissionRecord, right: RevealSubmissionRecord): boolean {
  return left.owner === right.owner &&
    left.signature === right.signature &&
    left.recentBlockhash === right.recentBlockhash &&
    left.blockhashContextSlot === right.blockhashContextSlot &&
    left.dudeIds.length === right.dudeIds.length &&
    left.dudeIds.every((id, index) => id === right.dudeIds[index]);
}

export class RevealSubmissionOwnerMismatchError extends Error {
  constructor() {
    super('Reveal submission owner changed');
    this.name = 'RevealSubmissionOwnerMismatchError';
  }
}

export async function loadRevealSubmissionStorageControl(
  db: D1Database,
  signal?: AbortSignal,
): Promise<RevealSubmissionStorageControl> {
  throwIfAborted(signal);
  const row = await db.prepare(`SELECT
      paused,
      storage_source,
      revision,
      updated_at_ms,
      cutover_at_ms,
      (SELECT COUNT(*)
        FROM reveal_submissions
        WHERE status = 'confirmed' AND created_at_ms <= control.cutover_at_ms
      ) AS cutover_submission_count
    FROM reveal_submission_storage_control AS control
    WHERE singleton = 1`)
    .first<Record<string, unknown>>();
  throwIfAborted(signal);
  const revision = safeInteger(row?.revision);
  const updatedAtMs = safeInteger(row?.updated_at_ms);
  const cutoverAtMs = row?.cutover_at_ms === null ? null : safeInteger(row?.cutover_at_ms);
  const cutoverSubmissionCount = safeInteger(row?.cutover_submission_count);
  if (
    !row ||
    (row.paused !== 0 && row.paused !== 1) ||
    row.storage_source !== 'd1' ||
    revision === null ||
    revision < 1 ||
    updatedAtMs === null ||
    cutoverAtMs === null ||
    cutoverSubmissionCount === null ||
    cutoverSubmissionCount < REQUIRED_CUTOVER_SUBMISSION_COUNT
  ) {
    throw new Error('Reveal-submission storage control is invalid');
  }
  return {
    paused: row.paused === 1,
    source: row.storage_source,
    revision,
    updatedAtMs,
    cutoverAtMs,
  };
}

async function loadStoredRevealSubmission(
  db: D1Database,
  dropId: string,
  boxAssetId: string,
  normalize: NormalizeRevealSubmission,
  signal?: AbortSignal,
): Promise<StoredRevealSubmission | null> {
  throwIfAborted(signal);
  const row = await db.prepare(`SELECT
      schema_version,
      owner_wallet,
      signature,
      recent_blockhash,
      blockhash_context_slot,
      dude_ids_json,
      reservation_id,
      status,
      revision,
      created_at_ms,
      updated_at_ms,
      confirmed_at_ms
    FROM reveal_submissions
    WHERE drop_id = ? AND box_asset_id = ?`)
    .bind(dropId, boxAssetId)
    .first<Record<string, unknown>>();
  throwIfAborted(signal);
  if (!row) return null;
  let dudeIds: unknown;
  try {
    dudeIds = JSON.parse(String(row.dude_ids_json));
  } catch {
    dudeIds = null;
  }
  const revision = safeInteger(row.revision);
  if (revision === null || revision < 1) throw new Error('Stored reveal-submission revision is invalid');
  return {
    submission: normalize({
      version: row.schema_version,
      owner: row.owner_wallet,
      signature: row.signature,
      recentBlockhash: row.recent_blockhash,
      blockhashContextSlot: row.blockhash_context_slot,
      dudeIds,
      reservationId: row.reservation_id,
      status: row.status,
      createdAt: row.created_at_ms,
      updatedAt: row.updated_at_ms,
      ...(row.confirmed_at_ms === null ? {} : { confirmedAt: row.confirmed_at_ms }),
    }, boxAssetId),
    revision,
  };
}

export async function loadD1RevealSubmission(
  db: D1Database,
  dropId: string,
  boxAssetId: string,
  normalize: NormalizeRevealSubmission,
  signal?: AbortSignal,
): Promise<RevealSubmissionRecord | null> {
  return (await loadStoredRevealSubmission(db, dropId, boxAssetId, normalize, signal))?.submission || null;
}

export async function reserveD1RevealSubmission(args: {
  boxAssetId: string;
  candidate: RevealSubmissionRecord;
  db: D1Database;
  dropId: string;
  normalize: NormalizeRevealSubmission;
  nowMs: number;
  replaceSubmission?: RevealSubmissionRecord;
  signal?: AbortSignal;
}): Promise<{ submission: RevealSubmissionRecord; owned: boolean }> {
  const candidate = args.normalize({ ...args.candidate, version: 1 }, args.boxAssetId);
  const dudeIdsJson = JSON.stringify(candidate.dudeIds);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    throwIfAborted(args.signal);
    const inserted = await args.db.prepare(`INSERT INTO reveal_submissions (
        drop_id,
        box_asset_id,
        schema_version,
        owner_wallet,
        signature,
        recent_blockhash,
        blockhash_context_slot,
        dude_ids_json,
        reservation_id,
        status,
        revision,
        created_at_ms,
        updated_at_ms,
        confirmed_at_ms
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, NULL)
      ON CONFLICT (drop_id, box_asset_id) DO NOTHING`)
      .bind(
        args.dropId,
        args.boxAssetId,
        candidate.owner,
        candidate.signature,
        candidate.recentBlockhash,
        candidate.blockhashContextSlot,
        dudeIdsJson,
        candidate.reservationId,
        args.nowMs,
        args.nowMs,
      )
      .run();
    if (changed(inserted)) return { submission: candidate, owned: true };
    const existing = await loadStoredRevealSubmission(
      args.db,
      args.dropId,
      args.boxAssetId,
      args.normalize,
      args.signal,
    );
    if (!existing) continue;
    if (existing.submission.owner !== candidate.owner) throw new RevealSubmissionOwnerMismatchError();
    if (existing.submission.status === 'confirmed') {
      return { submission: existing.submission, owned: false };
    }
    if (existing.submission.reservationId === candidate.reservationId) {
      if (!sameTransaction(existing.submission, candidate)) {
        throw new Error('Stored reveal submission does not match its reservation');
      }
      return { submission: existing.submission, owned: existing.submission.status === 'pending' };
    }
    if (
      !args.replaceSubmission ||
      existing.submission.signature !== args.replaceSubmission.signature ||
      existing.submission.reservationId !== args.replaceSubmission.reservationId
    ) {
      return { submission: existing.submission, owned: false };
    }
    const replaced = await args.db.prepare(`UPDATE reveal_submissions
      SET
        schema_version = 1,
        owner_wallet = ?,
        signature = ?,
        recent_blockhash = ?,
        blockhash_context_slot = ?,
        dude_ids_json = ?,
        reservation_id = ?,
        status = 'pending',
        revision = revision + 1,
        updated_at_ms = MAX(updated_at_ms, ?),
        confirmed_at_ms = NULL
      WHERE
        drop_id = ? AND
        box_asset_id = ? AND
        revision = ? AND
        status <> 'confirmed'`)
      .bind(
        candidate.owner,
        candidate.signature,
        candidate.recentBlockhash,
        candidate.blockhashContextSlot,
        dudeIdsJson,
        candidate.reservationId,
        args.nowMs,
        args.dropId,
        args.boxAssetId,
        existing.revision,
      )
      .run();
    if (changed(replaced)) return { submission: candidate, owned: true };
  }
  throw new Error('Reveal submission changed concurrently');
}

export async function setD1RevealSubmissionStatus(args: {
  boxAssetId: string;
  db: D1Database;
  dropId: string;
  normalize: NormalizeRevealSubmission;
  nowMs: number;
  signal?: AbortSignal;
  status: 'confirmed' | 'failed';
  submission: RevealSubmissionRecord;
}): Promise<'confirmed' | 'failed' | 'stale'> {
  throwIfAborted(args.signal);
  const updated = await args.db.prepare(`UPDATE reveal_submissions
    SET
      status = ?,
      revision = revision + 1,
      updated_at_ms = MAX(updated_at_ms, ?),
      confirmed_at_ms = CASE WHEN ? = 'confirmed' THEN MAX(updated_at_ms, ?) ELSE NULL END
    WHERE
      drop_id = ? AND
      box_asset_id = ? AND
      reservation_id = ? AND
      signature = ? AND
      status = 'pending'`)
    .bind(
      args.status,
      args.nowMs,
      args.status,
      args.nowMs,
      args.dropId,
      args.boxAssetId,
      args.submission.reservationId,
      args.submission.signature,
    )
    .run();
  if (changed(updated)) return args.status;
  const current = await loadD1RevealSubmission(
    args.db,
    args.dropId,
    args.boxAssetId,
    args.normalize,
    args.signal,
  );
  if (
    !current ||
    current.reservationId !== args.submission.reservationId ||
    current.signature !== args.submission.signature
  ) return 'stale';
  return current.status === 'pending' ? 'stale' : current.status;
}
