export type ProfileProviderFetch = typeof fetch;

export type ResponseBodyFailure =
  | 'missing-body'
  | 'too-large'
  | 'unexpected-content-type'
  | 'invalid-encoding'
  | 'invalid-json'
  | 'stream-failed';

export type BoundedResponseOptions = Readonly<{
  maxBytes: number;
  signal: AbortSignal;
  createError: (failure: ResponseBodyFailure, cause?: unknown) => Error;
  onBytes?: (bytes: number) => void;
  onChunk?: (chunk: Uint8Array) => void;
}>;

export type BoundedJsonResponseOptions = BoundedResponseOptions & Readonly<{
  contentType: 'require-json' | 'ignore';
}>;

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function responseContentLength(response: Response): number | undefined {
  const value = response.headers.get('Content-Length');
  if (value === null) return undefined;
  const length = Number(value);
  return Number.isFinite(length) && length >= 0 ? length : undefined;
}

function isJsonContentType(response: Response): boolean {
  return response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {}
}

export async function cancelResponseBody(response: Response, reason?: unknown): Promise<void> {
  try {
    void response.body?.cancel(reason).catch(() => undefined);
  } catch {}
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  throwIfAborted(signal);
  const read = reader.read();
  let rejectAbort!: (reason: unknown) => void;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    cancelReader(reader, signal.reason);
    rejectAbort(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([read, abort]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function readBoundedResponseBytes(
  response: Response,
  options: BoundedResponseOptions,
): Promise<Uint8Array> {
  validateMaxBytes(options.maxBytes);
  throwIfAborted(options.signal);
  const contentLength = responseContentLength(response);
  if (contentLength !== undefined && contentLength > options.maxBytes) {
    await cancelResponseBody(response);
    throwIfAborted(options.signal);
    throw options.createError('too-large');
  }
  if (!response.body) throw options.createError('missing-body');

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (error) {
    throwIfAborted(options.signal);
    throw options.createError('stream-failed', error);
  }

  let bytes = new Uint8Array(Math.min(options.maxBytes, contentLength ?? 8192, 8192));
  let size = 0;
  try {
    while (true) {
      throwIfAborted(options.signal);
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await readWithAbort(reader, options.signal);
      } catch (error) {
        if (options.signal.aborted && error === options.signal.reason) throw error;
        throw options.createError('stream-failed', error);
      }
      throwIfAborted(options.signal);
      if (result.done) break;
      options.onBytes?.(result.value.byteLength);
      if (result.value.byteLength > options.maxBytes - size) {
        cancelReader(reader);
        throw options.createError('too-large');
      }
      options.onChunk?.(result.value);
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
  } catch (error) {
    cancelReader(reader);
    throw error;
  }
  return size === bytes.byteLength ? bytes : bytes.slice(0, size);
}

export async function readBoundedResponseText(
  response: Response,
  options: BoundedResponseOptions,
): Promise<string> {
  const validator = new TextDecoder('utf-8', { fatal: true });
  const bytes = await readBoundedResponseBytes(response, {
    ...options,
    onChunk: (chunk) => {
      options.onChunk?.(chunk);
      try {
        validator.decode(chunk, { stream: true });
      } catch (error) {
        throw options.createError('invalid-encoding', error);
      }
    },
  });
  throwIfAborted(options.signal);
  try {
    validator.decode();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throwIfAborted(options.signal);
    throw options.createError('invalid-encoding', error);
  }
}

export async function readBoundedResponseJson(
  response: Response,
  options: BoundedJsonResponseOptions,
): Promise<unknown> {
  validateMaxBytes(options.maxBytes);
  throwIfAborted(options.signal);
  if (options.contentType === 'require-json' && !isJsonContentType(response)) {
    await cancelResponseBody(response);
    throwIfAborted(options.signal);
    throw options.createError('unexpected-content-type');
  }
  const text = await readBoundedResponseText(response, options);
  throwIfAborted(options.signal);
  try {
    return JSON.parse(text);
  } catch (error) {
    throwIfAborted(options.signal);
    throw options.createError('invalid-json', error);
  }
}
