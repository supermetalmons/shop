import type { commerceFieldValue } from './commerceRepositoryTypes.js';

type ProjectionDeleteField = ReturnType<typeof commerceFieldValue.delete>;
type ProjectionTimestamp = ReturnType<typeof commerceFieldValue.serverTimestamp>;

export type DeliveryPackStatusProjectionUpdates = {
  packStatusProjectionState?: 'pending' | 'completed' | 'failed' | ProjectionDeleteField;
  packStatusProjectionNextAttemptAtMs?: number | ProjectionDeleteField;
  packStatusProjectionFailureCount?: number | ProjectionDeleteField;
  packStatusProjectionCompletedAt?: ProjectionTimestamp | ProjectionDeleteField;
  packStatusProjectionFailedAt?: ProjectionTimestamp | ProjectionDeleteField;
  packStatusProjectionLastErrorCode?: string | ProjectionDeleteField;
};
