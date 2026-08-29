import { ProfileReadError } from './dataAccess.js';

export type ProfileProviderFetch = typeof fetch;

export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {}
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason;
  const read = reader.read();
  let rejectAbort!: (reason: unknown) => void;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
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

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw signal.reason;
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  }
  if (!response.body) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await readWithAbort(reader, signal);
      if (signal.aborted) throw signal.reason;
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw signal.reason;
  const contentType = String(response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await cancelResponseBody(response);
    throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  }
  try {
    const value: unknown = JSON.parse(await readBoundedText(response, maxBytes, signal));
    if (signal.aborted) throw signal.reason;
    return value;
  } catch (error) {
    if (signal.aborted && error === signal.reason) throw error;
    if (error instanceof ProfileReadError) throw error;
    throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
  }
}
