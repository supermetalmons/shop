import { useMiNoteEthereumWallet } from '../hooks/useMiNoteEthereumWallet';
import { CheckoutPageContent } from './CheckoutPageContent';
import type { CheckoutLocation } from './useEthereumCheckout';

export default function ShippingCheckoutPage(location: CheckoutLocation) {
  const wallet = useMiNoteEthereumWallet(true);
  return <CheckoutPageContent {...location} wallet={wallet} />;
}
