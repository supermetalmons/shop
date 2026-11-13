import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createScriptHeliusRpc, createScriptSolanaConnection, resolveScriptHeliusRpcUrl } from '../scripts/shared/solanaRpcEnvironment.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'helius-rpc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('DAS keeps Helius mandatory and ignores standard RPC overrides', t => {
  const root = fixture(t);
  const env = { SOLANA_RPC_URL: 'https://rpc.example/', TWO_CONFIG_DEVNET_RPC_URL: 'https://devnet.example/' };
  assert.throws(() => resolveScriptHeliusRpcUrl({ cluster: 'devnet', root, env }), /Missing HELIUS_API_KEY/);
  for (const [cluster, host] of [['devnet', 'devnet'], ['mainnet-beta', 'mainnet'], ['testnet', 'testnet']] as const) {
    const endpoint = new URL(resolveScriptHeliusRpcUrl({ cluster, root, env: { ...env, HELIUS_API_KEY: 'key+with spaces' } }));
    assert.equal(endpoint.hostname, `${host}.helius-rpc.com`);
    assert.equal(endpoint.searchParams.get('api-key'), 'key+with spaces');
  }
});

test('DAS shares local-over-env precedence and primary worktree discovery without environment mutation', t => {
  const root = fixture(t);
  const primary = path.join(root, 'primary');
  const worktree = path.join(root, 'worktree');
  mkdirSync(primary);
  const git = (...args: string[]) => execFileSync('git', args, { stdio: 'ignore' });
  git('init', '-q', primary);
  git('-C', primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'fixture');
  git('-C', primary, 'worktree', 'add', '--detach', '--no-checkout', worktree);
  writeFileSync(path.join(primary, '.env'), 'HELIUS_API_KEY=base-key\n');
  writeFileSync(path.join(primary, '.env.local'), 'HELIUS_API_KEY=local-key\n');
  const before = process.env.HELIUS_API_KEY;
  const resolve = (env: Record<string, string | undefined> = {}) =>
    new URL(resolveScriptHeliusRpcUrl({ cluster: 'devnet', root: worktree, env })).searchParams.get('api-key');
  assert.equal(resolve(), 'local-key');
  writeFileSync(path.join(worktree, '.env'), 'HELIUS_API_KEY=worktree-key\n');
  assert.equal(resolve(), 'worktree-key');
  assert.equal(resolve({ HELIUS_API_KEY: 'process-key' }), 'process-key');
  assert.equal(process.env.HELIUS_API_KEY, before);
});

test('DAS request preserves its method and params through bounded retries and paces every attempt', async t => {
  const root = fixture(t);
  const requests: string[] = [];
  let paced = 0;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    assert.equal(paced, requests.length + 1);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    requests.push(String(init?.body));
    if (requests.length < 3) return new Response('upstream body', { status: 503 });
    return Response.json({ jsonrpc: '2.0', id: 'searchAssets', result: { items: [{ id: 'asset' }] } });
  });
  const rpc = createScriptHeliusRpc({ cluster: 'devnet', root, env: { HELIUS_API_KEY: 'secret' } }, {
    retryDelay: () => 0, beforeAttempt: async () => { paced += 1; },
  });
  assert.deepEqual(await rpc('searchAssets', { page: 1, limit: 1000 }), { items: [{ id: 'asset' }] });
  assert.equal(new Set(requests).size, 1);
  assert.equal(requests.length, 3);
  assert.deepEqual(JSON.parse(requests[0]), { jsonrpc: '2.0', id: 'searchAssets', method: 'searchAssets', params: { page: 1, limit: 1000 } });
});

test('DAS rejects malformed JSON and missing/mismatched response envelopes', async t => {
  const root = fixture(t);
  const rpc = createScriptHeliusRpc({ cluster: 'devnet', root, env: { HELIUS_API_KEY: 'secret' } });
  for (const payload of ['not json', '{}', 'null', '[]', JSON.stringify({ jsonrpc: '2.0', id: 'other', result: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 'getAsset' })]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(payload));
    await assert.rejects(rpc('getAsset', { id: 'asset' }), /invalid JSON|invalid JSON-RPC|no result/);
  }
});

