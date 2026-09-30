import { createDeliveryRecoveryRecord, type DeliveryRecoveryRecord } from '../../shared/deliveryRecoveryState.ts';
import type { CommerceD1Document } from './commerceD1Maintenance.ts';

export const LEGACY_DELIVERY_RECOVERY_JSON_SQL = "document_json -> '$.receiptRecovery'";

export function planDeliveryRecoveryStateBackfill(
  document: CommerceD1Document,
  receiptRecoveryJson: string | null,
  generation: string,
): DeliveryRecoveryRecord {
  if (document.kind !== 'delivery_order') throw new Error(`Not a delivery order: ${document.path}.`);
  try {
    return createDeliveryRecoveryRecord({
      parentPath: document.path,
      receiptRecoveryJson,
      generation,
      nowMs: Date.parse(document.updateTime),
    });
  } catch (cause) {
    throw new Error(`Delivery recovery state validation failed for ${document.path}.`, { cause });
  }
}
