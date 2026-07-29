type SessionProfileRequestOptions = {
  mergeStripeDeliveryOrders: boolean;
};

type InFlightSessionProfileRequest<T> = {
  mergesStripeDeliveryOrders: boolean;
  promise: Promise<T>;
};

export function createSessionProfileRequestCoordinator<T>(
  request: (options: SessionProfileRequestOptions) => Promise<T>,
) {
  let inFlight: InFlightSessionProfileRequest<T> | null = null;

  return async (options?: { mergeStripeDeliveryOrders?: boolean }): Promise<T> => {
    const requiresStripeMerge = options?.mergeStripeDeliveryOrders === true;

    while (true) {
      const current = inFlight;
      if (current) {
        if (!requiresStripeMerge || current.mergesStripeDeliveryOrders) {
          return current.promise;
        }
        try {
          await current.promise;
        } catch {}
        continue;
      }

      const promise = Promise.resolve().then(() =>
        request({ mergeStripeDeliveryOrders: requiresStripeMerge }),
      );
      const next = {
        mergesStripeDeliveryOrders: requiresStripeMerge,
        promise,
      };
      inFlight = next;
      const clear = () => {
        if (inFlight === next) inFlight = null;
      };
      void promise.then(clear, clear);
      return promise;
    }
  };
}
