import type { TarotRequest } from '../../shared/ethereum/tarot';
import { isTarotClaimCode } from '../../shared/ethereum/tarotCard';
import { canonicalProductionUrl } from '../lib/canonicalOrigin';
import { normalizePathname, withoutNfcScan } from '../navigation';
import { openNfcHistoryCode, sealNfcHistoryCode } from './nfcHistoryCode';
import { resolveNfcLink } from './tarotLink';

type ScanWindow = Window & { nfcUnsavedCodes?: Map<string, string>; nfcDeniedEntries?: Map<string, string> };
type Store = 'localStorage' | 'sessionStorage';
const storageKey = (tokenId: number, testnet: boolean) => `mons.shop.tarot.claim:${testnet ? 'sepolia' : 'mainnet'}:${tokenId}`;

function readCode(browser: ScanWindow, store: Store, key: string): string | null {
  const cached = browser.nfcUnsavedCodes?.get(key);
  if (cached) return cached;
  try { return browser[store].getItem(key); }
  catch { return null; }
}

function writeCode(browser: ScanWindow, store: Store, key: string, code: string): boolean {
  try {
    browser[store].setItem(key, code);
    if (browser[store].getItem(key) === code) {
      browser.nfcUnsavedCodes?.delete(key);
      return true;
    }
  } catch {}
  (browser.nfcUnsavedCodes ??= new Map()).set(key, code);
  return false;
}

function readCandidate(browser: ScanWindow, tokenId: number, testnet: boolean, entry: string): string | null {
  const key = `${storageKey(tokenId, testnet)}:${entry}`;
  return openNfcHistoryCode(browser, tokenId, entry, testnet) ?? readCode(browser, 'sessionStorage', key) ?? readCode(browser, 'localStorage', key);
}

function sessionCode(raw: string | null): { code: string; baseline?: string | null } | null {
  if (!raw) return null;
  if (isTarotClaimCode(raw)) return { code: raw };
  try {
    const value = JSON.parse(raw);
    if (value && typeof value.code === 'string' && isTarotClaimCode(value.code) &&
      (value.baseline === null || typeof value.baseline === 'string')) return value;
  } catch {}
  return null;
}

function localCode(browser: ScanWindow, key: string): string | null | undefined {
  try { return browser.localStorage.getItem(key); } catch { return undefined; }
}

export function readSavedNfcCode(browser: ScanWindow, tokenId: number, testnet: boolean): string | null {
  if (typeof testnet !== 'boolean') return null;
  const key = storageKey(tokenId, testnet);
  const local = localCode(browser, key);
  const fallback = sessionCode(readCode(browser, 'sessionStorage', key));
  if (fallback && (local == null || local === fallback.baseline)) return fallback.code;
  return local ?? null;
}

function saveCode(browser: ScanWindow, key: string, code: string): boolean {
  const baseline = localCode(browser, key) ?? null;
  try {
    browser.localStorage.setItem(key, code);
    if (browser.localStorage.getItem(key) === code) {
      browser.nfcUnsavedCodes?.delete(key);
      try { browser.sessionStorage.removeItem(key); } catch {}
      return true;
    }
  } catch {}
  return writeCode(browser, 'sessionStorage', key, JSON.stringify({ code, baseline }));
}

function discardMatchingCode(browser: ScanWindow, key: string, code: string): void {
  if (sessionCode(browser.nfcUnsavedCodes?.get(key) ?? null)?.code === code) browser.nfcUnsavedCodes?.delete(key);
  for (const store of ['localStorage', 'sessionStorage'] as const) {
    try {
      if (sessionCode(browser[store].getItem(key))?.code === code) browser[store].removeItem(key);
    } catch {}
  }
}

export function captureNfcScan(browser: ScanWindow): void {
  const { location, history } = browser;
  if (normalizePathname(location.pathname) !== '/nfc') return;
  const url = new URL(location.href);
  if (!url.searchParams.has('code')) return;
  const link = resolveNfcLink(location.search);
  if (link.kind === 'placeholder') return;
  const canonicalUrl = canonicalProductionUrl(location.href);
  if (canonicalUrl) {
    location.replace(canonicalUrl);
    return;
  }

  let state = withoutNfcScan(history.state);
  if (link.kind === 'tarot') {
    const { tokenId, code, testnet } = link.request;
    const key = storageKey(tokenId, testnet);
    const saved = readSavedNfcCode(browser, tokenId, testnet);
    if (saved && saved !== code) {
      let entry = browser.crypto.getRandomValues(new Uint32Array(4)).join('-');
      const candidate = `${key}:${entry}`;
      if (!writeCode(browser, 'sessionStorage', candidate, code)) {
        const sealed = sealNfcHistoryCode(browser, tokenId, code, testnet);
        if (sealed) {
          entry = sealed;
          browser.nfcUnsavedCodes?.delete(candidate);
        }
      }
      state = { ...state, nfcScan: entry };
    } else {
      saveCode(browser, key, code);
    }
  } else {
    state = { ...state, nfcScan: 'artwork' };
  }
  url.searchParams.delete('code');
  history.replaceState(state, '', url.href);
}

export function readScannedCode(browser: ScanWindow, tokenId: number, testnet: boolean): string | null {
  if (typeof testnet !== 'boolean') return null;
  const entry = browser.history.state?.nfcScan;
  if (entry === 'artwork' || (entry && entry === browser.nfcDeniedEntries?.get(storageKey(tokenId, testnet)))) return null;
  const candidate = entry ? readCandidate(browser, tokenId, testnet, entry) : null;
  return candidate ?? readSavedNfcCode(browser, tokenId, testnet);
}

export function settleNfcScan(browser: ScanWindow, request: TarotRequest, accepted: boolean): void {
  const entry = browser.history.state?.nfcScan;
  const key = storageKey(request.tokenId, request.testnet);
  const candidateCode = entry ? readCandidate(browser, request.tokenId, request.testnet, entry) : null;
  if (!accepted) discardMatchingCode(browser, key, request.code);
  if (accepted) {
    const saved = readSavedNfcCode(browser, request.tokenId, request.testnet);
    if (candidateCode !== request.code && saved && saved !== request.code) return;
    if (!saveCode(browser, key, request.code)) return;
  }
  if (!entry || entry === 'artwork' || candidateCode !== request.code) return;
  const candidate = `${key}:${entry}`;
  discardMatchingCode(browser, candidate, request.code);
  let state = withoutNfcScan(browser.history.state);
  if (!accepted) {
    // Reload can use the previous working code; keep this visit on the artwork.
    const denied = browser.nfcDeniedEntries ??= new Map();
    if (!denied.has(key)) denied.set(key, browser.crypto.getRandomValues(new Uint32Array(4)).join('-'));
    state = { ...state, nfcScan: denied.get(key) };
  }
  browser.history.replaceState(state, '');
}
