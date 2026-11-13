type ScriptRpcTransportOptions = {
  attempts?: number;
  timeoutMs?: number;
  retryDelay?: (attempt: number, retryAfterMs: number) => number;
  retryableStatus?: (status: number) => boolean;
  beforeAttempt?: () => Promise<void>;
  retryTransportErrors?: boolean;
  retryReadErrors?: boolean;
};

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const CONTEXT_RETRY_METHODS = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts', 'getLatestBlockhash',
  'getBlockHeight', 'getEpochInfo', 'isBlockhashValid', 'simulateTransaction',
]);
const READ_RETRY_METHODS = new Set([
  ...CONTEXT_RETRY_METHODS, 'getAsset', 'searchAssets', 'getAssetsByGroup',
]);

export function scriptSolanaRpcHost(endpoint: string): string {
  try { return new URL(endpoint).hostname; } catch { return 'invalid RPC host'; }
}

class ScriptSolanaRpcError extends Error {
  constructor(message: string) { super(message); this.name = 'ScriptSolanaRpcError'; }
}

function redactRpcError(value: unknown, endpoint: URL, depth = 0): unknown {
  if (typeof value === 'string') {
    let safe = value.replace(/https?:\/\/[^\s"'<>]+/gi, url => scriptSolanaRpcHost(url));
    const secrets = [endpoint.username, endpoint.password,
      ...[...endpoint.searchParams].filter(([name]) => /key|token|secret|auth|password/i.test(name)).map(([, secret]) => secret)];
    for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]');
    return safe.slice(0, 2048);
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 8) return '[RPC detail omitted]';
  if (Array.isArray(value)) return value.slice(0, 100).map(entry => redactRpcError(entry, endpoint, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]) =>
    [String(redactRpcError(key, endpoint, depth + 1)), redactRpcError(entry, endpoint, depth + 1)]));
}

async function readRpcBody(response: Response, host: string): Promise<string> {
  if (!response.body) throw new ScriptSolanaRpcError(`Solana RPC returned an empty response from ${host}.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new ScriptSolanaRpcError(`Solana RPC response from ${host} exceeded the response limit.`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export function createScriptSolanaRpcFetch(endpoint: string, options: ScriptRpcTransportOptions = {}): typeof fetch {
  const parsed = new URL(endpoint);
  const host = scriptSolanaRpcHost(endpoint);
  const attempts = options.attempts ?? 4;
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Solana RPC attempts and timeout must be positive integers.');
  }
  const retryableStatus = options.retryableStatus ?? (status => RETRYABLE_STATUSES.has(status));
  const retryDelay = options.retryDelay ?? ((attempt, retryAfterMs) =>
    Math.min(2000, Math.max(500 * 2 ** attempt, retryAfterMs)));
  const pause = (attempt: number, retryAfterMs = 0) => new Promise<void>(resolve =>
    setTimeout(resolve, retryDelay(attempt, retryAfterMs)));
  return async (input, init) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await options.beforeAttempt?.();
      const signal = init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      try {
        const response = await fetch(input, { ...init, redirect: 'error', signal });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (retryableStatus(response.status) && attempt + 1 < attempts) {
            const retryAfter = Number(response.headers.get('retry-after'));
            await pause(attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0);
            continue;
          }
          throw new ScriptSolanaRpcError(`Solana RPC request to ${host} failed with HTTP ${response.status} after ${attempt + 1} attempt(s).`);
        }
        const body = await readRpcBody(response, host);
        let payload: unknown;
        try { payload = JSON.parse(body); } catch { throw new ScriptSolanaRpcError(`Solana RPC returned invalid JSON from ${host}.`); }
        if (payload && typeof payload === 'object' && 'error' in payload &&
          payload.error && typeof payload.error === 'object' && 'code' in payload.error &&
          attempt + 1 < attempts && typeof init?.body === 'string') {
          const method = JSON.parse(init.body).method;
          if ((payload.error.code === -32016 && CONTEXT_RETRY_METHODS.has(method)) ||
            (options.retryReadErrors && READ_RETRY_METHODS.has(method) &&
              (payload.error.code === -32603 || payload.error.code === -32005))) {
            await pause(attempt);
            continue;
          }
        }
        let changed = false;
        const sanitize = (packet: unknown) => {
          if (!packet || typeof packet !== 'object' || Array.isArray(packet) || !('error' in packet)) return packet;
          changed = true;
          return { ...packet, error: redactRpcError(packet.error, parsed) };
        };
        const sanitized = Array.isArray(payload) ? payload.map(sanitize) : sanitize(payload);
        return new Response(changed ? JSON.stringify(sanitized) : body, { status: response.status, headers: { 'content-type': 'application/json' } });
      } catch (error) {
        if (error instanceof ScriptSolanaRpcError) throw error;
        if (options.retryTransportErrors && !init?.signal?.aborted && attempt + 1 < attempts) {
          await pause(attempt);
          continue;
        }
        throw new ScriptSolanaRpcError(`Solana RPC transport ${signal.aborted ? 'timed out or was cancelled' : 'failed'} for ${host}.`);
      }
    }
    throw new ScriptSolanaRpcError(`Solana RPC retry limit reached for ${host}.`);
  };
}
