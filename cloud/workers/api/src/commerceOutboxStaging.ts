import {
  notificationOutboxState,
  parseNotificationOutboxRecord,
  type NotificationOutboxCreate,
  type NotificationOutboxFamily,
  type NotificationOutboxRecord,
} from '../../../../shared/notificationOutbox.js';
import { parsePackStatusOutboxRecord, type PackStatusOutboxRecord } from '../../../../shared/packStatusOutbox.js';
import { commerceKeyFromPath, type StoredDocument } from './commerceDocumentCodec.js';
import { CommerceRepositoryError, CommerceWriteConflict, type CommerceDocumentKey } from './commerceRepositoryTypes.js';

type PackStatusProjection = { parentPath: string; dropId: string };

function notificationKey(parentPath: string, family: NotificationOutboxFamily): string {
  return JSON.stringify([parentPath, family]);
}

export function requireStagedReadyDelivery(input: PackStatusProjection, parent: StoredDocument | null | undefined): void {
  if (!parent || parent.key.kind !== 'delivery_order' || parent.key.dropId !== input.dropId || parent.data.status !== 'ready_to_ship') {
    throw new CommerceRepositoryError('invalid-argument', 'Pack-status projection requires a staged ready delivery.');
  }
}

export class CommerceOutboxStaging {
  private readonly originalRecords = new Map<string, NotificationOutboxRecord | null>();
  private readonly pendingRecords = new Map<string, NotificationOutboxRecord>();
  private readonly pendingPackStatusRecords = new Map<string, PackStatusOutboxRecord>();

  get original(): ReadonlyMap<string, NotificationOutboxRecord | null> {
    return this.originalRecords;
  }

  get pending(): ReadonlyMap<string, NotificationOutboxRecord> {
    return this.pendingRecords;
  }

  get pendingPackStatus(): ReadonlyMap<string, PackStatusOutboxRecord> {
    return this.pendingPackStatusRecords;
  }

  hasRead(parentPath: string, family: NotificationOutboxFamily): boolean {
    return this.originalRecords.has(notificationKey(parentPath, family));
  }

  recordRead(parentPath: string, family: NotificationOutboxFamily, record: NotificationOutboxRecord | null): void {
    this.originalRecords.set(notificationKey(parentPath, family), record);
  }

  current(parentPath: string, family: NotificationOutboxFamily): NotificationOutboxRecord | null {
    const key = notificationKey(parentPath, family);
    const value = this.pendingRecords.get(key) ?? this.originalRecords.get(key);
    return value ? parseNotificationOutboxRecord(value) : null;
  }

  notificationParentKey(
    input: NotificationOutboxCreate,
    current: NotificationOutboxRecord | null,
    replace: boolean,
  ): CommerceDocumentKey {
    if (replace && current?.generation === input.generation) {
      throw new CommerceRepositoryError('invalid-argument', 'A notification replacement requires a new generation.');
    }
    const parentKey = commerceKeyFromPath(input.parentPath);
    if (!parentKey || parentKey.dropId !== input.dropId ||
      parentKey.kind !== (input.family === 'stripe_terminal' ? 'stripe_checkout' : 'delivery_order')) {
      throw new CommerceRepositoryError('invalid-argument', 'Invalid notification outbox parent.');
    }
    return parentKey;
  }

  stageNotification(
    input: NotificationOutboxCreate,
    current: NotificationOutboxRecord | null,
    parent: StoredDocument | null | undefined,
    commitTimestampMs: number,
  ): NotificationOutboxRecord {
    if (!parent) throw new CommerceWriteConflict('failed-precondition');
    const key = notificationKey(input.parentPath, input.family);
    const nowMs = Math.max(current?.updatedAtMs ?? 0, commitTimestampMs);
    const state = notificationOutboxState(input.entries);
    const next = parseNotificationOutboxRecord({
      ...input, outcome: input.outcome ?? null, state,
      revision: (this.originalRecords.get(key)?.revision ?? 0) + 1,
      attemptCount: 0,
      nextAttemptAtMs: state === 'pending' ? nowMs : null,
      claimId: null, claimExpiresAtMs: null, createdAtMs: nowMs, updatedAtMs: nowMs, lastErrorCode: null,
    });
    this.pendingRecords.set(key, next);
    return parseNotificationOutboxRecord(next);
  }

  cancelNotification(
    current: NotificationOutboxRecord | null,
    reason: string,
    commitTimestampMs: number,
  ): NotificationOutboxRecord | null {
    if (!current || current.state === 'queued' || current.state === 'cancelled') return current;
    const key = notificationKey(current.parentPath, current.family);
    const next = parseNotificationOutboxRecord({
      ...current, state: 'cancelled',
      revision: (this.originalRecords.get(key)?.revision ?? 0) + 1,
      entries: current.entries.map(({ payload: _payload, ...entry }) => entry),
      nextAttemptAtMs: null, claimId: null, claimExpiresAtMs: null, lastErrorCode: reason,
      updatedAtMs: Math.max(current.updatedAtMs, commitTimestampMs),
    });
    this.pendingRecords.set(key, next);
    return parseNotificationOutboxRecord(next);
  }

  stagePackStatus(input: PackStatusProjection, parent: StoredDocument | null | undefined, nowMs: number): void {
    requireStagedReadyDelivery(input, parent);
    if (this.pendingPackStatusRecords.has(input.parentPath)) return;
    this.pendingPackStatusRecords.set(input.parentPath, parsePackStatusOutboxRecord({
      ...input, generation: crypto.randomUUID(), state: 'pending', revision: 1, failureCount: 0,
      nextAttemptAtMs: nowMs, completedAtMs: null, failedAtMs: null, lastErrorCode: null,
      createdAtMs: nowMs, updatedAtMs: nowMs,
    }));
  }

  clearPending(): void {
    this.pendingRecords.clear();
    this.pendingPackStatusRecords.clear();
  }
}
