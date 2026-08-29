import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRequestDeadline,
  createTimedAbortScope,
  isRequestCancellationError,
  raceReadWithSignal,
  readBoundedRequestBytes,
  readBoundedRequestJson,
  readBoundedRequestText,
  runCriticalRequestOperation,
  type BoundedRequestOptions,
  type RequestBodyFailure,
} from '../src/boundedRequest.ts';

class BoundaryError extends Error {
  constructor(readonly failure: RequestBodyFailure) {
    super(failure);
  }
}

function options(maxBytes: number, signal = new AbortController().signal): BoundedRequestOptions {
  return {
    maxBytes,
    signal,
    createError: (failure) => new BoundaryError(failure),
  };
}

function postRequest(
  body?: BodyInit | null,
  headers?: HeadersInit,
  signal?: AbortSignal,
): Request {
  return new Request('https://api.mons.shop/test', {
    method: 'POST',
    body,
    headers,
    signal,
  });
}

function streamRequest(
  stream: ReadableStream<Uint8Array>,
  headers?: HeadersInit,
  signal?: AbortSignal,
): Request {
  return new Request('https://api.mons.shop/test', {
    method: 'POST',
    body: stream,
    headers,
    signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

test('JSON accepts a case-insensitive media type with parameters', async () => {
  const request = postRequest('{"ok":true}', {
    'Content-Type': 'Application/JSON; Charset=UTF-8',
  });
  assert.deepEqual(await readBoundedRequestJson(request, options(11)), { ok: true });
});

test('JSON rejects unsupported media types and cancels the body', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{}'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = streamRequest(stream, { 'Content-Type': 'text/json' });
  await assert.rejects(
    readBoundedRequestJson(request, options(10)),
    (error) => error instanceof BoundaryError && error.failure === 'unsupported-media-type',
  );
  assert.equal(cancelled, true);
});

test('byte reader accepts the exact limit and preserves original bytes', async () => {
  const chunks = [Uint8Array.of(0, 1), Uint8Array.of(254, 255)];
  let index = 0;
  const request = streamRequest(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  }));
  assert.deepEqual(
    await readBoundedRequestBytes(request, options(4)),
    Uint8Array.of(0, 1, 254, 255),
  );
});

test('byte reader rejects a multi-chunk overflow and cancels the body', async () => {
  const chunks = [new TextEncoder().encode('ab'), new TextEncoder().encode('cde')];
  let index = 0;
  let cancelled = false;
  const request = streamRequest(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  }));
  await assert.rejects(
    readBoundedRequestBytes(request, options(4)),
    (error) => error instanceof BoundaryError && error.failure === 'too-large',
  );
  assert.equal(cancelled, true);
});

test('byte reader copies tiny and empty chunks without retaining chunk metadata', async () => {
  let remainingEmptyChunks = 20_000;
  let remainingBytes = 4096;
  const request = streamRequest(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remainingEmptyChunks > 0) {
        remainingEmptyChunks -= 1;
        controller.enqueue(new Uint8Array());
        return;
      }
      if (remainingBytes > 0) {
        remainingBytes -= 1;
        controller.enqueue(Uint8Array.of(7));
        return;
      }
      controller.close();
    },
  }));
  const bytes = await readBoundedRequestBytes(request, options(4096));
  assert.equal(bytes.byteLength, 4096);
  assert.equal(bytes.every((value) => value === 7), true);
});

test('reader cancellation is best-effort and never blocks rejection', async () => {
  let bodyCancelStarted = false;
  const unsupported = streamRequest(new ReadableStream<Uint8Array>({
    cancel() {
      bodyCancelStarted = true;
      return new Promise<void>(() => undefined);
    },
  }), { 'Content-Type': 'text/plain' });
  await assert.rejects(
    readBoundedRequestJson(unsupported, options(10)),
    (error) => error instanceof BoundaryError && error.failure === 'unsupported-media-type',
  );
  assert.equal(bodyCancelStarted, true);

  let readerCancelStarted = false;
  const overflow = streamRequest(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('overflow'));
    },
    cancel() {
      readerCancelStarted = true;
      return new Promise<void>(() => undefined);
    },
  }));
  await assert.rejects(
    readBoundedRequestBytes(overflow, options(2)),
    (error) => error instanceof BoundaryError && error.failure === 'too-large',
  );
  assert.equal(readerCancelStarted, true);
});

