import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  beginKeyedInventoryRecovery,
  getOrStartKeyedInventoryRefresh,
  keyedInventoryRecoveryPendingForOwner,
  observeKeyedInventoryRefresh,
  settleKeyedInventoryRecovery,
  type KeyedInventoryRecovery,
  type KeyedInventoryRefreshRun,
  type OwnerRecoveryKey,
} from '../lib/profileClientLifecycle';
import { inventoryQueryKeyPrefix } from './useInventory';
import { pendingOpenBoxesQueryKeyPrefix } from './usePendingOpenBoxes';

const STRIPE_CHECKOUT_INVENTORY_RETRY_MS = 5_000;

type StripeCheckoutInventoryRecoveryOptions = {
  recoveredProfile: OwnerRecoveryKey | null;
  owner: string | undefined;
  inventoryDataUpdatedAt: number;
  inventoryFetched: boolean;
  inventoryFetching: boolean;
};

export function useStripeCheckoutInventoryRecovery({
  recoveredProfile: stripeCheckoutRecoveredProfile,
  owner,
  inventoryDataUpdatedAt,
  inventoryFetched,
  inventoryFetching,
}: StripeCheckoutInventoryRecoveryOptions) {
  const queryClient = useQueryClient();
  const [stripeCheckoutInventoryRecovery, setStripeCheckoutInventoryRecovery] =
    useState<KeyedInventoryRecovery | null>(null);
  const stripeCheckoutInventoryRecoveryPromiseRef = useRef<KeyedInventoryRefreshRun | null>(null);

  useEffect(() => {
    const recoveredProfile = stripeCheckoutRecoveredProfile;
    if (!recoveredProfile) return;
    const { owner: recoveredOwner } = recoveredProfile;

    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    setStripeCheckoutInventoryRecovery((current) =>
      beginKeyedInventoryRecovery(current, recoveredProfile, inventoryDataUpdatedAt),
    );

    const refreshInventory = () => {
      if (cancelled) return;
      const { run: recovery } = getOrStartKeyedInventoryRefresh({
        runRef: stripeCheckoutInventoryRecoveryPromiseRef,
        target: recoveredProfile,
        start: () => {
          const inventoryPromise = queryClient.invalidateQueries(
            { queryKey: inventoryQueryKeyPrefix(recoveredOwner) },
            { throwOnError: true },
          );
          const pendingOpenBoxesPromise = queryClient.invalidateQueries(
            { queryKey: pendingOpenBoxesQueryKeyPrefix(recoveredOwner) },
            { throwOnError: true },
          );
          return {
            inventoryPromise,
            completionPromise: Promise.allSettled([inventoryPromise, pendingOpenBoxesPromise]),
          };
        },
      });
      void observeKeyedInventoryRefresh({
        run: recovery,
        isCancelled: () => cancelled,
        reportError: (err) => {
          console.warn('[mons] failed to refresh inventory after Stripe checkout', err);
        },
        settle: (target) => {
          setStripeCheckoutInventoryRecovery((current) => settleKeyedInventoryRecovery(current, target));
        },
      }).then((succeeded) => {
        if (cancelled || succeeded) return;
        retryTimeout = setTimeout(refreshInventory, STRIPE_CHECKOUT_INVENTORY_RETRY_MS);
      });
    };
    refreshInventory();

    return () => {
      cancelled = true;
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, [queryClient, stripeCheckoutRecoveredProfile]);

  useEffect(() => {
    if (
      !owner ||
      stripeCheckoutInventoryRecovery?.owner !== owner ||
      stripeCheckoutInventoryRecovery.phase !== 'pending' ||
      inventoryFetching ||
      !inventoryFetched ||
      inventoryDataUpdatedAt <= stripeCheckoutInventoryRecovery.baselineUpdatedAt
    ) {
      return;
    }
    setStripeCheckoutInventoryRecovery((current) =>
      settleKeyedInventoryRecovery(current, {
        owner,
        key: stripeCheckoutInventoryRecovery.key,
      }),
    );
  }, [
    inventoryDataUpdatedAt,
    inventoryFetched,
    inventoryFetching,
    owner,
    stripeCheckoutInventoryRecovery,
  ]);

  return keyedInventoryRecoveryPendingForOwner({
    owner,
    recovered: stripeCheckoutRecoveredProfile,
    inventoryRecovery: stripeCheckoutInventoryRecovery,
  });
}
