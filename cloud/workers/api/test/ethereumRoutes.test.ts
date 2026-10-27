import assert from 'node:assert/strict';
import test from 'node:test';
import { ETHEREUM_API_PATHS as paths } from '../../../../shared/ethereum/api.ts';
import { ETHEREUM_CHECKOUT_PATHS as checkoutPaths } from '../../../../shared/ethereum/checkout.ts';
import { handleEthereumRequest } from '../src/ethereumHandler.ts';
import { loadApiWorkerIndex } from './cloudflareWorkersTestLoader.ts';
import { failOnDeferredWork } from './deferredWork.ts';

const { handleRequest } = await loadApiWorkerIndex();
const origin = 'https://mons.shop';
const transactionHash = `0x${'aa'.repeat(32)}`;

function environment(limit: RateLimit['limit'] = async () => ({ success: true })): Env {
  return {
    ETHEREUM_111K_CHAIN_ID: '11155111',
    ETHEREUM_111K_CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111',
    ETHEREUM_111K_DEPLOYMENT_BLOCK: '0',
    ETHEREUM_111K_RPC_URL: '',
    ALCHEMY_MI_NOTE_API_KEY: 'test-key',
    PUBLIC_SHOP_RATE_LIMITER: { limit },
    STAFF_AUTH_CHALLENGE_RATE_LIMITER: { limit },
    STAFF_AUTH_SESSION_RATE_LIMITER: { limit },
  } as Env;
}

function request(path: string, method = 'GET', requestOrigin = origin, csrf = true): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method,
    headers: {
      Origin: requestOrigin,
      'CF-Connecting-IP': '127.0.0.1',
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-Mons-CSRF': '1' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify({ transactionHash }) } : {}),
  });
}

test('Ethereum method errors retain Allow headers and precede origin and CSRF checks', async () => {
  for (const [path, allow] of [
    [paths.stats, 'GET, OPTIONS'],
    [paths.transactionsConfirm, 'POST, OPTIONS'],
    [paths.addresses, 'GET, POST, OPTIONS'],
    [checkoutPaths.status, 'GET, OPTIONS'],
  ]) {
    const response = await handleEthereumRequest(request(path, 'PUT', 'https://untrusted.example', false), environment(), path);
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.get('Allow'), allow, path);
    assert.deepEqual(await response.json(), { ok: false, error: { code: 'invalid-argument', message: 'Method not allowed.' } });
  }
});

test('Ethereum addresses accept GET and POST and retain POST CSRF before session verification', async () => {
  for (const method of ['GET', 'POST']) {
    const response = await handleEthereumRequest(request(paths.addresses, method), environment(), paths.addresses);
    assert.equal(response.status, 401, method);
  }
  const response = await handleEthereumRequest(request(paths.addresses, 'POST', origin, false), environment(), paths.addresses);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'permission-denied', message: 'Invalid Ethereum request.' } });
});

test('Ethereum checkout status retains partner preflight and denies partner mutations', async () => {
  for (const partner of ['https://vvv.so', 'https://www.vvv.so']) {
    const preflight = await handleRequest(request(checkoutPaths.status, 'OPTIONS', partner), environment(), failOnDeferredWork, { log: () => undefined });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), partner);
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
    const status = await handleRequest(request(checkoutPaths.status, 'GET', partner), environment(), failOnDeferredWork, { log: () => undefined });
    assert.equal(status.status, 400);
    assert.equal(status.headers.get('Access-Control-Allow-Origin'), partner);
    const mutation = await handleEthereumRequest(request(checkoutPaths.create, 'POST', partner), environment(), checkoutPaths.create);
    assert.equal(mutation.status, 403);
  }
});

test('Ethereum direct unknown paths retain fallback behavior while Worker routes return not found', async () => {
  for (const [path, expectedStatus, expectedLimitCalls] of [
    ['/ethereum/unknown', 401, 0],
    ['/ethereum/auth/unknown', 400, 0],
    ['/ethereum/111k/checkout/unknown', 400, 1],
  ] as const) {
    const getResponse = await handleEthereumRequest(request(path), environment(), path);
    assert.equal(getResponse.status, 405);
    assert.equal(getResponse.headers.get('Allow'), 'POST, OPTIONS');
    let limitCalls = 0;
    const directResponse = await handleEthereumRequest(request(path, 'POST'), environment(async () => {
      limitCalls += 1;
      return { success: true };
    }), path);
    assert.equal(directResponse.status, expectedStatus, path);
    assert.equal(limitCalls, expectedLimitCalls, path);
    const response = await handleRequest(request(path, 'POST'), environment(), failOnDeferredWork, { log: () => undefined });
    assert.equal(response.status, 404, path);
  }
});

test('Ethereum public transaction confirmation records provider metrics without a session', async (context) => {
  let elapsed = 0;
  context.mock.method(performance, 'now', () => elapsed);
  let rateLimitCalls = 0;
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const response = await handleRequest(request(paths.transactionsConfirm, 'POST'), environment(async () => {
    rateLimitCalls += 1;
    return { success: true };
  }), failOnDeferredWork, {
    providerFetch: async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { method: string; id: number };
      calls.push(payload.method);
      elapsed += 5;
      assert.ok(['eth_chainId', 'eth_getTransactionReceipt'].includes(payload.method));
      return Response.json({ jsonrpc: '2.0', id: payload.id, result: payload.method === 'eth_chainId' ? '0xaa36a7' : null });
    },
    log: entry => logs.push(entry),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'pending', confirmations: 0, items: [], burnedTokenIds: [] });
  assert.deepEqual(calls.sort(), ['eth_chainId', 'eth_getTransactionReceipt']);
  assert.equal(rateLimitCalls, 1);
  const metrics = logs.find(entry => entry.event === 'shop_api_request');
  assert.equal(metrics?.upstreamCalls, 2);
  assert.equal(metrics?.providerDurationMs, 15);
  assert.match(response.headers.get('Server-Timing') || '', /provider;dur=15\.0/);
});

test('Ethereum failed provider calls reach terminal metrics and preflight makes no provider calls', async (context) => {
  let elapsed = 0;
  context.mock.method(performance, 'now', () => elapsed);
  context.mock.method(console, 'error', () => undefined);
  const logs: Record<string, unknown>[] = [];
  const dependencies = {
    providerFetch: async () => {
      elapsed += 7;
      throw new Error('Provider unavailable');
    },
    log: (entry: Record<string, unknown>) => logs.push(entry),
  };
  const failed = await handleRequest(request(paths.stats), environment(), failOnDeferredWork, dependencies);
  assert.equal(failed.status, 503);
  assert.equal(logs.at(-1)?.upstreamCalls, 1);
  assert.equal(logs.at(-1)?.providerDurationMs, 7);
  assert.match(failed.headers.get('Server-Timing') || '', /provider;dur=7\.0/);
  const preflight = await handleRequest(request(paths.stats, 'OPTIONS'), environment(), failOnDeferredWork, dependencies);
  assert.equal(preflight.status, 204);
  assert.equal(logs.at(-1)?.upstreamCalls, 0);
  assert.equal(logs.at(-1)?.providerDurationMs, 0);
});
