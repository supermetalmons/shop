import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../scripts/ethereum-metadata/catalog.ts';
import { verify111kReplacementPublicSamples } from '../scripts/shared/ethereum111kReplacementPublicVerification.ts';

const scope = { chainId: 11155111, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/v99/' };
const metadata = (id: number, extra: Record<string, unknown> = {}) => `${JSON.stringify({ name: `Artwork ${id}`, description: '',
  image: `https://cdn.lil.org/nft/111k/eggs/${id}.png`, attributes: [{ trait_type: 'type', value: 'egg' }],
  aspectRatio: { width: 1, height: 1 }, ...extra })}\n`;
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const mediaHeaders = (url: string) => ({ 'Content-Type': url.endsWith('.glb') ? 'model/gltf-binary'
  : url.endsWith('.mp4') ? 'video/mp4' : 'image/png', 'Access-Control-Allow-Origin': '*', 'Content-Length': '1024' });

test('public replacement proof checks matching CDN JSON and media with at most four concurrent requests', async () => {
  const bodies = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`${index + 1}.json`, metadata(index + 1,
    index === 0 ? { animation_url: 'https://cdn.lil.org/nft/111k/videos/1.mp4' }
      : index === 1 ? { animation_url: 'https://cdn.lil.org/nft/111k/3d/1.glb' } : {})]));
  const hashes = Object.fromEntries(Object.entries(bodies).map(([file, body]) => [file, sha256(body)]));
  const calls: Array<{ method: string; url: string }> = [];
  let active = 0, maximum = 0;
  await verify111kReplacementPublicSamples(scope, hashes, { fetch: (async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET';
    assert.equal(init?.redirect, 'manual'); assert.equal(init?.cache, 'no-store');
    assert(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get('Origin'), 'https://mons.shop');
    calls.push({ method, url }); active++; maximum = Math.max(maximum, active);
    try {
      await new Promise(done => setTimeout(done, 1));
      return method === 'GET' ? new Response(bodies[url.slice(scope.metadataBaseUri.length)], { headers: jsonHeaders })
        : new Response(null, { headers: mediaHeaders(url) });
    } finally { active--; }
  }) as typeof fetch });
  assert.equal(maximum, 4);
  assert.equal(calls.filter(call => call.method === 'GET').length, 10);
  assert.equal(calls.filter(call => call.method === 'HEAD').length, 12);
  assert(calls.some(call => call.url.endsWith('.mp4')));
  assert(calls.some(call => call.url.endsWith('.glb')));
});

test('matching shared media is checked once per verification', async () => {
  const body = metadata(1), calls: string[] = [];
  await verify111kReplacementPublicSamples(scope, { '1.json': sha256(body), '2.json': sha256(body) }, {
    fetch: (async (input, init) => {
      calls.push(`${init?.method}:${input}`);
      return init?.method === 'HEAD' ? new Response(null, { headers: mediaHeaders(String(input)) })
        : new Response(body, { headers: jsonHeaders });
    }) as typeof fetch,
  });
  assert.equal(calls.filter(call => call.startsWith('HEAD:')).length, 1);
});

test('a public CDN body mismatch is rejected before fetching its media', async () => {
  const body = metadata(1), calls: string[] = [];
  await assert.rejects(verify111kReplacementPublicSamples(scope, { '1.json': sha256(body) }, {
    fetch: (async (_input, init) => { calls.push(init!.method!); return new Response(metadata(2), { headers: jsonHeaders }); }) as typeof fetch,
  }), /differs from R2/);
  assert.deepEqual(calls, ['GET']);
});

for (const failure of ['missing', 'redirect', 'html', 'empty', 'cors'] as const) {
  test(`public media ${failure} fails readiness`, async () => {
    const body = metadata(1);
    await assert.rejects(verify111kReplacementPublicSamples(scope, { '1.json': sha256(body) }, {
      fetch: (async (input, init) => {
        if (init?.method === 'GET') return new Response(body, { headers: jsonHeaders });
        return new Response(null, { status: failure === 'missing' ? 404 : failure === 'redirect' ? 302 : 200,
          headers: { ...mediaHeaders(String(input)), ...(failure === 'html' ? { 'Content-Type': 'text/html' } : {}),
            ...(failure === 'empty' ? { 'Content-Length': '0' } : {}), ...(failure === 'cors' ? { 'Access-Control-Allow-Origin': 'https://other.test' } : {}),
            ...(failure === 'redirect' ? { Location: 'https://127.0.0.1/private' } : {}) } });
      }) as typeof fetch,
    }), /verification failed|unavailable/);
  });
}

for (const image of ['https://127.0.0.1/private.png', 'https://cdn.lil.org.evil.test/nft/111k/eggs/1.png',
  'https://cdn.lil.org/nft/111k/eggs/1.png?secret=value', 'https://cdn.lil.org/nft/elsewhere/1.png', 'data:image/svg+xml,<svg/>']) {
  test(`unknown or unsafe media is rejected before any HEAD: ${image.split('?')[0]}`, async () => {
    const body = metadata(1, { image });
    let heads = 0;
    await assert.rejects(verify111kReplacementPublicSamples(scope, { '1.json': sha256(body) }, {
      fetch: (async (_input, init) => { if (init?.method === 'HEAD') heads++; return new Response(body, { headers: jsonHeaders }); }) as typeof fetch,
    }), /unsafe|approved HTTPS/);
    assert.equal(heads, 0);
  });
}

test('metadata reads are size bounded and require the expected public headers', async () => {
  const body = metadata(1);
  for (const headers of [{ ...jsonHeaders, 'Content-Length': String(128 * 1024 + 1) },
    { ...jsonHeaders, 'CF-Cache-Status': 'HIT' }, { ...jsonHeaders, 'Content-Type': 'text/html' }]) {
    await assert.rejects(verify111kReplacementPublicSamples(scope, { '1.json': sha256(body) }, {
      fetch: (async () => new Response(body, { headers })) as typeof fetch,
    }), /invalid/);
  }
});

test('transient HTTP errors retry once with bounded backoff; permanent failures do not retry', async () => {
  const body = metadata(1), waits: number[] = [];
  let gets = 0;
  await verify111kReplacementPublicSamples(scope, { '1.json': sha256(body) }, {
    wait: async ms => { waits.push(ms); },
    fetch: (async (input, init) => init?.method === 'HEAD' ? new Response(null, { headers: mediaHeaders(String(input)) })
      : ++gets === 1 ? new Response(null, { status: 503 }) : new Response(body, { headers: jsonHeaders })) as typeof fetch,
  });
  assert.equal(gets, 2); assert.deepEqual(waits, [250]);
  gets = 0;
  await assert.rejects(verify111kReplacementPublicSamples(scope, { '1.json': sha256(body) }, {
    wait: async () => {}, fetch: (async () => { gets++; return new Response(null, { status: 503 }); }) as typeof fetch,
  }), /HTTP 503/);
  assert.equal(gets, 2);
});
