import type { ProfileProviderFetch } from './boundedResponse.js';
import {
  CommerceWriteConflict,
  type D1CommerceRepository,
  commerceKeys,
  type CommerceUpdateValue,
} from './commerceRepository.js';
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

const COMMERCE_MUTATION_ATTEMPTS = 3;

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

async function pauseForMutationRetry(signal: AbortSignal, attempt: number): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, 25 * (attempt + 1));
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
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
  for (let attempt = 0; attempt < COMMERCE_MUTATION_ATTEMPTS; attempt += 1) {
    try {
      return await args.common.repository.run(args.common.nowMs, async (unit) => {
        const record = await unit.get(
          commerceKeys.deliveryOrder(args.dropId, String(args.deliveryId)),
        );
        if (!record) throw new ProfileReadError('not-found', 404, 'Delivery order not found');
        const mutation = args.build({ fields: record.data });
        if (mutation.updates) await unit.update(record.key, mutation.updates);
        return mutation.value;
      });
    } catch (error) {
      if (!(error instanceof CommerceWriteConflict)) throw error;
      if (attempt + 1 >= COMMERCE_MUTATION_ATTEMPTS) {
        throw new ProfileReadError('aborted', 409, 'The delivery order changed. Try again.');
      }
      await pauseForMutationRetry(args.common.signal, attempt);
    }
  }
  throw new ProfileReadError('aborted', 409, 'The delivery order changed. Try again.');
}
