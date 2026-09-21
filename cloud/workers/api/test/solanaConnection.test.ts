import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Keypair, SendTransactionError, SystemProgram, Transaction } from '@solana/web3.js';
import { isSignalCancellationError } from '../src/boundedRequest.ts';
import { createSolanaConnection } from '../src/solanaConnection.ts';
import { SolanaProviderError } from '../src/solanaProvider.ts';

function options(fetch: typeof globalThis.fetch) {
  return {
    apiKey: 'test key',
    cluster: 'devnet' as const,
    fetch,
    signal: new AbortController().signal,
    attemptTimeoutMs: 20,
    maxResponseBytes: 1024,
    mapError: (failure: SolanaProviderError) => failure,
  };
}

function rpcResponse(init: RequestInit | undefined, result: unknown): Response {
  const request = JSON.parse(String(init?.body)) as { id: string };
  return Response.json({ jsonrpc: '2.0', id: request.id, result });
}

test('Solana connection preserves RPC requests and disposes successful request timers', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal: AbortSignal | undefined;
  const connection = createSolanaConnection(options(async (input, init) => {
    assert.equal(String(input), 'https://devnet.helius-rpc.com/?api-key=test%20key');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    const request = JSON.parse(String(init?.body));
    assert.equal(request.method, 'getSlot');
    assert.deepEqual(request.params, [{ commitment: 'confirmed' }]);
    requestSignal = init?.signal ?? undefined;
    return rpcResponse(init, 123);
  }));
  assert.equal(await connection.getSlot(), 123);
  context.mock.timers.tick(100);
  assert.equal(requestSignal?.aborted, false);
});

test('Solana connection aborts stalled fetches and maps the attempt timeout', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal: AbortSignal | undefined;
  const mapped = new Error('mapped timeout');
  const connection = createSolanaConnection({
    ...options(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }),
    mapError: (failure) => {
      assert.equal(failure.kind, 'timeout');
      return mapped;
    },
  });
  const rejected = assert.rejects(connection.getSlot(), (error) => error === mapped);
  context.mock.timers.tick(20);
  await rejected;
  assert.equal(requestSignal?.aborted, true);
});

test('Solana connection keeps its deadline active while reading the response body', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  const connection = createSolanaConnection(options(async () => new Response(new ReadableStream<Uint8Array>({
    pull() {
      reading.resolve();
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 }))));
  const rejected = assert.rejects(connection.getSlot(), (error: unknown) =>
    error instanceof SolanaProviderError && error.kind === 'timeout');
  await reading.promise;
  context.mock.timers.tick(20);
  await rejected;
  assert.equal(cancelled, true);
});

for (const sizeSource of ['header', 'stream'] as const) {
  test(`Solana connection rejects ${sizeSource} response overflow and cancels the body`, async () => {
    let cancelled = false;
    const connection = createSolanaConnection({
      ...options(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(33));
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 }), {
        headers: sizeSource === 'header' ? { 'Content-Length': '33' } : undefined,
      })),
      maxResponseBytes: 32,
    });
    await assert.rejects(connection.getSlot(), (error: unknown) =>
      error instanceof SolanaProviderError && error.kind === 'body' && error.bodyFailure === 'too-large');
    assert.equal(cancelled, true);
  });
}

for (const status of [302, 429, 503]) {
  test(`Solana connection disposes HTTP ${status} bodies without reading or retrying`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    let cancelled = false;
    let requestSignal: AbortSignal | undefined;
    const connection = createSolanaConnection(options(async (_input, init) => {
      calls += 1;
      requestSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({
        pull() {
          assert.fail('HTTP failure body was read');
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => undefined);
        },
      }, { highWaterMark: 0 }), { status });
    }));
    await assert.rejects(connection.getSlot(), (error: unknown) =>
      error instanceof SolanaProviderError && error.kind === 'http' && error.status === status);
    context.mock.timers.tick(100);
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.equal(requestSignal?.aborted, false);
  });
}

