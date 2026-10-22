import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { ETHEREUM_CHECKOUT_ID, type EthereumCheckoutCreateRequest } from '../../shared/ethereum/checkout';

const requests = new Map<string, string>();
type Entry = Omit<EthereumCheckoutCreateRequest, 'requestId'>;

function key(entry: Entry): string {
  return `mons.shop.checkout-entry:${bytesToHex(sha256(utf8ToBytes(JSON.stringify(entry))))}`;
}

export function checkoutEntryRequestId(entry: Entry): string {
  const storageKey = key(entry);
  try {
    const saved = window.sessionStorage.getItem(storageKey);
    if (saved && ETHEREUM_CHECKOUT_ID.test(saved)) return saved;
  } catch {}
  const requestId = requests.get(storageKey) ?? crypto.randomUUID();
  requests.set(storageKey, requestId);
  try { window.sessionStorage.setItem(storageKey, requestId); } catch {}
  return requestId;
}

export function clearCheckoutEntryRequest(entry: Entry): void {
  const storageKey = key(entry);
  requests.delete(storageKey);
  try { window.sessionStorage.removeItem(storageKey); } catch {}
}
