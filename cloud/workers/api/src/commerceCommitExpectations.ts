import type { DeliveryRecoveryRecord } from '../../../../shared/deliveryRecoveryState.js';
import type { NotificationOutboxFamily, NotificationOutboxRecord } from '../../../../shared/notificationOutbox.js';

export type DocumentExpectation = Readonly<{
  path: string;
  version: number;
  pathRevision?: number;
}>;

export type SerializedCommerceCommitExpectations = Readonly<{
  documents: string;
  deliveryOwners: string;
  recovery: string;
  notifications: string;
}>;

export function serializeCommerceCommitExpectations(input: {
  documents: ReadonlyMap<string, DocumentExpectation>;
  deliveryOwners: ReadonlyMap<string, number>;
  recovery: ReadonlyMap<string, DeliveryRecoveryRecord | null>;
  notifications: ReadonlyMap<string, NotificationOutboxRecord | null>;
}): SerializedCommerceCommitExpectations {
  return {
    documents: JSON.stringify(Array.from(input.documents.values())
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    deliveryOwners: JSON.stringify(Array.from(input.deliveryOwners, ([owner, revision]) => ({ owner, revision }))
      .sort((left, right) => left.owner < right.owner ? -1 : left.owner > right.owner ? 1 : 0)),
    recovery: JSON.stringify(Array.from(input.recovery, ([parentPath, state]) => ({
      parentPath, generation: state?.generation ?? null, revision: state?.revision ?? -1,
    }))),
    notifications: JSON.stringify(Array.from(input.notifications, ([key, value]) => {
      const [parentPath, family] = JSON.parse(key) as [string, NotificationOutboxFamily];
      return { parentPath, family, revision: value?.revision ?? -1, generation: value?.generation ?? null };
    })),
  };
}
