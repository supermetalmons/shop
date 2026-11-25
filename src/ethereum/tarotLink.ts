import type { TarotRequest } from '../../shared/ethereum/tarot';
import { isTarotClaimCode, isTarotTokenId } from '../../shared/ethereum/tarotCard';

export type NfcLink =
  | { kind: 'placeholder'; key: string }
  | { kind: 'invalid'; key: string }
  | { kind: 'artwork'; key: string; tokenId: number }
  | { kind: 'tarot'; key: string; request: TarotRequest };

export function resolveNfcLink(search: string, savedCode?: (tokenId: number, testnet: boolean) => string | null): NfcLink {
  const params = new URLSearchParams(search);
  const codes = params.getAll('code');
  const ids = params.getAll('tokenId');
  const testnets = params.getAll('testnet');
  if (codes.length === 1 && codes[0] === 'basel' && !ids.length && !testnets.length) return { kind: 'placeholder', key: 'basel' };
  const tokenId = ids.length === 1 && /^[1-9]\d{0,2}$/.test(ids[0]) ? Number(ids[0]) : NaN;
  if (!isTarotTokenId(tokenId)) return { kind: 'invalid', key: 'invalid' };
  const testnet = testnets.length === 0 || testnets.length === 1 && testnets[0] === 'false'
    ? false : testnets.length === 1 && testnets[0] === 'true' ? true : null;
  if (testnet !== null && codes.length <= 1) {
    const code = (codes[0] ?? savedCode?.(tokenId, testnet))?.toLowerCase();
    if (code && isTarotClaimCode(code)) {
      return { kind: 'tarot', key: `tarot:${testnet ? 11155111 : 1}:${tokenId}:${code}`, request: { code, tokenId, testnet } };
    }
  }
  return { kind: 'artwork', key: `artwork:${testnet === null ? 'invalid' : testnet ? 11155111 : 1}:${tokenId}`, tokenId };
}
