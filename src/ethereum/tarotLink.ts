import { isTarotTokenId, type TarotRequest } from '../../shared/ethereum/tarot';

export type NfcLink =
  | { kind: 'placeholder'; key: string }
  | { kind: 'invalid'; key: string }
  | { kind: 'tarot'; key: string; request: TarotRequest };

export function resolveNfcLink(search: string): NfcLink {
  const params = new URLSearchParams(search);
  const values = ['code', 'tokenId', 'testnet'].map(name => params.getAll(name));
  const key = JSON.stringify(values);
  const [codes, ids, testnets] = values;
  if (codes.length === 1 && codes[0] === 'basel' && !ids.length && !testnets.length) return { kind: 'placeholder', key };
  const tokenId = ids.length === 1 && /^[1-9]\d{0,2}$/.test(ids[0]) ? Number(ids[0]) : NaN;
  if (codes.length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(codes[0]) ||
    !isTarotTokenId(tokenId) || testnets.length !== 1 || testnets[0] !== 'true') return { kind: 'invalid', key };
  return { kind: 'tarot', key, request: { code: codes[0].toLowerCase(), tokenId, testnet: true } };
}
