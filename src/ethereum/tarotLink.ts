import type { TarotRequest } from '../../shared/ethereum/tarot';
import { isTarotClaimCode, isTarotTokenId } from '../../shared/ethereum/tarotCard';

export type NfcLink =
  | { kind: 'placeholder'; key: string }
  | { kind: 'invalid'; key: string }
  | { kind: 'artwork'; key: string; tokenId: number }
  | { kind: 'tarot'; key: string; request: TarotRequest };

export function resolveNfcLink(search: string, savedCode?: (tokenId: number) => string | null): NfcLink {
  const params = new URLSearchParams(search);
  const codes = params.getAll('code');
  const ids = params.getAll('tokenId');
  const testnets = params.getAll('testnet');
  if (codes.length === 1 && codes[0] === 'basel' && !ids.length && !testnets.length) return { kind: 'placeholder', key: 'basel' };
  const tokenId = ids.length === 1 && /^[1-9]\d{0,2}$/.test(ids[0]) ? Number(ids[0]) : NaN;
  if (!isTarotTokenId(tokenId)) return { kind: 'invalid', key: 'invalid' };
  if (testnets.length === 1 && testnets[0] === 'true' && codes.length <= 1) {
    const code = (codes[0] ?? savedCode?.(tokenId))?.toLowerCase();
    if (code && isTarotClaimCode(code)) {
      return { kind: 'tarot', key: `tarot:${tokenId}:${code}`, request: { code, tokenId, testnet: true } };
    }
  }
  return { kind: 'artwork', key: `artwork:${tokenId}`, tokenId };
}
