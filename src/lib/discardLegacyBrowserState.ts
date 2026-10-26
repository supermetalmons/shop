import { ETHEREUM_CHECKOUT_ID } from '../../shared/ethereum/checkout.ts';
import { isRetiredPendingPreorder } from './preorderPending';

const RECOVERY_PREFIXES = ['mons:preorder-recovery:v1:', 'mons:preorder-recovery:v2:', 'mons:preorder-recovery:v3:'];
const RESERVATION_PREFIX = 'mons.shop.ethereum-checkout-reservation:';

function isRetiredReservationKey(key: string): boolean {
  if (!key.startsWith(RESERVATION_PREFIX)) return false;
  const parts = key.slice(RESERVATION_PREFIX.length).split(':');
  return parts.length === 2 && ETHEREUM_CHECKOUT_ID.test(parts[0]) &&
    (parts[1] === 'unknown' || ETHEREUM_CHECKOUT_ID.test(parts[1]));
}

export function discardLegacyBrowserState(): void {
  if (typeof window === 'undefined') return;
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[name];
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
      for (const key of keys) {
        if (!key) continue;
        try {
          if (RECOVERY_PREFIXES.some(prefix => key.startsWith(prefix)) || isRetiredReservationKey(key)) {
            storage.removeItem(key);
          } else if (key.startsWith('mons:preorder:v1:')) {
            const value = storage.getItem(key);
            if (isRetiredPendingPreorder(JSON.parse(value || 'null')) && storage.getItem(key) === value) storage.removeItem(key);
          }
        } catch {}
      }
    } catch {}
  }
}
