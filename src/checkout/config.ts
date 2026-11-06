const CHECKOUT_ENABLED = false;

export const loadCheckoutPage = () => CHECKOUT_ENABLED
  ? import('./ShippingCheckoutPage')
  : import('./CheckoutPage');
