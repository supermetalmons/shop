import type { StoredDocument } from './commerceDocumentCodec.js';

export function commerceDocumentWriteStatement(
  db: Pick<D1Database, 'prepare'>,
  path: string,
  document: StoredDocument | null,
  original: StoredDocument | null | undefined,
): D1PreparedStatement {
  if (!document) {
    return db.prepare('DELETE FROM commerce_documents WHERE document_path = ?').bind(path);
  }
  if (document.key.kind === 'stripe_checkout' && original && document.rawData === original.rawData) {
    return db.prepare(`UPDATE commerce_documents SET version = ?, update_time = ?,
      processed_at_seconds = ?, processed_at_nanos = ? WHERE document_path = ?`).bind(
      document.version, document.updateTime, document.processedAt?.seconds ?? null,
      document.processedAt?.nanos ?? null, path);
  }
  return db.prepare(`INSERT INTO commerce_documents (
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
    processed_at_nanos = excluded.processed_at_nanos`).bind(
    document.key.path,
    document.key.kind,
    document.key.dropId,
    document.key.documentId,
    JSON.stringify(document.rawData),
    document.version,
    document.createTime,
    document.updateTime,
    document.processedAt?.seconds ?? null,
    document.processedAt?.nanos ?? null,
  );
}
