import { ethereumMetadataBaseUri } from './config.ts';
import { ETHEREUM_ITEM_KINDS, ethereumItemDisplayIdMaximum, ethereumMetadataTokenId, normalizeEthereumTokenId } from './protocol.ts';

const tokenRanges = ETHEREUM_ITEM_KINDS.map(kind => ({
  first: BigInt(ethereumMetadataTokenId(kind, 1)),
  last: BigInt(ethereumMetadataTokenId(kind, ethereumItemDisplayIdMaximum(kind))),
}));

export function ethereumTokenMetadataUri(scope: { chainId: number; metadataBaseUri: string }, tokenId: string): string {
  if (normalizeEthereumTokenId(tokenId) !== tokenId || !tokenRanges.some(range => BigInt(tokenId) >= range.first && BigInt(tokenId) <= range.last)) {
    throw new Error('Invalid Ethereum metadata token ID');
  }
  return `${ethereumMetadataBaseUri(scope.metadataBaseUri, scope.chainId)}${tokenId}.json`;
}
