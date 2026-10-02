import type { DatabaseSync } from 'node:sqlite';
import { createDeliveryRecoveryRecord, deliveryRecoveryRow } from '../../shared/deliveryRecoveryState.ts';
import { commerceTestLease, commerceTestNow } from './commerceDatabase.ts';

export function activateRecoveryFixture(database: DatabaseSync): void {
  commerceTestLease(database, () => {
    database.exec(`UPDATE commerce_delivery_recovery_control SET preparation_state = 'preparing',
      source_documents_revision = (SELECT documents_revision FROM commerce_authority_control), prepared_at_ms = NULL`);
    const documents = database.prepare(`SELECT document_path, document_json -> '$.receiptRecovery' AS payload, update_time
      FROM commerce_documents WHERE document_kind = 'delivery_order'`).all();
    for (const document of documents) {
      const row = deliveryRecoveryRow(createDeliveryRecoveryRecord({ parentPath: String(document.document_path),
        receiptRecoveryJson: document.payload as string | null, generation: crypto.randomUUID(), nowMs: Date.parse(String(document.update_time)),
      }));
      database.prepare(`INSERT INTO commerce_delivery_recovery (${Object.keys(row).join(',')})
        VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    }
    database.exec(`UPDATE commerce_delivery_recovery_control SET preparation_state = 'ready', prepared_at_ms = ${commerceTestNow};
      UPDATE commerce_delivery_recovery_control SET storage_mode = 'table'`);
  });
}
