import type { ProfileProviderFetch } from './boundedResponse.js';
import {
  type D1CommerceRepository,
  commerceKeys,
} from './commerceRepository.js';
import { ProfileReadError } from './dataAccess.js';

export type ProfileWriteCommerceRepository = Pick<D1CommerceRepository, 'get' | 'run'>;

export type FulfillmentStoreContext = {
  nowMs: number;
  repository: ProfileWriteCommerceRepository;
  signal: AbortSignal;
};

export type CommerceWriteCommon = FulfillmentStoreContext & {
  pauseForRatePoll: (signal: AbortSignal, delayMs: number) => Promise<void>;
  providerFetch: ProfileProviderFetch;
};

export type DeliveryOrderDocument = {
  fields: Record<string, unknown>;
};

export async function loadDeliveryOrderDocument(
  common: FulfillmentStoreContext,
  dropId: string,
  deliveryId: number,
): Promise<DeliveryOrderDocument> {
  const payload = await common.repository.get(
    commerceKeys.deliveryOrder(dropId, String(deliveryId)),
  );
  if (!payload) throw new ProfileReadError('not-found', 404, 'Delivery order not found');
  return { fields: payload.data };
}
