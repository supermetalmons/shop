import {
  cancelResponseBody,
  readBoundedJson,
  type ProfileProviderFetch,
} from './boundedResponse.js';
import { isRecord } from './dataAccess.js';

export type SolanaRpcTransportResult =
  | { kind: 'result'; value: unknown }
  | { kind: 'rpc-error'; error: Record<string, unknown> }
  | { kind: 'http-error'; status: number }
  | { kind: 'invalid-response' };

export async function requestSolanaRpc(args: {
  fetch: ProfileProviderFetch;
  id: string;
  maxResponseBytes: number;
  method: string;
  params: unknown;
  signal: AbortSignal;
  url: string;
}): Promise<SolanaRpcTransportResult> {
  const response = await args.fetch(args.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: args.id, method: args.method, params: args.params }),
    redirect: 'manual',
    signal: args.signal,
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    return { kind: 'http-error', status: response.status };
  }
  const payload = await readBoundedJson(response, args.maxResponseBytes, args.signal);
  if (!isRecord(payload) || payload.jsonrpc !== '2.0' || payload.id !== args.id) {
    return { kind: 'invalid-response' };
  }
  if (isRecord(payload.error)) return { kind: 'rpc-error', error: payload.error };
  return Object.hasOwn(payload, 'result')
    ? { kind: 'result', value: payload.result }
    : { kind: 'invalid-response' };
}
