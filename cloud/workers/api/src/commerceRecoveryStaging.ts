import {
  createDeliveryRecoveryRecord,
  parseDeliveryRecoveryRecord,
  updateDeliveryRecoveryRecord,
  type DeliveryRecoveryRecord,
} from '../../../../shared/deliveryRecoveryState.js';
import { CommerceRepositoryError, CommerceWriteConflict, type CommerceDocumentKey } from './commerceRepositoryTypes.js';

export class CommerceRecoveryStaging {
  private readonly originalRecords = new Map<string, DeliveryRecoveryRecord | null>();
  private readonly pendingRecords = new Map<string, DeliveryRecoveryRecord>();

  get original(): ReadonlyMap<string, DeliveryRecoveryRecord | null> {
    return this.originalRecords;
  }

  get pending(): ReadonlyMap<string, DeliveryRecoveryRecord> {
    return this.pendingRecords;
  }

  recordRead(parentPath: string, state: DeliveryRecoveryRecord | null): void {
    this.originalRecords.set(parentPath, state);
  }

  current(parentPath: string): DeliveryRecoveryRecord | null | undefined {
    return this.pendingRecords.get(parentPath) ?? this.originalRecords.get(parentPath);
  }

  stage(input: DeliveryRecoveryRecord): void {
    const record = parseDeliveryRecoveryRecord(input);
    if (!this.originalRecords.has(record.parentPath)) {
      throw new CommerceRepositoryError('invalid-argument', 'Recovery state must be read before mutation.');
    }
    const original = this.originalRecords.get(record.parentPath);
    const current = this.current(record.parentPath);
    if (!current || record.generation !== current.generation || record.createdAtMs !== current.createdAtMs ||
      record.revision !== current.revision + 1 || record.updatedAtMs < current.updatedAtMs) {
      throw new CommerceWriteConflict();
    }
    this.pendingRecords.set(record.parentPath, { ...record, revision: (original?.revision ?? 0) + 1 });
  }

  create(parentPath: string, receiptRecoveryJson: string | null, nowMs: number): void {
    const previous = this.originalRecords.get(parentPath);
    if (!this.originalRecords.has(parentPath)) this.originalRecords.set(parentPath, null);
    this.pendingRecords.set(parentPath, previous
      ? updateDeliveryRecoveryRecord(previous, { receiptRecoveryJson, leaseId: null }, nowMs)
      : createDeliveryRecoveryRecord({ parentPath, receiptRecoveryJson, nowMs, generation: crypto.randomUUID() }));
  }

  deletePending(parentPath: string): void {
    this.pendingRecords.delete(parentPath);
  }

  clearPending(): void {
    this.pendingRecords.clear();
  }
}

export function rejectDeliveryRecoveryUpdates(key: CommerceDocumentKey, updates: Readonly<Record<string, unknown>>): void {
  if (key.kind === 'delivery_order' && Object.keys(updates).some((field) => field === 'receiptRecovery' || field.startsWith('receiptRecovery.'))) {
    throw new CommerceRepositoryError('invalid-argument', 'Use the delivery recovery state store.');
  }
}