for (const reason of [new Error('disconnected'), new SolanaProviderError('network', 'cancelled'), 'cancelled']) {
  for (const alreadyAborted of [true, false]) {
    test(`Solana connection preserves ${typeof reason} cancellation ${alreadyAborted ? 'before' : 'during'} fetch`, async () => {
      const controller = new AbortController();
      let calls = 0;
      const connection = createSolanaConnection({
        ...options(async () => {
          calls += 1;
          return new Promise<Response>(() => undefined);
        }),
        signal: controller.signal,
        mapError: () => assert.fail('cancellation was mapped to a provider error'),
      });
      if (alreadyAborted) controller.abort(reason);
      const rejected = assert.rejects(connection.getSlot(), (error: unknown) =>
        reason instanceof Error
          ? error === reason
          : error instanceof Error && isSignalCancellationError(controller.signal, error));
      if (!alreadyAborted) controller.abort(reason);
      await rejected;
      assert.equal(calls, alreadyAborted ? 0 : 1);
    });
  }
}

test('Solana connection preserves cancellation while reading and cancels the reader', async () => {
  const controller = new AbortController();
  const reason = new Error('disconnected during response');
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  const connection = createSolanaConnection({
    ...options(async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        reading.resolve();
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 }))),
    signal: controller.signal,
  });
  const rejected = assert.rejects(connection.getSlot(), (error) => error === reason);
  await reading.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(cancelled, true);
});

test('Solana connection cancels late responses from fetches that ignore timeout', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pendingResponse = Promise.withResolvers<Response>();
  const connection = createSolanaConnection(options(async () => pendingResponse.promise));
  const rejected = assert.rejects(connection.getSlot(), (error: unknown) =>
    error instanceof SolanaProviderError && error.kind === 'timeout');
  context.mock.timers.tick(20);
  await rejected;
  let cancelled = false;
  pendingResponse.resolve(new Response(new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 })));
  await setImmediate();
  assert.equal(cancelled, true);
});

test('Solana connection cancels a response aborted before its reader starts', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled before response consumption');
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 }));
  Object.defineProperty(response, 'ok', {
    get() {
      controller.abort(reason);
      return true;
    },
  });
  const connection = createSolanaConnection({
    ...options(async () => response),
    signal: controller.signal,
  });
  await assert.rejects(connection.getSlot(), (error) => error === reason);
  assert.equal(cancelled, true);
});

test('Solana connection preserves a provider failure that wins a cancellation race', async () => {
  const controller = new AbortController();
  const providerFailure = new Error('provider failed first');
  const clientReason = new Error('client cancelled later');
  const pendingResponse = Promise.withResolvers<Response>();
  const connection = createSolanaConnection({
    ...options(async () => pendingResponse.promise),
    signal: controller.signal,
  });
  const rejected = assert.rejects(connection.getSlot(), (error: unknown) =>
    error instanceof SolanaProviderError && error.kind === 'network' && error.cause === providerFailure);
  pendingResponse.reject(providerFailure);
  await setImmediate();
  controller.abort(clientReason);
  await rejected;
});

test('Solana connection leaves transaction preflight errors and logs available to web3', async () => {
  const signer = Keypair.generate();
  const transaction = new Transaction({
    recentBlockhash: '11111111111111111111111111111111',
    feePayer: signer.publicKey,
  }).add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: signer.publicKey, lamports: 1 }));
  transaction.sign(signer);
  const connection = createSolanaConnection(options(async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.method, 'sendTransaction');
    return Response.json({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32002,
        message: 'Transaction simulation failed',
        data: { logs: ['Program failed before broadcast'], err: { InstructionError: [0, 'Custom'] } },
      },
    });
  }));
  await assert.rejects(connection.sendRawTransaction(transaction.serialize()), (error: unknown) =>
    error instanceof SendTransactionError && error.logs?.[0] === 'Program failed before broadcast');
});
