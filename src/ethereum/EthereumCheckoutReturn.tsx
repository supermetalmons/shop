import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ETHEREUM_CHECKOUT_ID, type EthereumCheckoutStatusResponse } from '../../shared/ethereum/checkout';
import { checkoutApi, checkoutNotFound } from '../checkout/api';
import { CHECKOUT_ENABLED } from '../checkout/config';
import { navigate } from '../navigation';
import { observeCheckoutReservation, rememberCheckoutReservation } from './checkoutReservations';

export type EthereumCheckoutReturnStatus = Pick<EthereumCheckoutStatusResponse,
  'checkoutId' | 'status' | 'chainId' | 'contractAddress' | 'wallet' | 'tokenIds'>;

export function EthereumCheckoutReturn({ checkoutId, onConfirmed, onStatus }: {
  checkoutId: string; onConfirmed: (checkout: EthereumCheckoutStatusResponse) => void; onStatus?: (status: EthereumCheckoutReturnStatus) => void;
}) {
  const valid = ETHEREUM_CHECKOUT_ID.test(checkoutId);
  const refreshed = useRef(new Set<string>());
  const result = useQuery({
    queryKey: ['ethereum-checkout', 'return', checkoutId],
    queryFn: async ({ signal }) => {
      const observe = observeCheckoutReservation(checkoutId);
      const checkout = await checkoutApi.status(checkoutId, signal);
      if (checkout.status !== 'success') refreshed.current.delete(checkoutId);
      observe(checkout);
      return checkout;
    },
    enabled: valid,
    retry: false,
    refetchInterval: query => checkoutNotFound(query.state.error) || query.state.data?.status === 'success' || query.state.data?.status === 'failed' ? false : 5_000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    const checkout = result.data;
    if (!checkout || checkout.checkoutId !== checkoutId) return;
    const pending = checkout.status === 'submitting' || checkout.status === 'pending';
    if (!pending && (!result.isFetchedAfterMount || !result.isSuccess)) return;
    if (pending) rememberCheckoutReservation(checkout);
    onStatus?.({ checkoutId, status: checkout.status, chainId: checkout.chainId, contractAddress: checkout.contractAddress,
      wallet: checkout.wallet, tokenIds: checkout.tokenIds });
  }, [checkoutId, onStatus, result.data, result.isFetchedAfterMount, result.isSuccess]);
  useEffect(() => {
    if (!result.isFetchedAfterMount || !result.isSuccess || result.data.checkoutId !== checkoutId ||
      result.data.status !== 'success' || refreshed.current.has(checkoutId)) return;
    refreshed.current.add(checkoutId);
    onConfirmed(result.data);
  }, [checkoutId, onConfirmed, result.data, result.dataUpdatedAt, result.isFetchedAfterMount, result.isSuccess]);
  if (!valid) return <p className="error" role="alert">This checkout link is invalid.</p>;
  const missing = result.isFetchedAfterMount && result.isError && checkoutNotFound(result.error);
  const status = result.data?.status;
  const message = missing ? 'This checkout has expired or no longer exists.' :
    result.isError ? 'Couldn’t check your checkout.' :
    result.isPending ? 'Checking your checkout…' :
    status === 'success' ? 'Your test redemption is confirmed.' :
    status === 'failed' ? 'This redemption attempt failed.' :
    status === 'pending' || status === 'submitting' ? 'Your redemption is pending. Processing continues even when you leave.' :
    CHECKOUT_ENABLED ? 'Your checkout is ready to resume.' : 'Shipping checkout is temporarily unavailable.';
  return <div className="ethereum111k__pending" role="status">
    <span>{message}</span>
    {missing ? <a href="/111k_devnet">Continue to collection</a> : CHECKOUT_ENABLED ? (
      <a href={`/checkout/${checkoutId}`} onClick={event => { event.preventDefault(); navigate(`/checkout/${checkoutId}`); }}>
        {status === 'success' ? 'View checkout' : 'Resume checkout'}
      </a>
    ) : null}
  </div>;
}
