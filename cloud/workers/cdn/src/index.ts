const prefixes = new Set(['111k', '111k-sepolia']);
const maximumMetadataBytes = 128 * 1024;

function responseHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, If-None-Match, If-Modified-Since',
    'Access-Control-Expose-Headers': 'ETag, Content-Length, Last-Modified',
    'X-Content-Type-Options': 'nosniff',
  });
}

function objectKey(url: URL): string | null {
  const match = /^\/([^/]+)\/([1-9][0-9]*)\.json$/.exec(url.pathname);
  if (!match || !prefixes.has(match[1])) return null;
  const tokenId = Number(match[2]);
  if (!Number.isSafeInteger(tokenId) || !((tokenId <= 117_171) ||
    (tokenId >= 1_000_001 && tokenId <= 1_222_222) ||
    (tokenId >= 2_000_001 && tokenId <= 2_005_555))) return null;
  return `${match[1]}/${match[2]}.json`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = responseHeaders();
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      headers.set('Allow', 'GET, HEAD, OPTIONS');
      return new Response(null, { status: 405, headers });
    }
    const key = objectKey(new URL(request.url));
    if (!key) return new Response(null, { status: 404, headers });
    try {
      let object: R2Object | null;
      let body: ReadableStream | null = null;
      if (request.method === 'HEAD') object = await env.METADATA_BUCKET.head(key);
      else {
        const fetched = await env.METADATA_BUCKET.get(key);
        object = fetched;
        body = fetched?.body ?? null;
      }
      if (!object) return new Response(null, { status: 404, headers });
      if (object.size > maximumMetadataBytes) {
        await body?.cancel();
        return new Response(null, { status: 502, headers });
      }
      headers.set('Content-Type', 'application/json; charset=utf-8');
      headers.set('Content-Length', String(object.size));
      headers.set('ETag', object.httpEtag);
      headers.set('Last-Modified', object.uploaded.toUTCString());
      return new Response(body, { headers });
    } catch {
      console.error('metadata_read_failed', { key });
      return new Response(null, { status: 503, headers });
    }
  },
} satisfies ExportedHandler<Env>;
