import type { ProfileProviderFetch } from './boundedResponse.js';
import {
  CommerceWriteConflict,
  type D1CommerceRepository,
  commerceKeys,
  type CommerceUpdateValue,
} from './commerceRepository.js';
import { runCommerceTransaction } from './commerceTransactions.js';
import { ProfileReadError } from './dataAccess.js';

export type ProfileWriteCommerceRepository = Pick<D1CommerceRepository, 'get' | 'run'>;

export type CommerceWriteCommon = {
  nowMs: number;
  pauseForRatePoll: (signal: AbortSignal, delayMs: number) => Promise<void>;
  providerFetch: ProfileProviderFetch;
  repository: ProfileWriteCommerceRepository;
  signal: AbortSignal;
};

export type DeliveryOrderDocument = {
  fields: Record<string, unknown>;
};

export async function loadDeliveryOrderDocument(
  common: CommerceWriteCommon,
  dropId: string,
  deliveryId: number,
): Promise<DeliveryOrderDocument> {
  const payload = await common.repository.get(
    commerceKeys.deliveryOrder(dropId, String(deliveryId)),
  );
  if (!payload) throw new ProfileReadError('not-found', 404, 'Delivery order not found');
  return { fields: payload.data };
}

export async function mutateDeliveryOrder<T>(args: {
  build: (document: DeliveryOrderDocument) => {
    value: T;
    updates?: Record<string, CommerceUpdateValue>;
  };
  common: CommerceWriteCommon;
  deliveryId: number;
  dropId: string;
}): Promise<T> {
  try {
    return await runCommerceTransaction({
      nowMs: args.common.nowMs,
    repository: args.common.repository,
    signal: args.common.signal,
  }, async (unit) => {
    const record = await unit.get(
      commerceKeys.deliveryOrder(args.dropId, String(args.deliveryId)),
    );
    if (!record) throw new ProfileReadError('not-found', 404, 'Delivery order not found');
    const mutation = args.build({ fields: record.data });
    if (mutation.updates) await unit.update(record.key, mutation.updates);
    return mutation.value;
  });
  } catch (error) {
    if (error instanceof CommerceWriteConflict) {
      throw new ProfileReadError('aborted', 409, 'The delivery order changed. Try again.');
    }
    throw error;
  }
}