test('locked bodies are normalized as invalid-body', async () => {
  const request = postRequest('{}');
  const lock = request.body?.getReader();
  await assert.rejects(
    readBoundedRequestBytes(request, options(10)),
    (error) => error instanceof BoundaryError && error.failure === 'invalid-body',
  );
  lock?.releaseLock();
});

test('request stream failures use a stable internal cancellation type', async () => {
  for (const message of ['transport failed', 'runtime wording changed']) {
    const request = streamRequest(new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(message);
      },
    }));
    const failure = await readBoundedRequestBytes(request, options(10)).catch((error) => error);
    assert.equal(isRequestCancellationError(request, failure), true);
  }
});

test('text limits count UTF-8 bytes and preserve decoded text', async () => {
  assert.equal(await readBoundedRequestText(postRequest('€'), options(3)), '€');
  await assert.rejects(
    readBoundedRequestText(postRequest('€'), options(2)),
    (error) => error instanceof BoundaryError && error.failure === 'too-large',
  );
});

test('text and JSON readers reject invalid input as invalid-body', async () => {
  await assert.rejects(
    readBoundedRequestText(postRequest(Uint8Array.of(0xc3, 0x28)), options(2)),
    (error) => error instanceof BoundaryError && error.failure === 'invalid-body',
  );
  await assert.rejects(
    readBoundedRequestJson(
      postRequest('{"ok":', { 'Content-Type': 'application/json' }),
      options(20),
    ),
    (error) => error instanceof BoundaryError && error.failure === 'invalid-body',
  );
});

test('readers reject a missing body as invalid-body', async () => {
  for (const read of [readBoundedRequestBytes, readBoundedRequestText]) {
    await assert.rejects(
      read(postRequest(), options(10)),
      (error) => error instanceof BoundaryError && error.failure === 'invalid-body',
    );
  }
  await assert.rejects(
    readBoundedRequestJson(
      postRequest(undefined, { 'Content-Type': 'application/json' }),
      options(10),
    ),
    (error) => error instanceof BoundaryError && error.failure === 'invalid-body',
  );
});

test('body abort cancels the stream and preserves the exact abort reason', async () => {
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  let cancelReason: unknown;
  const request = streamRequest(new ReadableStream<Uint8Array>({
    start() {},
    cancel(value) {
      cancelReason = value;
    },
  }));
  const reading = readBoundedRequestBytes(request, options(10, controller.signal));
  controller.abort(reason);
  await assert.rejects(reading, (error) => error === reason);
  assert.equal(cancelReason, reason);
});

test('request deadline reports a custom timeout and disposes its timer', async () => {
  const deadline = createRequestDeadline(new Request('https://api.mons.shop/test'), {
    timeoutMs: 5,
    timeoutMessage: 'Request boundary timed out',
  });
  await waitForAbort(deadline.signal);
  assert.equal(deadline.signal.reason instanceof DOMException, true);
  assert.equal(deadline.signal.reason.name, 'TimeoutError');
  assert.equal(deadline.signal.reason.message, 'Request boundary timed out');
  assert.equal(deadline.timedOut(), true);
  assert.equal(deadline.clientAborted(), false);
  deadline.dispose();
  deadline.dispose();

  const disposed = createRequestDeadline(new Request('https://api.mons.shop/test'), {
    timeoutMs: 5,
    timeoutMessage: 'must not fire',
  });
  disposed.dispose();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(disposed.signal.aborted, false);
  assert.equal(disposed.timedOut(), false);
});

