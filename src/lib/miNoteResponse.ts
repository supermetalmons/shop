export async function readMiNoteResponse(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  const invalid = () => new Error('Invalid Mi Note API response.');
  if (!response.body || Number(response.headers.get('Content-Length')) > maxBytes ||
    response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    void response.body?.cancel().catch(() => undefined);
    throw invalid();
  }
  const reader = response.body.getReader();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { rejectAbort(signal.reason); void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw invalid();
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(''));
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
