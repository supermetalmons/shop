import type { ProfileProviderFetch } from './boundedResponse.js';
import type { D1CommerceRepository } from './commerceRepository.js';

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
