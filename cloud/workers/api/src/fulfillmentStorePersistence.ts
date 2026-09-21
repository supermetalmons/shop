import { CommerceWriteConflict } from './commerceRepository.js';
import { runCommerceTransaction } from './commerceTransactions.js';
import { ProfileReadError } from './dataAccess.js';
import { loadDeliveryOrderDocument, type DeliveryOrderDocument } from './deliveryOrderStore.js';
import type { FulfillmentDeliveryOrderUpdates } from './fulfillmentDeliveryOrderUpdates.js';
import type { FulfillmentStoreContext } from './profileWriteCommerce.js';

export async function mutateDeliveryOrder<T>(args: {
  build: (document: DeliveryOrderDocument) => {
    value: T;
    updates?: FulfillmentDeliveryOrderUpdates;
  };
  common: FulfillmentStoreContext;
  deliveryId: number;
  dropId: string;
}): Promise<T> {
  try {
    return await runCommerceTransaction({
      nowMs: args.common.nowMs,
      repository: args.common.repository,
      signal: args.common.signal,
    }, async (unit) => {
      const record = await loadDeliveryOrderDocument({ repository: unit }, args.dropId, args.deliveryId);
      const mutation = args.build(record);
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
