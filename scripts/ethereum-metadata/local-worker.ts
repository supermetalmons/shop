import { ethereumPlaceholderMetadata } from '../../shared/ethereum/placeholderMetadata.ts';
import { ETHEREUM_ITEM_KINDS, ethereumItemDisplayIdMaximum, ethereumItemKindNumber, ethereumMetadataTokenId } from '../../shared/ethereum/protocol.ts';

export default {
  fetch(request: Request): Response {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      ...headers, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
    } });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, HEAD, OPTIONS' } });
    const match = new URL(request.url).pathname.match(/^\/(111k-sepolia|111k)\/([1-9]\d{0,6})\.json$/);
    if (!match) return new Response('Not found', { status: 404, headers });
    const tokenId = Number(match[2]);
    for (const kind of ETHEREUM_ITEM_KINDS) {
      const first = Number(ethereumMetadataTokenId(kind, 1));
      const displayId = tokenId - first + 1;
      if (displayId < 1 || displayId > ethereumItemDisplayIdMaximum(kind)) continue;
      const metadata = ethereumPlaceholderMetadata(ethereumItemKindNumber(kind), displayId, match[1] === '111k' ? 'mainnet' : 'sepolia');
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(metadata), { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404, headers });
  },
};
