import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createScriptSolanaConnection, resolveScriptSolanaRpcUrl, scriptSolanaRpcHost } from '../scripts/shared/solanaRpcEnvironment.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'solana-rpc-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('explicit and cluster RPC overrides take precedence over Helius without exposing credentials', t => {
  const root = fixture(t);
  const env = { HELIUS_API_KEY: 'fixture-key', TWO_CONFIG_DEVNET_RPC_URL: 'https://cluster.example/hidden-token' };
  assert.equal(resolveScriptSolanaRpcUrl({ cluster: 'devnet', root, env, explicitUrl: 'https://explicit.example/?token=other-fixture-key' }),
    'https://explicit.example/?token=other-fixture-key');
  assert.equal(resolveScriptSolanaRpcUrl({ cluster: 'devnet', root, env }), 'https://cluster.example/hidden-token');
  assert.equal(scriptSolanaRpcHost('https://user:password@explicit.example/private-token?api-key=fixture-key'), 'explicit.example');
  assert.equal(scriptSolanaRpcHost('invalid-secret-value'), 'invalid RPC host');
  for (const explicitUrl of ['http://rpc.example/?api-key=private-test-key', 'private-test-key']) {
    assert.throws(() => resolveScriptSolanaRpcUrl({ cluster: 'devnet', root, env, explicitUrl }), error => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes('private-test-key'), false); return true;
    });
  }
});

test('Helius env credentials select the requested supported cluster and public RPC is the final fallback', t => {
  const root = fixture(t);
  for (const [cluster, host] of [['devnet', 'devnet.helius-rpc.com'], ['mainnet-beta', 'mainnet.helius-rpc.com']] as const) {
    const url = new URL(resolveScriptSolanaRpcUrl({ cluster, root, env: { HELIUS_API_KEY: 'fixture key+encoded' } }));
    assert.equal(url.hostname, host); assert.equal(url.searchParams.get('api-key'), 'fixture key+encoded');
  }
  assert.equal(scriptSolanaRpcHost(resolveScriptSolanaRpcUrl({ cluster: 'devnet', root, env: {} })), 'api.devnet.solana.com');
  assert.equal(scriptSolanaRpcHost(resolveScriptSolanaRpcUrl({ cluster: 'testnet', root, env: { HELIUS_API_KEY: 'fixture-key' } })), 'api.testnet.solana.com');
});

test('known project env files are parsed without mutating process environment', t => {
  const root = fixture(t);
  const before = process.env.HELIUS_API_KEY;
  writeFileSync(path.join(root, '.env'), 'HELIUS_API_KEY=env-file-key\n');
  writeFileSync(path.join(root, '.env.local'), 'export HELIUS_API_KEY="local-file-key" # local override\nUNRELATED_SECRET=unused\n');
  const resolve = (env: Record<string, string | undefined> = {}) =>
    new URL(resolveScriptSolanaRpcUrl({ cluster: 'devnet', root, env })).searchParams.get('api-key');
  assert.equal(resolve(), 'local-file-key');
  assert.equal(resolve({ HELIUS_API_KEY: 'process-key' }), 'process-key');
  rmSync(path.join(root, '.env.local'));
  assert.equal(resolve(), 'env-file-key');
  assert.equal(process.env.HELIUS_API_KEY, before);
});

test('a worktree can use its primary checkout env while local credentials retain priority', t => {
  const root = fixture(t);
  const primary = path.join(root, 'primary');
  const worktree = path.join(root, 'worktree');
  mkdirSync(primary);
  const git = (...args: string[]) => execFileSync('git', args, { stdio: 'ignore' });
  git('init', '-q', primary);
  git('-C', primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'fixture');
  git('-C', primary, 'worktree', 'add', '--detach', '--no-checkout', worktree);
  writeFileSync(path.join(primary, '.env.local'), 'HELIUS_API_KEY=primary-key\n');
  const resolve = () => new URL(resolveScriptSolanaRpcUrl({ cluster: 'devnet', root: worktree, env: {} })).searchParams.get('api-key');
  assert.equal(resolve(), 'primary-key');
  writeFileSync(path.join(worktree, '.env'), 'HELIUS_API_KEY=worktree-key\n');
  assert.equal(resolve(), 'worktree-key');
});

test('transient HTTP responses are retried with the identical RPC request', async t => {
  const root = fixture(t);
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    if (bodies.length < 3) return new Response('do not log this upstream body', { status: bodies.length === 1 ? 429 : 503 });
    const body = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: '2.0', id: body.id, result: 'fixture-genesis' });
  });
  const connection = createScriptSolanaConnection({ cluster: 'devnet', root, env: { HELIUS_API_KEY: 'private-test-key' } });
  assert.equal(await connection.getGenesisHash(), 'fixture-genesis');
  assert.equal(bodies.length, 3); assert.equal(new Set(bodies).size, 1);
});

test('retry exhaustion is bounded and never includes upstream credential URLs', async t => {
  const root = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('https://devnet.helius-rpc.com/?api-key=private-test-key', { status: 504 });
  });
  const connection = createScriptSolanaConnection({ cluster: 'devnet', root, env: { HELIUS_API_KEY: 'private-test-key' } });
  await assert.rejects(connection.getGenesisHash(), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /HTTP 504 after 4 attempt/);
    assert.equal(error.message.includes('private-test-key'), false); assert.equal(error.message.includes('https://'), false); return true;
  });
  assert.equal(calls, 4);
});

test('RPC error payloads and thrown transport errors redact URLs and API keys', async t => {
  const root = fixture(t);
  const endpoint = 'https://devnet.helius-rpc.com/?api-key=private-test-key';
  const connection = createScriptSolanaConnection({ cluster: 'devnet', root, env: {}, explicitUrl: endpoint });
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000,
      message: `Invalid private-test-key at ${endpoint}`, data: { [endpoint]: { reason: 'private-test-key' } } } });
  });
  const safe = (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(`${error.message} ${JSON.stringify(error)}`.includes('private-test-key'), false);
    assert.equal(`${error.message} ${JSON.stringify(error)}`.includes('https://'), false);
    return true;
  };
  await assert.rejects(connection.getGenesisHash(), safe);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(`Transport failed for ${endpoint}`); });
  await assert.rejects(connection.getGenesisHash(), safe);
});
