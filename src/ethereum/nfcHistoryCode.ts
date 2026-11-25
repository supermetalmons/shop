import nacl from 'tweetnacl';
import { isTarotClaimCode, isTarotTokenId } from '../../shared/ethereum/tarotCard';

type Browser = Pick<Window, 'crypto' | 'localStorage'>;
const keyPrefix = 'mons.shop.tarot.history-key:v1:';
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));

function readKey(storage: Storage, name: string): Uint8Array | null {
  const value = storage.getItem(name);
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  return decode(value);
}

function wrappingKey(browser: Browser) {
  const storage = browser.localStorage;
  for (const name of Object.keys(storage)) {
    if (!name.startsWith(keyPrefix)) continue;
    const key = readKey(storage, name);
    if (key) return { id: name.slice(keyPrefix.length), key };
  }
  // Simultaneous first visits can each finish with their own immutable key.
  const id = encode(browser.crypto.getRandomValues(new Uint8Array(16)));
  const key = browser.crypto.getRandomValues(new Uint8Array(nacl.secretbox.keyLength));
  const encoded = encode(key);
  storage.setItem(keyPrefix + id, encoded);
  return storage.getItem(keyPrefix + id) === encoded ? { id, key } : null;
}

export function sealNfcHistoryCode(browser: Browser, tokenId: number, code: string, testnet: boolean): string | null {
  if (!isTarotTokenId(tokenId) || !isTarotClaimCode(code) || typeof testnet !== 'boolean') return null;
  try {
    const wrapping = wrappingKey(browser);
    if (!wrapping) return null;
    const nonce = browser.crypto.getRandomValues(new Uint8Array(nacl.secretbox.nonceLength));
    const message = new TextEncoder().encode(`${testnet ? 11155111 : 1}:${tokenId}:${code}`);
    const box = nacl.secretbox(message, nonce, wrapping.key);
    return `sealed2.${wrapping.id}.${encode(nonce)}.${encode(box)}`;
  } catch { return null; }
}

export function openNfcHistoryCode(browser: Browser, tokenId: number, entry: unknown, testnet: boolean): string | null {
  if (typeof testnet !== 'boolean' || typeof entry !== 'string' || entry.length > 160 ||
    !(entry.startsWith('sealed2.') || testnet && entry.startsWith('sealed1.'))) return null;
  try {
    const [version, id, nonce, box, extra] = entry.split('.');
    if (extra !== undefined || !id || !nonce || !box) return null;
    const key = readKey(browser.localStorage, keyPrefix + id);
    if (!key) return null;
    const message = nacl.secretbox.open(decode(box), decode(nonce), key);
    if (!message) return null;
    const parts = new TextDecoder().decode(message).split(':');
    const [chain, card, code] = version === 'sealed1' ? ['11155111', ...parts] : parts;
    return parts.length === (version === 'sealed1' ? 2 : 3) && chain === String(testnet ? 11155111 : 1) &&
      card === String(tokenId) && isTarotClaimCode(code) ? code : null;
  } catch { return null; }
}
