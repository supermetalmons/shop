import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMonsApiOrigin } from '../src/lib/monsApiOrigin.ts';
import { rewriteDependencyPublicRpcFallbacks } from '../vite.config.ts';

test('dependency RPC fallbacks use the same configured mons API origin', () => {
  const apiOrigin = normalizeMonsApiOrigin('https://candidate-api.example/');
  assert.equal(normalizeMonsApiOrigin(undefined), 'https://api.mons.shop');
  const source = [
    'https://api.mainnet-beta.solana.com/',
    'http://api.mainnet-beta.solana.com',
    'https://api.devnet.solana.com/',
    'http://api.devnet.solana.com',
  ].join(' ');
  const transformed = rewriteDependencyPublicRpcFallbacks(source, '/repo/node_modules/solana/index.js', apiOrigin);

  assert.equal(
    transformed,
    [
      'https://candidate-api.example/rpc/mainnet-beta',
      'https://candidate-api.example/rpc/mainnet-beta',
      'https://candidate-api.example/rpc/devnet',
      'https://candidate-api.example/rpc/devnet',
    ].join(' '),
  );
});

test('dependency RPC fallback rewriting never invents an unsupported testnet route', () => {
  const source = 'https://api.testnet.solana.com http://api.testnet.solana.com/';
  assert.equal(
    rewriteDependencyPublicRpcFallbacks(source, '/repo/node_modules/solana/index.js', normalizeMonsApiOrigin(undefined)),
    undefined,
  );
  assert.doesNotMatch(source, /api\.mons\.shop\/rpc\/testnet/);
});

test('dependency RPC fallback rewriting does not touch application source', () => {
  const source = 'https://api.mainnet-beta.solana.com/';
  assert.equal(rewriteDependencyPublicRpcFallbacks(source, '/repo/src/app.ts', normalizeMonsApiOrigin(undefined)), undefined);
});
