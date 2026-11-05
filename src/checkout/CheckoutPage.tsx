import { useMutation } from '@tanstack/react-query';
import { ETHEREUM_CHECKOUT_ID, parseCheckoutEntry } from '../../shared/ethereum/checkout';
import { ShopHeader } from '../components/ShopHeader';
import { observeCheckoutReservation, persistCheckoutReservation } from '../ethereum/checkoutReservations';
import { navigate } from '../navigation';
import { checkoutApi, checkoutNotFound } from './api';
import type { CheckoutLocation } from './useEthereumCheckout';

const COLLECTION_PATH = '/111k_devnet';

class ReservationStorageError extends Error {}

async function resolveReturnUrl({ checkoutId, search }: CheckoutLocation) {
  if (checkoutId) {
    if (!ETHEREUM_CHECKOUT_ID.test(checkoutId)) return COLLECTION_PATH;
    const observe = observeCheckoutReservation(checkoutId);
    const checkout = await checkoutApi.status(checkoutId);
    observe(checkout);
    if (['submitting', 'pending'].includes(checkout.status) && !persistCheckoutReservation(checkout)) {
      throw new ReservationStorageError(
        'Couldn’t save this checkout. Check earlier pending checkouts if you’ve reached the limit. Otherwise, enable browser storage or free up space, then retry.',
      );
    }
    return checkout.returnUrl ?? COLLECTION_PATH;
  }
  if (!search) return COLLECTION_PATH;
  const entry = parseCheckoutEntry(search, window.location.origin);
  const url = new URL(entry.callbackUrl ?? COLLECTION_PATH, window.location.origin);
  if (entry.state) url.searchParams.set('state', entry.state);
  return url.href;
}

export default function CheckoutPage(location: CheckoutLocation) {
  const { mutate, isPending, error } = useMutation({ mutationFn: resolveReturnUrl, networkMode: 'always' });
  const handleReturn = () => mutate(location, {
    onSuccess: href => {
      const url = new URL(href, window.location.origin);
      if (url.protocol === 'http:' || url.protocol === 'https:') window.location.assign(url.href);
      else navigate(COLLECTION_PATH);
    },
    onError: error => {
      if (!location.checkoutId || checkoutNotFound(error)) navigate(COLLECTION_PATH);
    },
  });

  return (
    <div className="page checkout-placeholder">
      <ShopHeader showXLink />
      <main className="checkout-placeholder__content">
        <h2>coming soon</h2>
        <button type="button" className="secondary-light" aria-label="return" onClick={handleReturn} disabled={isPending}>
          ←
        </button>
        {error && <p className="small" role="alert">
          {error instanceof ReservationStorageError ? error.message : 'Couldn’t load the return link. Try again.'}
        </p>}
      </main>
    </div>
  );
}
