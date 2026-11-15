import assert from 'node:assert/strict';
import test from 'node:test';
import { translateSolanaProviderError } from '../src/solanaProviderErrors.ts';
import { SolanaProviderError } from '../src/solanaProvider.ts';
import { deliveryPrepareTestHooks } from '../src/deliveryPrepare.ts';
import { receiptTransferTestHooks } from '../src/receiptTransfer.ts';
import { irlClaimTestHooks } from '../src/irlClaim.ts';
import { rpcCall, fetchAssetProof } from '../src/adminIrlRedeemOnchain.ts';
import { buildRuntime } from '../src/adminIrlRedeemRuntime.ts';
import { API_DROPS } from '../src/dropConfig.ts';
import type { SolanaReadProviderContext } from '../src/solanaReadProvider.ts';

class EndpointError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

function options(signal = new AbortController().signal) {
  return {
    signal,
    providerName: 'Test provider',
    createError: (code: string, message: string, details?: unknown) => new EndpointError(code, message, details),
    notFound: (_failure: SolanaProviderError): EndpointError | undefined => undefined,
  };
}

test('Solana error translation preserves provider classifications and RPC diagnostics', () => {
  const unavailable = 'Test provider is temporarily unavailable.';
  const invalid = 'Test provider returned an invalid response.';
  const cases = [
    ['timeout', 'getAsset', 'deadline-exceeded', 'Test provider request timed out.'],
    ['network', 'getAsset', 'unavailable', unavailable],
    ['network', 'getAssetRest', 'unavailable', invalid],
    ['body', 'getAsset', 'unavailable', unavailable],
    ['body', 'getAssetProofRest', 'unavailable', invalid],
    ['invalid-response', 'getAsset', 'unavailable', invalid],
    ['invalid-response', undefined, 'unavailable', invalid],
    ['http', 'getAssetRest', 'unavailable', unavailable],
    ['not-found', 'getAsset', 'unavailable', unavailable],
  ] as const;
  for (const [kind, method, code, message] of cases) {
    const failure = translateSolanaProviderError(new SolanaProviderError(kind, 'private upstream message', {
      method, status: 404,
    }), options());
    assert.ok(failure instanceof EndpointError);
    assert.deepEqual({ code: failure.code, message: failure.message, details: failure.details }, {
      code, message, details: undefined,
    }, `${kind}:${method}`);
  }
  for (const rpcCode of [undefined, NaN, Infinity, -Infinity, 0, -32005]) {
    for (const method of [undefined, 'getAsset']) {
      const failure = translateSolanaProviderError(new SolanaProviderError('rpc', 'private upstream message', {
        method, rpcCode, rpcData: { private: true },
      }), options());
      assert.equal(failure.code, 'unavailable');
      assert.equal(failure.message, unavailable);
      assert.deepEqual(failure.details, {
        method,
        ...(rpcCode === 0 || rpcCode === -32005 ? { upstreamCode: rpcCode } : {}),
      });
    }
  }
  for (const unknown of [new Error('private failure'), { kind: 'timeout' }, null, 'failure']) {
    assert.equal(translateSolanaProviderError(unknown, options()).message, unavailable);
  }
});

test('Solana error translation delegates only not-found policy and returns its exact error', () => {
  const missing = new SolanaProviderError('not-found', 'missing proof', { resource: 'asset-proof' });
  const expected = new EndpointError('not-found', 'Endpoint-specific message', { assetId: 'asset' });
  const policy = {
    ...options(),
    notFound: (failure: SolanaProviderError) => {
      assert.equal(failure, missing);
      return expected;
    },
  };
  assert.equal(translateSolanaProviderError(missing, policy), expected);
  assert.equal(translateSolanaProviderError(new SolanaProviderError('http', '404', { status: 404 }), policy).code, 'unavailable');
});

test('Solana error translation preserves cancellation identity without hiding independent failures', () => {
  const reason = new Error('client disconnected');
  const signal = AbortSignal.abort(reason);
  for (const error of [reason, new SolanaProviderError('timeout', 'wrapped cancellation', { cause: reason })]) {
    assert.throws(() => translateSolanaProviderError(error, options(signal)), (failure: unknown) => failure === reason);
  }
  const independent = translateSolanaProviderError(new SolanaProviderError('timeout', 'provider failed first'), options(signal));
  assert.equal(independent.code, 'deadline-exceeded');
  assert.equal(independent.message, 'Test provider request timed out.');
});

const drop = API_DROPS.card_nft_2;
const endpoints = [
  {
    name: 'DeliveryPrepareError', providerName: 'Delivery provider',
    read: (context: SolanaReadProviderContext) => deliveryPrepareTestHooks.loadLatestBlockhash(context, deliveryPrepareTestHooks.buildRuntime(drop)),
  },
  {
    name: 'ReceiptTransferError', providerName: 'Receipt transfer provider',
    read: (context: SolanaReadProviderContext) => receiptTransferTestHooks.rpcCall(context, receiptTransferTestHooks.buildRuntime(drop), 'getLatestBlockhash', []),
  },
  {
    name: 'IrlClaimError', providerName: 'Claim provider',
    read: (context: SolanaReadProviderContext) => irlClaimTestHooks.rpcCall(context, irlClaimTestHooks.buildRuntime(drop), 'getLatestBlockhash', []),
  },
  {
    name: 'AdminIrlRedeemPrepareError', providerName: 'Admin IRL redeem provider',
    read: (context: SolanaReadProviderContext) => rpcCall(context, buildRuntime(drop), 'getLatestBlockhash', []),
  },
];

test('Solana endpoints retain their error classes, messages, and upstream diagnostic fields', async () => {
  for (const endpoint of endpoints) {
    await assert.rejects(endpoint.read({
      apiKey: 'helius-test-key',
      signal: new AbortController().signal,
      providerFetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { id: string };
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32600, message: 'private upstream error' } });
      },
    }), {
      name: endpoint.name,
      code: 'unavailable',
      message: `${endpoint.providerName} is temporarily unavailable.`,
      details: { method: 'getLatestBlockhash', upstreamCode: -32600 },
    });
  }
});

test('receipt and claim adapters preserve missing-proof details for RPC and REST responses', async () => {
  const assetId = 'proof-asset';
  const readers = [
    (context: SolanaReadProviderContext) => receiptTransferTestHooks.fetchAssetProof(context, receiptTransferTestHooks.buildRuntime(drop), assetId),
    (context: SolanaReadProviderContext) => irlClaimTestHooks.fetchAssetProof(context, irlClaimTestHooks.buildRuntime(drop), assetId),
    (context: SolanaReadProviderContext) => fetchAssetProof(context, buildRuntime(drop), assetId),
  ];
  for (const read of readers) {
    for (const rest of [false, true]) {
      await assert.rejects(read({
        apiKey: 'helius-test-key',
        signal: new AbortController().signal,
        providerFetch: async (_input, init) => {
          if (!init?.body) return new Response(null, { status: 404 });
          const body = JSON.parse(String(init.body)) as { id: string };
          return Response.json({ jsonrpc: '2.0', id: body.id,
            ...(rest ? { error: { code: -32601, message: 'method not found' } } : { result: null }),
          });
        },
      }), { code: 'not-found', message: 'Asset proof not found', details: rest ? undefined : { assetId } });
    }
  }
});
