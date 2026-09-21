import { CommerceWriteConflict, commerceKeys, type CommerceUpdateValue } from './commerceRepository.js';
import { runCommerceTransaction } from './commerceTransactions.js';
import { ProfileReadError } from './dataAccess.js';
import type { DeliveryOrderDocument, FulfillmentStoreContext } from './profileWriteCommerce.js';

export async function mutateDeliveryOrder<T>(args: {
  build: (document: DeliveryOrderDocument) => {
    value: T;
    updates?: Record<string, CommerceUpdateValue>;
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
