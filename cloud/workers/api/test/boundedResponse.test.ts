import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readBoundedResponseBytes,
  readBoundedResponseJson,
  readBoundedResponseText,
  type ResponseBodyFailure,
} from '../src/boundedResponse.ts';

class BodyFailure extends Error {
  constructor(readonly failure: ResponseBodyFailure, cause?: unknown) {
    super(failure);
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
  }
}

function options(maxBytes: number, signal = new AbortController().signal) {
  return {
    maxBytes,
    signal,
    createError: (failure: ResponseBodyFailure, cause?: unknown) => new BodyFailure(failure, cause),
  };
}

test('bounded response readers accept exact limits and report consumed bytes', async () => {
  const consumed: number[] = [];
  const bytes = await readBoundedResponseBytes(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  })), { ...options(3), onBytes: (size) => consumed.push(size) });
  assert.deepEqual(Array.from(bytes), [1, 2, 3]);
  assert.deepEqual(consumed, [2, 1]);
});

test('bounded response readers reject declared and streamed overflow without waiting for cancellation', async () => {
  let declaredCancelled = false;
  const declared = new Response(new ReadableStream<Uint8Array>({
    cancel() {
      declaredCancelled = true;
      return new Promise<void>(() => undefined);
    },
  }), { headers: { 'Content-Length': '4' } });
  await assert.rejects(readBoundedResponseBytes(declared, options(3)), (error: unknown) =>
    error instanceof BodyFailure && error.failure === 'too-large');
  assert.equal(declaredCancelled, true);

  const streamed = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
    },
  }));
  await assert.rejects(readBoundedResponseBytes(streamed, options(3)), (error: unknown) =>
    error instanceof BodyFailure && error.failure === 'too-large');
});

test('bounded JSON response policies preserve content type and parsing failures', async () => {
  const withoutType = new Response('{"ok":true}');
  await assert.rejects(readBoundedResponseJson(withoutType, {
    ...options(32),
    contentType: 'require-json',
  }), (error: unknown) => error instanceof BodyFailure && error.failure === 'unexpected-content-type');
  assert.deepEqual(await readBoundedResponseJson(new Response('{"ok":true}'), {
    ...options(32),
    contentType: 'ignore',
  }), { ok: true });
  await assert.rejects(readBoundedResponseJson(Response.json({ ok: true }), {
    ...options(2),
    contentType: 'require-json',
  }), (error: unknown) => error instanceof BodyFailure && error.failure === 'too-large');
  await assert.rejects(readBoundedResponseJson(new Response('{', {
    headers: { 'Content-Type': 'application/json' },
  }), {
    ...options(8),
    contentType: 'require-json',
  }), (error: unknown) => error instanceof BodyFailure && error.failure === 'invalid-json');
});

test('bounded text responses reject invalid UTF-8 and preserve exact abort reasons', async () => {
  await assert.rejects(readBoundedResponseText(new Response(new Uint8Array([0xff])), options(1)),
    (error: unknown) => error instanceof BodyFailure && error.failure === 'invalid-encoding');

  const controller = new AbortController();
  const reason = new Error('disconnect');
  const pending = readBoundedResponseText(new Response(new ReadableStream<Uint8Array>({ start() {} })),
    options(8, controller.signal));
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});

test('bounded text rejects an invalid prefix without waiting for the stream to close', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff]));
    },
    cancel() {
      cancelled = true;
    },
  }));
  await assert.rejects(readBoundedResponseText(response, options(16)),
    (error: unknown) => error instanceof BodyFailure && error.failure === 'invalid-encoding');
  assert.equal(cancelled, true);
});
