import { ETHEREUM_SESSION_HEADER, type EthereumSession } from '../../shared/ethereum/api';
import { monsApiOrigin } from '../lib/monsApiOrigin';

export type EthereumRequestOptions = { body?: unknown; session?: EthereumSession | null; signal?: AbortSignal; preserveTraitNumbers?: boolean };

export class EthereumNetworkError extends Error {
  constructor(cause: TypeError) { super(cause.message, { cause }); this.name = 'EthereumNetworkError'; }
}

function parseItemJson(text: string): unknown {
  // A "value" key may itself contain a Unicode escape.
  if (!/"value"\s*:\s*-?\d|\\u/.test(text)) return JSON.parse(text);
  let depth = 0;
  let attributesDepth = -1;
  let key = '';
  let copiedUntil = 0;
  const slices: string[] = [];
  const tokens = /"(?:[^"\\]|\\.)*"(\s*:)?|[{}\[\]]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  for (let match; (match = tokens.exec(text)) !== null;) {
    const [token, colon] = match;
    if (colon) {
      const name = token.slice(0, -colon.length);
      key = name.includes('\\') ? JSON.parse(name) : name.slice(1, -1);
      continue;
    }
    const property = key;
    key = '';
    if (token === '{' || token === '[') {
      depth++;
      if (token === '[' && property === 'attributes' && attributesDepth === -1) attributesDepth = depth;
    } else if (token === '}' || token === ']') {
      if (depth === attributesDepth) attributesDepth = -1;
      depth--;
    } else if (property === 'value' && attributesDepth >= 0 && depth === attributesDepth + 1 &&
      token[0] !== '"' && String(Number(token)) !== token) {
      slices.push(text.slice(copiedUntil, match.index), `"${token}"`);
      copiedUntil = tokens.lastIndex;
    }
  }
  if (!slices.length) return JSON.parse(text);
  slices.push(text.slice(copiedUntil));
  return JSON.parse(slices.join(''));
}

export async function requestEthereumJson(path: string, options: EthereumRequestOptions): Promise<{ response: Response; value: unknown }> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  let response: Response;
  try { response = await fetch(`${monsApiOrigin()}${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json', 'X-Mons-CSRF': '1' } : {}),
      ...(options.session ? { [ETHEREUM_SESSION_HEADER]: options.session.token } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    cache: 'no-store', signal,
  }); } catch (error) {
    signal.throwIfAborted();
    throw error instanceof TypeError ? new EthereumNetworkError(error) : error;
  }
  let value: unknown;
  try { value = options.preserveTraitNumbers && response.ok ? parseItemJson(await response.text()) : await response.json(); }
  catch (error) {
    signal.throwIfAborted();
    if (response.ok) throw error instanceof TypeError ? new EthereumNetworkError(error) : error;
    value = null;
  }
  return { response, value };
}