test('request deadline reports client aborts and keeps the first reason', async () => {
  const client = new AbortController();
  const request = new Request('https://api.mons.shop/test', { signal: client.signal });
  const deadline = createRequestDeadline(request, {
    timeoutMs: 20,
    timeoutMessage: 'late timeout',
  });
  const reason = new Error('client disconnected');
  client.abort(reason);
  await waitForAbort(deadline.signal);
  assert.equal(deadline.signal.reason, reason);
  assert.equal(deadline.clientAborted(), true);
  assert.equal(deadline.timedOut(), false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(deadline.signal.reason, reason);
  assert.equal(deadline.timeoutSignal.aborted, true);
  deadline.dispose();

  const laterClient = new AbortController();
  const timed = createRequestDeadline(
    new Request('https://api.mons.shop/test', { signal: laterClient.signal }),
    { timeoutMs: 0, timeoutMessage: 'first timeout' },
  );
  await waitForAbort(timed.signal);
  const timeoutReason = timed.signal.reason;
  laterClient.abort(new Error('late disconnect'));
  assert.equal(timed.signal.reason, timeoutReason);
  assert.equal(timed.timedOut(), true);
  assert.equal(timed.clientAborted(), false);
  timed.dispose();
});

test('timed abort scopes distinguish parent cancellation from their timeout', async () => {
  const parent = new AbortController();
  const parentScope = createTimedAbortScope(parent.signal, {
    timeoutMs: 20,
    timeoutMessage: 'late timeout',
  });
  const reason = new Error('parent cancelled');
  parent.abort(reason);
  await waitForAbort(parentScope.signal);
  assert.equal(parentScope.signal.reason, reason);
  assert.equal(parentScope.timedOut(), false);
  parentScope.dispose();

  const timedScope = createTimedAbortScope(new AbortController().signal, {
    timeoutMs: 5,
    timeoutMessage: 'attempt timed out',
  });
  await waitForAbort(timedScope.signal);
  assert.equal(timedScope.timedOut(), true);
  assert.equal(timedScope.signal.reason.name, 'TimeoutError');
  timedScope.dispose();
});

test('critical operations cap client-abort continuation before the server deadline', async () => {
  const client = new AbortController();
  const reason = new Error('client disconnected');
  const deadline = createRequestDeadline(
    new Request('https://api.mons.shop/test', { signal: client.signal }),
    { timeoutMs: 1_000, timeoutMessage: 'critical operation timed out' },
  );
  let release!: () => void;
  const operation = new Promise<void>((resolve) => { release = resolve; });
  const deferred: Promise<unknown>[] = [];
  const pending = runCriticalRequestOperation(
    () => operation,
    {
      deadline,
      defer: (promise) => deferred.push(promise),
      clientAbortContinuationMs: 5,
    },
  );

  client.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(deadline.timeoutSignal.aborted, false);
  assert.equal(deferred.length, 1);
  release();
  await Promise.all(deferred);
  deadline.dispose();
});

test('critical operations do not start after an already-settled request boundary', async () => {
  const client = new AbortController();
  const reason = new Error('already cancelled');
  client.abort(reason);
  const deadline = createRequestDeadline(
    new Request('https://api.mons.shop/test', { signal: client.signal }),
    { timeoutMs: 20, timeoutMessage: 'must not start' },
  );
  let started = false;

  await assert.rejects(
    runCriticalRequestOperation(
      async () => { started = true; },
      { deadline, defer: () => undefined },
    ),
    (error) => error === reason,
  );
  assert.equal(started, false);
  deadline.dispose();
});

test('an already-settled read wins an already-aborted signal', async () => {
  const operationError = new Error('operation settled first');
  const operation = Promise.reject(operationError);
  const controller = new AbortController();
  controller.abort(new Error('late abort'));

  await assert.rejects(
    raceReadWithSignal(operation, controller.signal),
    (error) => error === operationError,
  );
});

test('an abort beats a read that resolves in a later microtask', async () => {
  const controller = new AbortController();
  const reason = new Error('deadline won');
  let resolveRead!: (value: string) => void;
  const read = new Promise<string>((resolve) => { resolveRead = resolve; });
  controller.abort(reason);
  const raced = raceReadWithSignal(read, controller.signal);
  queueMicrotask(() => resolveRead('late success'));

  await assert.rejects(raced, (error) => error === reason);
});
