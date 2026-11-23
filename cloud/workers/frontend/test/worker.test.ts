import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { apiServiceRequest, handleFrontendRequest } from '../src/index.ts';

function fetcher(fetch: Fetcher['fetch']): Fetcher {
  return { fetch, connect: () => { throw new Error('unexpected connect'); } };
}

test('gateway strips only the /api prefix and preserves request data', async () => {
  const request = new Request('https://mons.shop/api/profile/state?view=full', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer token',
      Cookie: 'session=value',
      'Content-Type': 'application/json',
    },
    body: '{"hello":"world"}',
  });
  const forwarded = apiServiceRequest(request);
  assert.ok(forwarded);
  assert.equal(forwarded.url, 'https://mons.shop/profile/state?view=full');
  assert.equal(forwarded.method, 'POST');
  assert.equal(forwarded.headers.get('authorization'), 'Bearer token');
  assert.equal(forwarded.headers.get('cookie'), 'session=value');
  assert.equal(await forwarded.text(), '{"hello":"world"}');
  assert.equal(apiServiceRequest(new Request('https://mons.shop/api')), null);
  assert.equal(apiServiceRequest(new Request('https://mons.shop/profile/state')), null);
});

test('gateway returns API responses and leaves assets on the asset binding', async () => {
  const calls: string[] = [];
  const env = {
    MONS_API: fetcher(async (request) => {
      calls.push(`api:${new URL(request instanceof Request ? request.url : String(request)).pathname}`);
      return new Response('api', { headers: { 'Set-Cookie': 'session=value; HttpOnly' } });
    }),
    ASSETS: fetcher(async (request) => {
      calls.push(`asset:${new URL(request instanceof Request ? request.url : String(request)).pathname}`);
      return new Response('asset');
    }),
  };
  const api = await handleFrontendRequest(new Request('https://mons.shop/api/auth/anonymous/session'), env);
  assert.equal(await api.text(), 'api');
  assert.equal(api.headers.get('set-cookie'), 'session=value; HttpOnly');
  const asset = await handleFrontendRequest(new Request('https://mons.shop/assets/app.js'), env);
  assert.equal(await asset.text(), 'asset');
  assert.deepEqual(calls, ['api:/auth/anonymous/session', 'asset:/assets/app.js']);
});

test('gateway preserves client cancellation through the API service request', async () => {
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  let forwardedSignal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const env = {
    MONS_API: fetcher(async (input) => {
      assert.ok(input instanceof Request);
      forwardedSignal = input.signal;
      markStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      });
    }),
    ASSETS: fetcher(async () => {
      assert.fail('API requests must not reach the asset binding');
    }),
  };
  const incoming = new Request('https://mons.shop/api/inventory', {
    signal: controller.signal,
  });
  const response = handleFrontendRequest(incoming, env);
  await started;
  assert.ok(forwardedSignal);
  assert.notEqual(forwardedSignal, incoming.signal);
  assert.equal(forwardedSignal.aborted, false);
  controller.abort(reason);
  const cancelled = await response;
  assert.equal(cancelled.status, 499);
  assert.equal(await cancelled.text(), '');
  assert.match(cancelled.headers.get('cache-control') || '', /no-store/);
  assert.equal(forwardedSignal.aborted, true);
  assert.equal(forwardedSignal.reason, reason);
});

test('gateway preserves non-cancellation service failures', async () => {
  const failure = new Error('service unavailable');
  const env = {
    MONS_API: fetcher(async () => {
      throw failure;
    }),
    ASSETS: fetcher(async () => {
      assert.fail('API requests must not reach the asset binding');
    }),
  };
  await assert.rejects(
    handleFrontendRequest(new Request('https://mons.shop/api/inventory'), env),
    (error: unknown) => error === failure,
  );
});

test('NFC HTML is never cached or sent as a referrer, including slash and placeholder URLs', async () => {
  const env = {
    MONS_API: fetcher(async () => { assert.fail('NFC HTML must not reach the API'); }),
    ASSETS: fetcher(async () => new Response('<html>app</html>', {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=86400' },
    })),
  };
  for (const path of ['/nfc?code=basel', '/nfc?code=private&tokenId=1&testnet=true', '/nfc/?code=private', '/nfc///?code=private']) {
    const response = await handleFrontendRequest(new Request(`https://mons.shop${path}`), env);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
    assert.equal(await response.text(), '<html>app</html>');
  }
  const ordinary = await handleFrontendRequest(new Request('https://mons.shop/111k_devnet'), env);
  assert.equal(ordinary.headers.get('Cache-Control'), 'public, max-age=86400');
  const config = JSON.parse(readFileSync(new URL('../../../../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(config.assets.run_worker_first.includes('/nfc'));
  assert.ok(config.assets.run_worker_first.includes('/nfc/*'));
  assert.equal(config.assets.run_worker_first.includes('/nfc/'), false);
});
