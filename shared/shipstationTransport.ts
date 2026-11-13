import { shipStationErrorDetails, type ShipStationErrorDiagnostics } from './shipstationErrors.ts';

const SHIPSTATION_API_BASE = 'https://api.shipstation.com/v2';
const SHIPSTATION_TIMEOUT_MS = 15_000;

export type ShipStationProviderErrorCode =
  | 'failed-precondition'
  | 'resource-exhausted'
  | 'unavailable'
  | 'deadline-exceeded'
  | 'internal';

export type ShipStationClientOptions = Readonly<{
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export function createShipStationTransport<E extends Error>(
  ProviderError: new (code: ShipStationProviderErrorCode, message: string, diagnostics?: ShipStationErrorDiagnostics) => E,
  maxResponseBytes: number,
) {
  async function readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
    const contentLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError('unavailable', 'ShipStation returned an oversized response');
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      while (true) {
        if (signal.aborted) throw signal.reason;
        const chunk = await reader.read();
        if (signal.aborted) throw signal.reason;
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ProviderError('unavailable', 'ShipStation returned an oversized response');
        }
        chunks.push(chunk.value);
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }

  async function request(
    apiKey: string,
    path: string,
    init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown },
    options: ShipStationClientOptions,
  ): Promise<{ status: number; json: unknown; validJson: boolean }> {
    const providerFetch = options.fetch ?? fetch;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DOMException('ShipStation request timed out', 'TimeoutError')),
      options.timeoutMs ?? SHIPSTATION_TIMEOUT_MS,
    );
    try {
      const response = await providerFetch(`${SHIPSTATION_API_BASE}${path}`, {
        method: init.method,
        headers: {
          'API-Key': apiKey,
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: 'manual',
        signal: controller.signal,
      });
      const text = await readBoundedText(response, options.maxResponseBytes ?? maxResponseBytes, controller.signal);
      let json: unknown = null;
      let validJson = false;
      if (text) {
        try {
          json = JSON.parse(text);
          validJson = true;
        } catch {
          json = null;
        }
      }
      return { status: response.status, json, validJson };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (options.signal?.aborted && error === options.signal.reason) throw error;
      throw new ProviderError(
        controller.signal.aborted ? 'deadline-exceeded' : 'unavailable',
        controller.signal.aborted ? 'ShipStation request timed out' : 'Could not reach ShipStation',
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  function errorForStatus(status: number, value: unknown, operation: string): E {
    const details = shipStationErrorDetails(value, 'ShipStation returned an unrecognized error.', status);
    const { message } = details;
    const diagnostics = { ...details.diagnostics, operation };
    if (status === 401 || status === 403) {
      return new ProviderError('failed-precondition', `ShipStation rejected the API key during ${operation}: ${message}`, diagnostics);
    }
    if (status === 429) return new ProviderError('resource-exhausted', `ShipStation rate limit during ${operation}: ${message}`, diagnostics);
    if (status >= 500) return new ProviderError('unavailable', `ShipStation is unavailable during ${operation}: ${message}`, diagnostics);
    return new ProviderError('failed-precondition', `ShipStation rejected the ${operation}: ${message}`, diagnostics);
  }

  return { request, errorForStatus };
}
