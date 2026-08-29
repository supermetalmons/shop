import { registerDeferredWork, type DeferredWork } from './deferredWork.js';

export type RequestBodyFailure =
  | 'unsupported-media-type'
  | 'too-large'
  | 'invalid-body';

export interface BoundedRequestOptions {
  maxBytes: number;
  signal: AbortSignal;
  createError: (failure: RequestBodyFailure) => Error;
}

export interface RequestDeadline {
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
  timedOut(): boolean;
  clientAborted(): boolean;
  dispose(): void;
}

export interface TimedAbortScope {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

export interface TimedAbortScopeOptions {
  timeoutMs: number;
  timeoutMessage: string;
}

export type RequestDeadlineOptions = TimedAbortScopeOptions;

const CLIENT_ABORT_CONTINUATION_MS = 20_000;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function validateTimeoutMs(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('timeoutMs must be a non-negative finite number');
  }
}

export function isSignalCancellationError(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted && (
    error === signal.reason ||
    (error instanceof Error && error.cause === signal.reason)
  );
}

export function createTimedAbortScope(
  parentSignal: AbortSignal,
  options: TimedAbortScopeOptions,
): TimedAbortScope {
  validateTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal.reason);
  };
  if (parentSignal.aborted) onParentAbort();
  else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new DOMException(options.timeoutMessage, 'TimeoutError'));
  }, options.timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort', onParentAbort);
    },
  };
}

export async function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw signal.reason;
  }
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function raceReadWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.race([operation, Promise.reject(signal.reason)]);
  }
  return raceWithSignal(operation, signal);
}

export async function runCriticalRequestOperation<T>(
  start: () => Promise<T>,
  options: {
    deadline: RequestDeadline;
    defer: DeferredWork;
    ignoreDeferredErrors?: boolean;
    clientAbortContinuationMs?: number;
  },
): Promise<T> {
  const { deadline, defer } = options;
  if (deadline.signal.aborted) throw deadline.signal.reason;
  const operation = start();
  const retain = () => registerDeferredWork(
    defer,
    options.ignoreDeferredErrors
      ? operation.then(() => undefined, () => undefined)
      : operation,
  );
  try {
    return await raceWithSignal(operation, deadline.signal);
  } catch (error) {
    if (deadline.clientAborted() && error === deadline.signal.reason) {
      const continuation = createTimedAbortScope(deadline.timeoutSignal, {
        timeoutMs: Math.min(
          options.clientAbortContinuationMs ?? CLIENT_ABORT_CONTINUATION_MS,
          CLIENT_ABORT_CONTINUATION_MS,
        ),
        timeoutMessage: 'Client-aborted request cleanup timed out',
      });
      try {
        return await raceWithSignal(operation, continuation.signal);
      } catch (continuedError) {
        if (isSignalCancellationError(continuation.signal, continuedError)) {
          retain();
          throw deadline.signal.reason;
        }
        throw continuedError;
      } finally {
        continuation.dispose();
      }
    }
    if (deadline.timedOut() && error === deadline.signal.reason) {
      retain();
    }
    throw error;
  }
}

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
}

class RequestBodyStreamError extends Error {
  constructor(cause: unknown) {
    super('Request body stream failed');
    this.name = 'RequestBodyStreamError';
    Object.defineProperty(this, 'cause', { value: cause });
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | null, reason?: unknown): void {
  try {
    void body?.cancel(reason).catch(() => undefined);
  } catch {}
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {}
}

export function isRequestCancellationError(request: Request, error: unknown): boolean {
  return isSignalCancellationError(request.signal, error)
    || error instanceof RequestBodyStreamError
    || (error instanceof Error && error.cause instanceof RequestBodyStreamError);
}

function requestContentLength(request: Request): number | undefined {
  const value = request.headers.get('Content-Length');
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const length = Number(value);
  return Number.isFinite(length) ? length : undefined;
}

function isJsonContentType(request: Request): boolean {
  const mediaType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

export async function readBoundedRequestBytes(
  request: Request,
  options: BoundedRequestOptions,
): Promise<Uint8Array> {
  validateMaxBytes(options.maxBytes);
  throwIfAborted(options.signal);

  const body = request.body;
  if (!body) throw options.createError('invalid-body');

  const contentLength = requestContentLength(request);
  if (contentLength !== undefined && contentLength > options.maxBytes) {
    cancelBody(body);
    throwIfAborted(options.signal);
    throw options.createError('too-large');
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    throwIfAborted(options.signal);
    throw options.createError('invalid-body');
  }
  let bytes = new Uint8Array(Math.min(options.maxBytes, contentLength ?? 8192));
  let size = 0;
  const onAbort = () => {
    cancelReader(reader, options.signal.reason);
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) onAbort();

  try {
    while (true) {
      throwIfAborted(options.signal);
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        throwIfAborted(options.signal);
        throw new RequestBodyStreamError(error);
      }
      throwIfAborted(options.signal);
      if (result.done) break;

      if (result.value.byteLength > options.maxBytes - size) {
        cancelReader(reader);
        throwIfAborted(options.signal);
        throw options.createError('too-large');
      }
      const nextSize = size + result.value.byteLength;
      if (nextSize > bytes.byteLength) {
        const capacity = Math.min(
          options.maxBytes,
          Math.max(nextSize, bytes.byteLength * 2, 1),
        );
        const expanded = new Uint8Array(capacity);
        expanded.set(bytes.subarray(0, size));
        bytes = expanded;
      }
      bytes.set(result.value, size);
      size = nextSize;
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort);
  }

  return size === bytes.byteLength ? bytes : bytes.slice(0, size);
}

export async function readBoundedRequestText(
  request: Request,
  options: BoundedRequestOptions,
): Promise<string> {
  const bytes = await readBoundedRequestBytes(request, options);
  throwIfAborted(options.signal);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throwIfAborted(options.signal);
    throw options.createError('invalid-body');
  }
}

export async function readBoundedRequestJson(
  request: Request,
  options: BoundedRequestOptions,
): Promise<unknown> {
  validateMaxBytes(options.maxBytes);
  throwIfAborted(options.signal);
  if (!isJsonContentType(request)) {
    cancelBody(request.body);
    throwIfAborted(options.signal);
    throw options.createError('unsupported-media-type');
  }

  const text = await readBoundedRequestText(request, options);
  throwIfAborted(options.signal);
  try {
    return JSON.parse(text);
  } catch {
    throwIfAborted(options.signal);
    throw options.createError('invalid-body');
  }
}

export function createRequestDeadline(
  request: Request,
  options: RequestDeadlineOptions,
): RequestDeadline {
  validateTimeoutMs(options.timeoutMs);

  const timeoutController = new AbortController();
  const timeoutError = new DOMException(options.timeoutMessage, 'TimeoutError');
  const signal = AbortSignal.any([request.signal, timeoutController.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimer();
  };

  timer = setTimeout(() => {
    timer = undefined;
    timeoutController.abort(timeoutError);
  }, options.timeoutMs);

  return {
    signal,
    timeoutSignal: timeoutController.signal,
    timedOut: () => timeoutController.signal.aborted
      && signal.reason === timeoutController.signal.reason,
    clientAborted: () => request.signal.aborted
      && signal.reason === request.signal.reason,
    dispose,
  };
}