test('collection reads retry transient RPC errors with identical requests and per-attempt pacing', async t => {
  const root = fixture(t);
  for (const method of ['getAsset', 'searchAssets', 'getAssetsByGroup']) {
    for (const code of [-32603, -32005]) {
      const requests: string[] = [];
      const delays: number[] = [];
      let paced = 0;
      t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
        assert.equal(paced, requests.length + 1);
        requests.push(String(init?.body));
        return Response.json({ jsonrpc: '2.0', id: method, ...(requests.length === 1
          ? { error: { code, message: 'Temporary server failure' } }
          : { result: { items: [] } }) });
      });
      const rpc = createScriptHeliusRpc({ cluster: 'devnet', root, env: { HELIUS_API_KEY: 'secret' } }, {
        attempts: 6, retryReadErrors: true, beforeAttempt: async () => { paced += 1; },
        retryDelay: attempt => { delays.push(attempt); return 0; },
      });
      assert.deepEqual(await rpc(method, { page: 3 }), { items: [] });
      assert.equal(requests.length, 2);
      assert.equal(new Set(requests).size, 1);
      assert.deepEqual(delays, [0]);
    }
  }
});

test('HTTP and transient RPC errors share the retry budget and redact the final error', async t => {
  const root = fixture(t);
  let requests = 0;
  let paced = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    assert.equal(paced, ++requests);
    if (requests === 1) return new Response('unavailable', { status: 503 });
    return Response.json({ jsonrpc: '2.0', id: 'searchAssets', error: { code: -32603,
      message: 'Internal error at https://devnet.helius-rpc.com/?api-key=private-fixture-key' } });
  });
  const rpc = createScriptHeliusRpc({ cluster: 'devnet', root, env: { HELIUS_API_KEY: 'private-fixture-key' } }, {
    attempts: 6, retryReadErrors: true, retryDelay: () => 0, beforeAttempt: async () => { paced += 1; },
  });
  await assert.rejects(rpc('searchAssets', { page: 1 }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Internal error/);
    assert.equal(error.message.includes('private-fixture-key'), false);
    assert.equal(error.message.includes('https:'), false);
    return true;
  });
  assert.equal(requests, 6);
});

test('read-error retries require opt-in and exclude permanent errors and mutating or unknown methods', async t => {
  const root = fixture(t);
  const cases: Array<[string, number, boolean]> = [
    ['searchAssets', -32603, false],
    ...[-32600, -32601, -32602].map(code => ['searchAssets', code, true] as [string, number, boolean]),
    ['sendTransaction', -32603, true], ['sendTransaction', -32005, true], ['unknownMethod', -32603, true],
  ];
  for (const [method, code, retryReadErrors] of cases) {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests += 1;
      return Response.json({ jsonrpc: '2.0', id: method, error: { code, message: 'Provider error' } });
    });
    const rpc = createScriptHeliusRpc({ cluster: 'devnet', root, env: { HELIUS_API_KEY: 'secret' } }, {
      attempts: 6, retryReadErrors, retryTransportErrors: true, retryDelay: () => 0,
    });
    await assert.rejects(rpc(method, {}), /Provider error/);
    assert.equal(requests, 1, `${method}: ${code}`);
  }
});

test('DAS retains useful provider errors without exposing credentials and does not retry permanent failures', async t => {
  const root = fixture(t);
  const key = 'private-fixture-key';
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return Response.json({ jsonrpc: '2.0', id: 'getAsset', error: { code: -32601,
      message: `Method not found for ${key} at https://devnet.helius-rpc.com/?api-key=${key}` } });
  });
  const rpc = createScriptHeliusRpc({ cluster: 'devnet', root, env: { HELIUS_API_KEY: key } });
  await assert.rejects(rpc('getAsset', { id: 'asset' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Method not found/);
    assert.equal(error.message.includes(key), false);
    assert.equal(error.message.includes('https:'), false);
    return true;
  });
  assert.equal(requests, 1);
});

test('DAS timeouts and transport retries are bounded and redacted', async t => {
  const root = fixture(t);
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    attempts += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(init?.signal?.aborted, true);
    throw new Error('https://devnet.helius-rpc.com/?api-key=private-fixture-key');
  });
  const rpc = createScriptHeliusRpc({ cluster: 'devnet', root, env: { HELIUS_API_KEY: 'private-fixture-key' } }, {
    timeoutMs: 1, attempts: 2, retryDelay: () => 0, retryTransportErrors: true,
  });
  await assert.rejects(rpc('getAsset', { id: 'asset' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out or was cancelled/);
    assert.equal(error.message.includes('private-fixture-key'), false);
    return true;
  });
  assert.equal(attempts, 2);
});

test('holder RPC adapter preserves confirmed commitment while deployment connections remain finalized', t => {
  const root = fixture(t);
  const options = { cluster: 'devnet' as const, root, env: { HELIUS_API_KEY: 'fixture-key' } };
  const holderConnection = createScriptSolanaConnection({ ...options, explicitUrl: resolveScriptHeliusRpcUrl(options), commitment: 'confirmed' });
  assert.equal(holderConnection.commitment, 'confirmed');
  assert.equal(createScriptSolanaConnection(options).commitment, 'finalized');
});
