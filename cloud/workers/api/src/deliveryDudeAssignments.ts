import { isSignalCancellationError, sleepWithSignal } from './boundedRequest.js';
import {
  CommerceDudeAssignmentError,
  assignCommerceDudes,
} from './commerceDudeAssignments.js';
import type { CommerceRepositoryContext } from './commerceTransactions.js';
import { DeliveryReceiptError, mapProviderError } from './deliveryReceiptErrors.js';
import type { DeliveryRuntime } from './deliveryReceiptOnchain.js';

type DeliveryAssignmentRuntime = Pick<DeliveryRuntime, 'dropId' | 'itemsPerBox' | 'maxDudeId'> & {
  config: Pick<DeliveryRuntime['config'], 'dropFamily'>;
};

export async function assignDudesForBox(
  context: CommerceRepositoryContext,
  runtime: DeliveryAssignmentRuntime,
  boxAssetId: string,
  randomInt: (maxExclusive: number) => number,
): Promise<number[]> {
  try {
    const result = await assignCommerceDudes({
      boxAssetId,
      dropFamily: runtime.config.dropFamily,
      dropId: runtime.dropId,
      itemsPerBox: runtime.itemsPerBox,
      maxDudeId: runtime.maxDudeId,
      nowMs: context.nowMs,
      randomInt,
      repository: context.repository,
      signal: context.signal,
      sleep: (milliseconds) => sleepWithSignal(milliseconds, context.signal),
    });
    return result.dudeIds;
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (error instanceof CommerceDudeAssignmentError) {
      throw new DeliveryReceiptError(
        error.code === 'invalid-stored-assignment' ? 'failed-precondition' : 'resource-exhausted',
        error.message,
        error.details,
      );
    }
    throw mapProviderError(error, 'Figure assignment is temporarily unavailable.');
  }
}
