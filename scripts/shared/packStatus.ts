import { FieldValue, type DocumentReference, type Firestore } from '@google-cloud/firestore';
import { dropBoxAssignmentPath, dropPackStatusPath } from '../../cloud/workers/api/src/dropPaths.ts';
import { IRL_CLAIM_CODE_NAMESPACE } from '../../cloud/workers/api/src/claimCodes.ts';
import {
  PACK_STATUS_DEFAULT_DROP_ID,
  PACK_STATUS_SUPPORTED_DROP_IDS,
  buildPackStatusBreakdown,
  buildPackStatusCountersFromRebuildInputs,
  buildPackStatusStatsFields,
  deliveryOrderBoxAssetIds,
  isPackStatusSupportedDropId,
  shouldTrackPackStatusForDrop,
} from '../../shared/packStatus.ts';
import type {
  PackStatusCounters,
  PackStatusDeliveryOrderRecord,
  PackStatusDropRuntime,
} from '../../shared/packStatus.ts';

export {
  PACK_STATUS_DEFAULT_DROP_ID,
  PACK_STATUS_SUPPORTED_DROP_IDS,
  buildPackStatusBreakdown,
  buildPackStatusCountersFromRebuildInputs,
  deliveryOrderBoxAssetIds,
  isPackStatusSupportedDropId,
  shouldTrackPackStatusForDrop,
};
export type {
  PackStatusCounters,
  PackStatusDeliveryOrderRecord,
  PackStatusDropRuntime,
};

export function packStatusStatsRef(db: Pick<Firestore, 'doc'>, dropId: string): DocumentReference {
  return db.doc(dropPackStatusPath(dropId));
}

export function buildPackStatusStatsDocument(counters: PackStatusCounters): Record<string, unknown> {
  return {
    ...buildPackStatusStatsFields(counters),
    rebuiltAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export function assignmentHasNormalInFlightPackStatusClaim(assignment: any): boolean {
  return assignment?.irlClaim?.namespace !== IRL_CLAIM_CODE_NAMESPACE;
}

export function packStatusAssignmentRef(
  db: Pick<Firestore, 'doc'>,
  dropId: string,
  boxAssetId: string,
): DocumentReference {
  return db.doc(dropBoxAssignmentPath(dropId, boxAssetId));
}
